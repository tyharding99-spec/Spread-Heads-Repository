import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  FlatList,
  Image,
  ActivityIndicator,
  SafeAreaView,
  Platform,
  StatusBar,
  ScrollView,
  BackHandler,
  Switch,
  RefreshControl,
  Animated,
  Share,
  Dimensions,
} from "react-native";
import { loadLeagues, saveLeagues, loadResults, mergeResults } from "./storage";
import { getLeaguesForUser, getLeagueByCode, addUserToLeague, updateLeagueLockedLines } from './supabaseLeague';
import { normalizeLeagueSettings } from './leagueSettingsUtil';
import { savePick, getPicksForLeague } from './supabasePicks';
// Removed direct client upsert for game_results; edge function handles finals
import { fetchUserWeeklyStats, recomputeWeeklyPoints, fetchWeeklyPoints, fetchGameResults, computeWeeklyPointsClientSide } from './supabaseResults';
import { computeUserStats } from './stats';
import { registerForPushNotificationsAsync, scheduleLocalNotification, scheduleWeeklyResultsReminderIfNeeded, scheduleLineLockNotificationIfNeeded, scheduleWeeklyGameReminders, notifyFriendRequest, notifyFriendRequestAccepted, notifyLeagueInvite, notifyAchievement, notifyWeekStart, notifyLeagueSettingsChanged, notifyMemberAdded, notifyMemberRemoved } from './notifications';
import { login, signUp, getCurrentUser, logout } from "./auth";
import { CreateLeagueScreen } from "./CreateLeagueScreen";
import { MasterPicksScreen } from "./MasterPicksScreen";
import { WeeklyResultsScreen } from "./WeeklyResultsScreen";
import { LeaderboardScreen } from "./LeaderboardScreen";
import { TrendsScreen } from "./TrendsScreen";
import { AchievementsScreen } from "./AchievementsScreen";
import { UserProfileScreen } from "./UserProfileScreen";
import { FriendsScreen } from "./FriendsScreen";
import { queueOfflinePick, processOfflineQueue, setupAutoQueueProcessing, getQueueSize, isOnline } from './offlineQueue';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { signUp as supabaseSignUp, signIn as supabaseSignIn, signOut as supabaseSignOut, getCurrentUser as supabaseGetCurrentUser, updateUserMetadata as supabaseUpdateUserMetadata, updateUserEmail as supabaseUpdateUserEmail, resendVerificationEmail } from './supabaseAuth';
import { LEGAL_VERSION, TERMS_TEXT, PRIVACY_TEXT } from './legal';
import OnboardingScreen from './OnboardingScreen';
import { getNotificationPrefs, setNotificationPrefs } from './notificationPrefs';
import { getAutoPickPrefs, setAutoPickPrefs, AUTO_PICK_STRATEGIES, getStrategyDisplayName, getStrategyDescription } from './autoPickPrefs';
import { processAutoPicks, shouldProcessAutoPicks } from './autoPick';
import { getHallOfFame, calculateHallOfFame, getRecordDisplayName } from './hallOfFame';
import { createUserProfile, getUserProfile, updateUserProfile, getProfilesByIds, savePushToken, isUsernameAvailable } from './supabaseProfile';
import { lightTheme, darkTheme } from './theme';
import * as Linking from 'expo-linking';
import QRCode from 'react-native-qrcode-svg';
import { createInvite, listPendingInvitesForUser, acceptInvite, declineInvite } from './supabaseInvites';
import { subscribeToLeaguePicks, subscribeToLeagueSettings, subscribeToLeagueMembers, subscribeToFriendRequests, subscribeToFinalResults, unsubscribeAll } from './supabaseRealtime';

/* ---------- Rate Limiting Utility ---------- */

class RateLimiter {
  constructor(maxCalls, timeWindowMs) {
    this.maxCalls = maxCalls;
    this.timeWindowMs = timeWindowMs;
    this.calls = [];
  }

  canMakeRequest() {
    const now = Date.now();
    // Remove calls outside the time window
    this.calls = this.calls.filter(timestamp => now - timestamp < this.timeWindowMs);
    
    if (this.calls.length >= this.maxCalls) {
      return false;
    }
    
    this.calls.push(now);
    return true;
  }

  getWaitTime() {
    if (this.calls.length < this.maxCalls) return 0;
    const now = Date.now();
    const oldestCall = this.calls[0];
    return Math.max(0, this.timeWindowMs - (now - oldestCall));
  }
}

// ESPN API rate limiter: 10 calls per minute
const espnRateLimiter = new RateLimiter(10, 60000);

/* ---------- Global Locked Lines Sweep ---------- */

/**
 * Automatically snapshot locked lines for all leagues at app start.
 * For any game where the lock time has passed but locked_lines entry is missing,
 * fetches current week's games and saves the locked lines.
 * This ensures locked numbers are always available, even if no screen was visited at lock time.
 */
const globalLockedLinesSweep = async (leagues) => {
  if (!Array.isArray(leagues) || leagues.length === 0) return;

  try {
    // Calculate current NFL week
    const now = new Date();
    const seasonStart2025 = new Date('2025-09-02T00:00:00');
    const diffTime = now - seasonStart2025;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    const currentWeek = Math.max(1, Math.min(18, Math.floor(diffDays / 7) + 1));

    // Rate limit check
    if (!espnRateLimiter.canMakeRequest()) {
      console.log('[LockedLinesSweep] Rate limited, skipping sweep');
      return;
    }

    // Fetch current week's games
    const espnRes = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${currentWeek}`,
      { 
        timeout: 10000,
        headers: { 'Accept': 'application/json' }
      }
    );

    if (!espnRes.ok) {
      console.warn('[LockedLinesSweep] Failed to fetch games:', espnRes.status);
      return;
    }

    const espnData = await espnRes.json();
    if (!espnData?.events || espnData.events.length === 0) {
      console.log('[LockedLinesSweep] No games found for week', currentWeek);
      return;
    }

    // Parse games to get IDs, teams, spreads, and start times
    const games = espnData.events.map(event => {
      const comp = event.competitions[0];
      const away = comp.competitors.find(c => c.homeAway === "away") || comp.competitors[0];
      const home = comp.competitors.find(c => c.homeAway === "home") || comp.competitors[1];
      
      const odds = comp.odds?.[0];
      let homeSpreadNum = null;
      let awaySpreadNum = null;
      let overUnderNum = null;

      if (odds) {
        if (odds.awayTeamOdds?.spreadLine !== undefined) {
          awaySpreadNum = parseFloat(odds.awayTeamOdds.spreadLine);
          homeSpreadNum = -awaySpreadNum;
        } else if (odds.homeTeamOdds?.spreadLine !== undefined) {
          homeSpreadNum = parseFloat(odds.homeTeamOdds.spreadLine);
          awaySpreadNum = -homeSpreadNum;
        } else if (odds.spread !== undefined) {
          homeSpreadNum = parseFloat(odds.spread);
          awaySpreadNum = -homeSpreadNum;
        }
        
        if (odds.overUnder !== undefined) {
          overUnderNum = parseFloat(odds.overUnder);
        } else if (odds.total !== undefined) {
          overUnderNum = parseFloat(odds.total);
        }
      }

      return {
        id: event.id,
        homeAbbr: home.team.abbreviation,
        awayAbbr: away.team.abbreviation,
        homeTeam: home.team.displayName,
        awayTeam: away.team.displayName,
        startISO: event.date,
        homeSpread: homeSpreadNum !== null ? (homeSpreadNum > 0 ? `+${homeSpreadNum}` : `${homeSpreadNum}`) : null,
        awaySpread: awaySpreadNum !== null ? (awaySpreadNum > 0 ? `+${awaySpreadNum}` : `${awaySpreadNum}`) : null,
        homeSpreadNum,
        awaySpreadNum,
        overUnder: overUnderNum,
      };
    });

    console.log(`[LockedLinesSweep] Checking ${games.length} games across ${leagues.length} leagues`);

    // Helper to parse numeric values
    const parseNum = (val) => {
      if (val === null || val === undefined) return null;
      if (typeof val === 'number') return Number.isFinite(val) ? val : null;
      const s = String(val).replace(/[^0-9+\-.]/g, '').trim();
      if (!s) return null;
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    };

    // Helper to get lock offset for a league
    const getLockOffset = (league) => {
      const m = league?.settings?.lockOffsetMinutes;
      if (typeof m === 'number' && !Number.isNaN(m)) return m;
      const lt = league?.settings?.lineLockTime;
      if (typeof lt === 'number' && !Number.isNaN(lt)) return Math.max(0, Math.round(lt * 60));
      return 60; // default 1 hour
    };

    // Process each league
    const updates = [];
    for (const league of leagues) {
      const lockOffset = getLockOffset(league);
      const existing = { ...(league.locked_lines || {}) };
      let changed = false;

      for (const game of games) {
        if (!game?.id || !game?.startISO) continue;
        if (existing[game.id]) continue; // already has locked lines

        const startTime = new Date(game.startISO);
        const freezeTime = new Date(startTime.getTime() - lockOffset * 60 * 1000);

        if (now < freezeTime) continue; // not frozen yet

        // Create locked line entry
        const homeVal = parseNum(game.homeSpreadNum);
        const awayVal = parseNum(game.awaySpreadNum);
        let spreadToken = null;
        let spreadNumber = null;

        if (homeVal !== null && awayVal !== null) {
          if (homeVal < 0) {
            spreadToken = game.homeAbbr;
            spreadNumber = homeVal;
          } else if (awayVal < 0) {
            spreadToken = game.awayAbbr;
            spreadNumber = awayVal;
          } else {
            spreadToken = game.homeAbbr;
            spreadNumber = homeVal || 0;
          }
        }

        const ouVal = parseNum(game.overUnder);
        const lockedEntry = { lockedAt: now.toISOString() };

        if (spreadToken && spreadNumber !== null) {
          lockedEntry.spread = `${spreadToken} ${spreadNumber > 0 ? `+${spreadNumber}` : `${spreadNumber}`}`;
        }
        if (ouVal !== null) {
          lockedEntry.overUnder = `${ouVal}`;
        }

        existing[game.id] = lockedEntry;
        changed = true;
      }

      if (changed) {
        updates.push({ league, locked_lines: existing });
      }
    }

    // Persist all updates
    if (updates.length > 0) {
      console.log(`[LockedLinesSweep] Saving locked lines for ${updates.length} leagues`);
      for (const { league, locked_lines } of updates) {
        try {
          await updateLeagueLockedLines(league.code, locked_lines);
          console.log(`[LockedLinesSweep] ✓ ${league.code}: ${Object.keys(locked_lines).length} games locked`);
        } catch (err) {
          console.warn(`[LockedLinesSweep] Failed to save ${league.code}:`, err?.message || err);
        }
      }
      return updates; // Return updates so caller can refresh state
    } else {
      console.log('[LockedLinesSweep] No updates needed');
    }
  } catch (error) {
    console.warn('[LockedLinesSweep] Error:', error?.message || error);
  }
};

/* ---------- Error Handling ---------- */

// Error Boundary Component
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: '#0b1020' }}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>⚠️</Text>
          <Text style={{ fontSize: 20, fontWeight: '700', color: '#f8fafc', marginBottom: 8, textAlign: 'center' }}>
            Oops! Something went wrong
          </Text>
          <Text style={{ color: '#94a3b8', marginBottom: 24, textAlign: 'center' }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </Text>
          <Pressable
            style={{ backgroundColor: '#2563eb', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 }}
            onPress={() => this.setState({ hasError: false, error: null })}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Try Again</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

// Helper function for graceful error handling
const handleError = (error, context = 'Operation') => {
  console.error(`${context} error:`, error);
  
  let message = 'An unexpected error occurred';
  
  if (error.message?.includes('network')) {
    message = 'Network error. Please check your connection.';
  } else if (error.message?.includes('auth')) {
    message = 'Authentication error. Please try logging in again.';
  } else if (error.message) {
    message = error.message;
  }
  
  Alert.alert('Error', message, [{ text: 'OK' }]);
};

// Calculate pick results based on actual game outcomes
const calculatePickResult = (pick, game) => {
  if (!game.awayScore || !game.homeScore) return null; // Game not finished
  
  const awayScore = parseInt(game.awayScore);
  const homeScore = parseInt(game.homeScore);
  const totalScore = awayScore + homeScore;
  
  let spreadResult = null;
  let totalResult = null;
  
  // Calculate spread result
  if (pick.spread) {
    const pickedTeam = pick.spread;
    const isAway = pickedTeam === game.awayTeam;
    const spread = parseFloat(isAway ? game.awaySpread : game.homeSpread);
    
    if (isNaN(spread)) {
      spreadResult = null;
    } else {
      const adjustedScore = isAway ? awayScore + spread : homeScore + spread;
      const opponentScore = isAway ? homeScore : awayScore;
      
      if (adjustedScore > opponentScore) {
        spreadResult = 'win';
      } else if (adjustedScore < opponentScore) {
        spreadResult = 'loss';
      } else {
        spreadResult = 'push';
      }
    }
  }
  
  // Calculate total result
  if (pick.total && game.overUnder) {
    const ou = parseFloat(game.overUnder);
    if (!isNaN(ou)) {
      if (pick.total === 'over') {
        if (totalScore > ou) totalResult = 'win';
        else if (totalScore < ou) totalResult = 'loss';
        else totalResult = 'push';
      } else if (pick.total === 'under') {
        if (totalScore < ou) totalResult = 'win';
        else if (totalScore > ou) totalResult = 'loss';
        else totalResult = 'push';
      }
    }
  }
  
  return { spreadResult, totalResult };
};

// Toast Notification Component
const Toast = React.memo(({ message, type = 'info', visible, onDismiss }) => {
  const [opacity] = useState(new Animated.Value(0));

  useEffect(() => {
    if (visible) {
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.delay(2500),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start(() => {
        if (onDismiss) onDismiss();
      });
    }
  }, [visible, onDismiss]);

  if (!visible) return null;

  const bgColor = type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#60a5fa';

  return (
    <Animated.View
      style={{
        position: 'absolute',
        top: 60,
        left: 20,
        right: 20,
        backgroundColor: bgColor,
        padding: 16,
        borderRadius: 12,
        opacity,
        zIndex: 9999,
        flexDirection: 'row',
        alignItems: 'center',
        elevation: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      }}
    >
      <Text style={{ fontSize: 20, marginRight: 12 }}>
        {type === 'success' ? '✓' : type === 'error' ? '⚠️' : 'ℹ️'}
      </Text>
      <Text style={{ color: '#fff', fontWeight: '600', flex: 1 }}>{message}</Text>
    </Animated.View>
  );
});

/* ---------- Footer Component ---------- */

const AppFooter = ({ theme, styles }) => {
  const currentYear = new Date().getFullYear();
  return (
    <View style={{
      paddingVertical: 24,
      paddingHorizontal: 16,
      backgroundColor: theme?.colors?.background,
      borderTopWidth: 1,
      borderTopColor: theme?.colors?.border,
      marginTop: 32,
    }}>
      <Text style={{
        fontSize: 12,
        color: theme?.colors?.muted,
        textAlign: 'center',
        marginBottom: 4,
      }}>
        © {currentYear} Avant Real Estate Investments LLC
      </Text>
      <Text style={{
        fontSize: 11,
        color: theme?.colors?.muted,
        textAlign: 'center',
        fontStyle: 'italic',
        marginBottom: 12,
      }}>
        Spread Heads™ is a trademark of Avant Real Estate Investments LLC
      </Text>
      <Text style={{
        fontSize: 10,
        color: theme?.colors?.muted,
        textAlign: 'center',
        lineHeight: 14,
      }}>
        NFL and the NFL shield design are registered trademarks of the National Football League. Team names, logos, and uniform designs are registered trademarks of the teams indicated.
      </Text>
    </View>
  );
};

/* ---------- Styles ---------- */

const getStyles = (theme) => StyleSheet.create({
  app: { 
    flex: 1, 
    backgroundColor: theme.colors.background,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  banner: {
    backgroundColor: theme.colors.bannerBg,
    padding: 16,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.bannerBorder,
  },
  bannerText: {
    color: theme.colors.heading,
    fontSize: 20,
    fontWeight: "800",
  },
  screen: { flex: 1, padding: 12, paddingBottom: 80 },
  modalOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  modal: {
    backgroundColor: theme.colors.card,
    borderRadius: 12,
    padding: 16,
    width: "100%",
    maxWidth: 400,
    elevation: 5,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  nav: {
    position: "absolute",
    bottom: 20,
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 8,
    backgroundColor: theme.colors.navBg,
    borderRadius: 20,
    elevation: 5,
    shadowColor: theme.colors.shadow,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  tab: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  tabActive: { backgroundColor: theme.colors.navActive },
  tabTxt: { color: "#ffffff" },
  tabTxtActive: { fontWeight: "700" },

  container: { flex: 1 },
  screenHeader: {
    backgroundColor: theme.colors.bannerBg,
    padding: 16,
    marginBottom: 16,
    borderRadius: 8,
  },
  h1: { fontSize: 20, fontWeight: "800", marginBottom: 8, color: theme.colors.heading },
  h2: { fontSize: 16, fontWeight: "700", marginBottom: 6, color: theme.colors.heading },
  muted: { color: theme.colors.muted },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: 10,
    padding: 12,
    elevation: 2,
    marginBottom: 8,
  },
  logo: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 8,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
  },
  btnBlue: {
    backgroundColor: theme.colors.primary,
    padding: 10,
    borderRadius: 6,
    alignItems: "center",
  },
  btnGreen: {
    backgroundColor: theme.colors.success,
    padding: 10,
    borderRadius: 6,
    alignItems: "center",
  },
  btnTxt: { color: "white", fontWeight: "700" },
  li: {
    backgroundColor: theme.colors.surface,
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
  },
  label: { 
    fontWeight: "800",      // Even bolder
    marginBottom: 6,         // More space below label
    marginTop: 8,            // Space above label for better separation
    fontSize: 15,            // Larger font
    color: theme.colors.text, // Theme-aware: black in light mode, white in dark mode
    letterSpacing: 0.3,      // Slightly spread out for readability
  },
  error: { 
    color: theme.colors.danger, 
    fontSize: 14, 
    marginBottom: 8,
    textAlign: "center" 
  },
  success: {
    color: theme.colors.success,
    fontSize: 14,
    marginBottom: 8,
    textAlign: "center"
  },
  btnDisabled: {
    opacity: 0.7,
  },
  valueText: {
    fontSize: 16,
    color: theme.colors.text,
    marginTop: 2,
  },
  pickButton: {
    width: 60,
    height: 36,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: theme.colors.pickBorder,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  pickButtonSelected: {
    backgroundColor: theme.colors.success,
    borderColor: theme.colors.success,
  },
  pickButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.muted,
    textAlign: "center",
  },
  pickButtonTextSelected: {
    color: "#fff",
  },
});

const App = () => {
  const [tab, setTab] = useState("Home");
  const [navStack, setNavStack] = useState(["Home"]);
  const [leagues, setLeagues] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [notifPrefs, setNotifPrefsState] = useState(null);
  const [themeName, setThemeName] = useState('dark');
  const theme = themeName === 'dark' ? darkTheme : lightTheme;
  const styles = getStyles(theme);
  const [showAuth, setShowAuth] = useState(false); // Don't show auth by default
  const [showWelcome, setShowWelcome] = useState(true); // Show welcome screen first
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [isLogin, setIsLogin] = useState(true); // true for login, false for signup
  const [loading, setLoading] = useState(false);
    const [showTrendsLock, setShowTrendsLock] = useState(false);
  const [showLegalPrompt, setShowLegalPrompt] = useState(false);
  const [agreedLegal, setAgreedLegal] = useState(false);
  const [showTermsGlobal, setShowTermsGlobal] = useState(false);
  const [showPrivacyGlobal, setShowPrivacyGlobal] = useState(false);
  const [pendingJoinCode, setPendingJoinCode] = useState(null); // Store join code from deep link
  const [syncPicksAcrossLeagues, setSyncPicksAcrossLeagues] = useState(false); // Sync picks across same-type leagues
  const displayName = profile?.display_name || currentUser?.user_metadata?.display_name || currentUser?.user_metadata?.username || currentUser?.email?.split('@')[0] || 'Guest';
  
  // Animation for screen transitions
  const fadeAnim = useRef(new Animated.Value(1)).current;

  // Fade animation when tab changes
  useEffect(() => {
    fadeAnim.setValue(0);
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [tab]);

  // Simple navigation helpers
  const navigateTo = useCallback((nextTab) => {
    setNavStack((prev) => {
      const last = prev[prev.length - 1];
      if (last === nextTab) return prev; // avoid duplicate
      const next = [...prev, nextTab];
      return next;
    });
    setTab(nextTab);
  }, []);

  const goBack = useCallback(() => {
    setNavStack((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.slice(0, -1);
      setTab(next[next.length - 1]);
      return next;
    });
  }, []);

  // Load initial data
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        setLoading(true);
        
        // Load user with error handling
        try {
          const { user } = await supabaseGetCurrentUser();
          if (user) {
            // Try to load profile; if missing, create a default one
            let profileData = null;
            const { data: loadedProfile, error: profileError } = await getUserProfile(user.id);
            if (profileError) {
              console.warn('Profile load warning:', profileError);
            }
            profileData = loadedProfile || null;

            if (!profileData) {
              const usernameMeta = user?.user_metadata?.username || user?.email?.split('@')?.[0] || '';
              const displayNameMeta = user?.user_metadata?.display_name || usernameMeta;
              const { data: createdProfile, error: createErr } = await createUserProfile({
                id: user.id,
                email: user.email,
                username: usernameMeta,
                display_name: displayNameMeta,
              });
              if (createErr) {
                console.warn('Profile create warning:', createErr);
              } else {
                profileData = createdProfile || profileData;
              }
            }

            setCurrentUser(user);
            setProfile(profileData || null);
            setShowAuth(false);
            setShowWelcome(false); // Hide welcome if user is logged in
          } else {
            setShowWelcome(true); // Show welcome if no user
          }
        } catch (authError) {
          console.warn('Auth check failed:', authError);
          setShowWelcome(true); // Show welcome on auth error
        }
        
        // Set dark mode as default
        try {
          // Set dark mode and save it as the preference
          setThemeName('dark');
          await AsyncStorage.setItem('THEME_PREF', 'dark');
          // Note: Users can still change to light mode in Profile settings
        } catch (themeError) {
          console.warn('Theme setup failed:', themeError);
        }
        
        // Determine onboarding state for signed-out users
        try {
          const ob = await AsyncStorage.getItem('ONBOARDING_COMPLETE');
          if (!currentUser && ob !== '1') {
            setShowOnboarding(true);
            setShowWelcome(false);
          }
        } catch {}

        // Load sync picks preference
        try {
          const syncPref = await AsyncStorage.getItem('SYNC_PICKS_ACROSS_LEAGUES');
          if (syncPref === 'true') {
            setSyncPicksAcrossLeagues(true);
          }
        } catch (syncErr) {
          console.warn('Failed to load sync picks preference:', syncErr);
        }

        // Load leagues: first from local cache for fast UI, then refresh from Supabase if logged in
        try {
          // 1) Fast load from local storage cache
          let cachedLeagues = [];
          try {
            cachedLeagues = await loadLeagues();
            if (Array.isArray(cachedLeagues) && cachedLeagues.length > 0) {
              console.log('📦 Loaded', cachedLeagues.length, 'leagues from local cache');
              const normalizedCached = cachedLeagues.map(l => ({
                ...l,
                settings: l.settings ? normalizeLeagueSettings(l.type, l.settings) : l.settings,
                picks: l.picks || {}
              }));
              setLeagues(normalizedCached);
            } else {
              console.log('📦 No cached leagues found');
            }
          } catch (cacheErr) {
            console.warn('Leagues cache load failed:', cacheErr);
          }

          // 2) Fresh load from Supabase using the resolved user from auth (not the possibly stale state)
          const { user } = await supabaseGetCurrentUser();
          if (user?.id) {
            console.log('🔄 Loading leagues from Supabase for user:', user.id);
            const { data, error } = await getLeaguesForUser(user.id);
            if (error) {
              console.warn('Supabase leagues load failed:', error);
              setLeagues(prev => (Array.isArray(prev) && prev.length > 0 ? prev : []));
            } else {
              console.log('📥 Loaded', (data || []).length, 'leagues from Supabase');
              
              // Load picks from the picks table for each league
              let mergedLeagues = await Promise.all((data || []).map(async (league) => {
                // Normalize settings for each league
                league.settings = league.settings ? normalizeLeagueSettings(league.type, league.settings) : league.settings;
                const { data: picksData, error: picksError } = await getPicksForLeague(league.code);
                
                if (picksError) {
                  console.warn('Failed to load picks for league:', league.code, picksError);
                } else if (picksData && picksData.length > 0) {
                  console.log('📥 Loaded', picksData.length, 'picks for league:', league.code);
                  
                  // Convert picks array to the nested object format: picks[userId][gameId]
                  const picksObject = {};
                  picksData.forEach(pick => {
                    if (!picksObject[pick.user_id]) {
                      picksObject[pick.user_id] = {};
                    }
                    picksObject[pick.user_id][pick.game_id] = {
                      spread: pick.spread,
                      total: pick.total,
                      winner: pick.winner,
                      timestamp: pick.created_at,
                      editedAt: pick.updated_at !== pick.created_at ? pick.updated_at : undefined
                    };
                  });
                  
                  league.picks = picksObject;
                }
                
                // Also merge local picks if any
                const localLeague = (cachedLeagues || []).find(l => l.code === league.code);
                if (localLeague && localLeague.picks) {
                  console.log('🔀 Merging local picks for league:', league.code);
                  league.picks = league.picks || {};
                  Object.keys(localLeague.picks).forEach(userId => {
                    league.picks[userId] = league.picks[userId] || {};
                    Object.keys(localLeague.picks[userId] || {}).forEach(gameId => {
                      // Only use local pick if not already in Supabase data
                      if (!league.picks[userId][gameId]) {
                        league.picks[userId][gameId] = localLeague.picks[userId][gameId];
                      }
                    });
                  });
                }
                
                return league;
              }));
              
              console.log('✅ Merged leagues with picks:', mergedLeagues.length);
              setLeagues(mergedLeagues);
              try { await saveLeagues(mergedLeagues); } catch {}

              // Run global locked lines sweep after leagues are loaded
              try {
                const sweepUpdates = await globalLockedLinesSweep(mergedLeagues);
                if (sweepUpdates && sweepUpdates.length > 0) {
                  // Update leagues state with newly locked lines
                  setLeagues(prev => prev.map(league => {
                    const update = sweepUpdates.find(u => u.league.code === league.code);
                    return update ? { ...league, locked_lines: update.locked_lines } : league;
                  }));
                  console.log(`[LockedLinesSweep] Updated ${sweepUpdates.length} leagues in state`);
                }
              } catch (sweepErr) {
                console.warn('[LockedLinesSweep] Sweep failed:', sweepErr);
              }
            }
          } else {
            console.log('❌ No user logged in, clearing leagues');
            setLeagues([]);
            try { await saveLeagues([]); } catch {}
          }
        } catch (leaguesError) {
          console.warn('Leagues load failed:', leaguesError);
          // On failure, keep whatever is in memory (from cache) or empty
          setLeagues(prev => (Array.isArray(prev) ? prev : []));
        }
        
        setLoading(false);
      } catch (error) {
        console.error('Critical error loading initial data:', error);
        handleError(error, 'Loading data');
        setLoading(false);
        setShowWelcome(true); // Show welcome on error
      }
    };

    loadInitialData();
  }, []);

  // Subscribe to real-time updates for all leagues
  useEffect(() => {
    if (!currentUser?.id || !leagues || leagues.length === 0) {
      return;
    }

    console.log(`[Realtime] Setting up subscriptions for ${leagues.length} leagues`);
    const cleanupFunctions = [];

    // Subscribe to each league
    leagues.forEach(league => {
      const leagueCode = league.league_code || league.code;
      if (!leagueCode) return;

      // Subscribe to picks changes (silent background refresh)
      const cleanupPicks = subscribeToLeaguePicks(leagueCode, async (payload) => {
        console.log(`[Realtime] Picks changed in ${leagueCode}, refreshing...`);
        // Reload this league's picks
        try {
          const { data: picksData, error } = await getPicksForLeague(leagueCode);
          if (!error && picksData) {
            setLeagues(prevLeagues => {
              return prevLeagues.map(l => {
                if ((l.league_code || l.code) === leagueCode) {
                  const picksObject = {};
                  picksData.forEach(pick => {
                    if (!picksObject[pick.user_id]) {
                      picksObject[pick.user_id] = {};
                    }
                    picksObject[pick.user_id][pick.game_id] = {
                      spread: pick.spread,
                      total: pick.total,
                      winner: pick.winner,
                      timestamp: pick.created_at,
                      editedAt: pick.updated_at !== pick.created_at ? pick.updated_at : undefined
                    };
                  });
                  return { ...l, picks: picksObject };
                }
                return l;
              });
            });
          }
        } catch (err) {
          console.warn('Failed to refresh picks:', err);
        }
      });
      cleanupFunctions.push(cleanupPicks);

      // Subscribe to league settings changes (with notification)
      const cleanupSettings = subscribeToLeagueSettings(leagueCode, async (payload) => {
        console.log(`[Realtime] Settings changed in ${leagueCode}, refreshing...`);
        // Reload this league's data
        try {
          const { data, error } = await getLeagueByCode(leagueCode);
          if (!error && data) {
            setLeagues(prevLeagues => {
              return prevLeagues.map(l => {
                if ((l.league_code || l.code) === leagueCode) {
                  return {
                    ...l,
                    ...data,
                    settings: data.settings ? normalizeLeagueSettings(data.type, data.settings) : data.settings,
                    picks: l.picks // preserve picks
                  };
                }
                return l;
              });
            });
          }
        } catch (err) {
          console.warn('Failed to refresh league settings:', err);
        }
      }, true); // notifyUser = true
      cleanupFunctions.push(cleanupSettings);

      // Subscribe to member changes (with notifications)
      const cleanupMembers = subscribeToLeagueMembers(leagueCode, currentUser.id, async ({ type, payload }) => {
        console.log(`[Realtime] Members changed in ${leagueCode}: ${type}`);
        // Reload league to get updated member list
        try {
          const { data, error } = await getLeagueByCode(leagueCode);
          if (!error && data) {
            setLeagues(prevLeagues => {
              return prevLeagues.map(l => {
                if ((l.league_code || l.code) === leagueCode) {
                  return {
                    ...l,
                    members: data.members,
                    picks: l.picks // preserve picks
                  };
                }
                return l;
              });
            });
          }
        } catch (err) {
          console.warn('Failed to refresh league members:', err);
        }
      }, true); // notifyUser = true
      cleanupFunctions.push(cleanupMembers);
    });

    // Subscribe to friend requests
    const cleanupFriendRequests = subscribeToFriendRequests(currentUser.id, (payload) => {
      console.log('[Realtime] Friend request event received');
      // Notification is already handled in the subscription
      // Could trigger a badge update or refresh friends list here
    });
    cleanupFunctions.push(cleanupFriendRequests);

    // Cleanup all subscriptions when component unmounts or dependencies change
    return () => {
      console.log('[Realtime] Cleaning up all subscriptions');
      cleanupFunctions.forEach(cleanup => cleanup());
    };
  }, [currentUser?.id, leagues?.length]); // Re-subscribe when user or league count changes

  // Check legal acceptance when user is available
  useEffect(() => {
    if (currentUser) {
      const accepted = currentUser?.user_metadata?.accepted_terms_version;
      if (accepted !== LEGAL_VERSION) {
        setShowLegalPrompt(true);
        setAgreedLegal(false);
      }
    }
  }, [currentUser]);

  // Initialize notifications (request permission once) and save push token
  useEffect(() => {
    (async () => {
      try {
        // Load notification prefs
        const prefs = await getNotificationPrefs();
        setNotifPrefsState(prefs);

        const res = await registerForPushNotificationsAsync();
        if (res?.granted) {
          // Persist weekly results reminder (one-time) if enabled
          try {
            const p = prefs || (await getNotificationPrefs());
            if (p.enabled && p.weeklyResults) {
              await scheduleWeeklyResultsReminderIfNeeded();
            }
          } catch {}

          // Save Expo push token for server-side pushes (if available)
          const token = res?.token;
          const uid = currentUser?.id;
          if (token && uid) {
            try { await savePushToken(uid, token); } catch {}
          }
        }
      } catch {}
    })();
  }, []);

  // Setup offline queue processing
  useEffect(() => {
    // Process any queued picks on app start
    (async () => {
      try {
        const queueSize = await getQueueSize();
        if (queueSize > 0) {
          console.log(`📦 Found ${queueSize} queued picks, processing...`);
          const results = await processOfflineQueue();
          if (results.processed > 0) {
            Alert.alert(
              'Picks Synced',
              `Successfully synced ${results.processed} queued pick${results.processed > 1 ? 's' : ''} to the server.`
            );
          }
        }
      } catch (e) {
        console.warn('Failed to process queue on startup:', e);
      }
    })();

    // Setup auto-processing when network becomes available
    const cleanup = setupAutoQueueProcessing(async (results) => {
      if (results.processed > 0) {
        Alert.alert(
          'Picks Synced',
          `Successfully synced ${results.processed} queued pick${results.processed > 1 ? 's' : ''} to the server.`
        );
      }
    });

    return cleanup;
  }, []);

  // Auto-pick processing - check periodically and when leagues/games change
  useEffect(() => {
    const checkAndProcessAutoPicks = async () => {
      try {
        // Only process if user is logged in and has leagues
        if (!currentUser?.id || !leagues || leagues.length === 0) return;
        
        // Check if auto-pick is enabled
        const should = await shouldProcessAutoPicks();
        if (!should) return;

        // Get available games (need to have games data)
        // We'll process auto-picks after games are loaded
        // This is a placeholder - actual processing happens in the game fetch
      } catch (error) {
        console.warn('Auto-pick check failed:', error);
      }
    };

    // Check on mount and when leagues change
    checkAndProcessAutoPicks();
  }, [currentUser, leagues]);

  // Deep link handling for league invites
  useEffect(() => {
    const handleDeepLink = (event) => {
      const url = event.url;
      console.log('Deep link received:', url);
      
      if (url) {
        const { hostname, path, queryParams } = Linking.parse(url);
        
        // Handle myfirstapp://join?code=XXXXX
        if (hostname === 'join' || path === 'join') {
          const code = queryParams?.code;
          if (code) {
            console.log('Join code from deep link:', code);
            
            // If user is logged in, join immediately
            if (currentUser) {
              handleJoinLeague(code);
            } else {
              // Save code and show auth
              setPendingJoinCode(code);
              setShowWelcome(false);
              setShowAuth(true);
              setIsLogin(true);
            }
          }
        }
      }
    };

    // Handle initial URL (app opened from link)
    Linking.getInitialURL().then((url) => {
      if (url) {
        handleDeepLink({ url });
      }
    });

    // Handle URL events while app is running
    const subscription = Linking.addEventListener('url', handleDeepLink);

    return () => {
      subscription.remove();
    };
  }, [currentUser]);

  // Auto-join league after login if there's a pending code
  useEffect(() => {
    if (currentUser && pendingJoinCode) {
      handleJoinLeague(pendingJoinCode);
      setPendingJoinCode(null);
    }
  }, [currentUser, pendingJoinCode, handleJoinLeague]);

  const handleJoinLeague = useCallback(async (rawCode) => {
    const code = rawCode?.toString().trim().toUpperCase();
    if (!code) {
      Alert.alert('Invalid Code', 'Please provide a valid league code.');
      return;
    }

    // Try local first
    let leagueToJoin = leagues.find(l => l.code === code);

    // If not in local cache, fetch from Supabase
    if (!leagueToJoin) {
      try {
        const { data, error } = await getLeagueByCode(code);
        if (error || !data) {
          Alert.alert('League Not Found', `No league found with code: ${code}. Make sure the code is correct.`);
          return;
        }
        leagueToJoin = data;
        // Merge into local leagues if not present
        setLeagues(prev => {
          const exists = prev.some(l => l.code === data.code);
          return exists ? prev : [...prev, { ...data, picks: data.picks || {} }];
        });
      } catch (e) {
        Alert.alert('Error', 'Failed to look up league. Please try again later.');
        return;
      }
    }

    // Ensure members array is normalized (could be array of userIds or objects depending on legacy structure)
    const memberIds = (leagueToJoin.members || []).map(m => typeof m === 'string' ? m : m.userId).filter(Boolean);
    const alreadyMember = memberIds.includes(currentUser?.id);
    if (alreadyMember) {
      Alert.alert('Already a Member', `You're already in "${leagueToJoin.name}"!`, [
        { text: 'OK' },
        { text: 'View League', onPress: () => navigateTo(`LeagueDetails:${leagueToJoin.code}`) }
      ]);
      return;
    }

    Alert.alert('Join League', `Do you want to join "${leagueToJoin.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Join',
        onPress: async () => {
          try {
            // Persist membership server-side
            const { data, error } = await addUserToLeague(leagueToJoin.code, currentUser?.id);
            if (error) {
              Alert.alert('Error', error.message || 'Failed to join league');
              return;
            }
            // Update local state
            setLeagues(prev => prev.map(l => l.code === leagueToJoin.code ? { ...l, members: data.members } : l));
            Alert.alert('Success', `You've joined "${leagueToJoin.name}"!`);
            navigateTo(`LeagueDetails:${leagueToJoin.code}`);
          } catch (e) {
            Alert.alert('Error', e.message || 'Unexpected error joining league');
          }
        }
      }
    ]);
  }, [leagues, currentUser, navigateTo, setLeagues]);

  useEffect(() => {
    // Persist leagues whenever they change (including empty array to reflect deletions/logouts)
    if (Array.isArray(leagues)) {
      console.log('Caching leagues locally:', leagues.length, 'leagues');
      saveLeagues(leagues).catch(e => console.warn('Failed to cache leagues:', e));
    }
  }, [leagues]);

  // Save sync picks preference when it changes
  useEffect(() => {
    AsyncStorage.setItem('SYNC_PICKS_ACROSS_LEAGUES', syncPicksAcrossLeagues ? 'true' : 'false')
      .catch(e => console.warn('Failed to save sync picks preference:', e));
  }, [syncPicksAcrossLeagues]);

  // Android hardware back support
  useEffect(() => {
    const onBackPress = () => {
      if (navStack.length > 1) {
        goBack();
        return true;
      }
      return false;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, [navStack.length]);

  // Manual auto-pick trigger - can be called from UI or after game updates
  const triggerAutoPicks = async (games) => {
    try {
      if (!currentUser?.id || !leagues || leagues.length === 0) return;
      
      const should = await shouldProcessAutoPicks();
      if (!should) return;

      // Build team records for favorites strategy (optional enhancement)
      const teamRecords = {};
      // Could populate from games data if available

      const result = await processAutoPicks(currentUser.id, leagues, games || {}, teamRecords);
      
      if (result.updatedLeagues && result.updatedLeagues.length > 0) {
        // Update leagues with auto-picks
        const updatedLeagues = leagues.map(league => {
          const updated = result.updatedLeagues.find(ul => ul.code === league.code);
          return updated || league;
        });
        setLeagues(updatedLeagues);
        
        console.log(`Auto-picks processed: ${result.picksAdded} picks across ${result.leaguesAffected.length} leagues`);
      }
    } catch (error) {
      console.warn('Auto-pick trigger failed:', error);
    }
  };

  const handleLogout = async () => {
    try {
      // Unsubscribe from all real-time channels before logout
      unsubscribeAll();
      
      await logout();
      setCurrentUser(null);
      setProfile(null);
      setLeagues([]);
      setShowWelcome(true);
      setTab("Home");
    } catch (error) {
      console.error('Logout error:', error);
      // Still attempt to log out even if error occurs
      await logout();
      setCurrentUser(null);
      setProfile(null);
      setLeagues([]);
      setShowWelcome(true);
      setTab("Home");
    }
  };

  return (
    <SafeAreaView style={[styles.app, { backgroundColor: theme.colors.background }]}>
      <StatusBar 
        backgroundColor={theme.colors.bannerBg} 
        barStyle={themeName === 'dark' ? 'light-content' : 'dark-content'} 
      />
      
      {/* Initial Loading Overlay */}
      {loading && (
        <View style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: theme.colors.background,
          zIndex: 9999,
          justifyContent: 'center',
          alignItems: 'center',
        }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={{ color: theme.colors.text, marginTop: 16, fontSize: 16, fontWeight: '600' }}>
            Loading...
          </Text>
        </View>
      )}
      
      {tab === "Home" ? (
        <View style={[styles.banner, { backgroundColor: theme.colors.bannerBg, borderBottomColor: theme.colors.bannerBorder, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
          <View style={{ width: 40, alignItems: 'flex-start' }}>
            {navStack.length > 1 && tab !== "Home" && (
              <Pressable onPress={goBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ paddingVertical: 2, paddingHorizontal: 4 }}>
                <Text style={{ color: theme.colors.heading, fontSize: 20 }}>{"\u2190"}</Text>
              </Pressable>
            )}
          </View>
          <Text style={[styles.bannerText, { color: theme.colors.heading }]}>Welcome {displayName}</Text>
          <View style={{ width: 40 }} />
        </View>
      ) : (
        <View style={{ paddingHorizontal: 8, paddingVertical: 6 }}>
          {navStack.length > 1 && (
            <Pressable onPress={goBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ paddingVertical: 2, paddingHorizontal: 4, alignSelf: 'flex-start' }}>
              <Text style={{ color: theme.colors.heading, fontSize: 20 }}>{"\u2190"}</Text>
            </Pressable>
          )}
        </View>
      )}
      <Animated.View style={[styles.screen, { opacity: fadeAnim }]}>
        {tab === "ClearData" && <ClearDataScreen setTab={setTab} />}
        {tab === "Home" && (
          <HomeScreen
            leagues={leagues}
            currentUser={currentUser}
            setTab={navigateTo}
            onAuthPress={() => setShowAuth(true)}
            theme={theme}
            styles={styles}
          />
        )}
        {tab === "CreateLeague" && (
          <CreateLeagueScreen
            leagues={leagues}
            setLeagues={setLeagues}
            currentUser={currentUser}
            setTab={navigateTo}
            theme={theme}
            styles={styles}
          />
        )}
        {tab === "Leagues" && (
          <LeaguesScreen
            leagues={leagues}
            setLeagues={setLeagues}
            currentUser={currentUser}
            profile={profile}
            setTab={navigateTo}
            theme={theme}
            styles={styles}
          />
        )}
        {tab === "MasterPicks" && (
          <MasterPicksScreen
            currentUser={currentUser}
            profile={profile}
            leagues={leagues}
            setLeagues={setLeagues}
            theme={theme}
            styles={styles}
            setTab={navigateTo}
          />
        )}
        {tab === "Scoreboard" && (
          <ScoreboardScreen leagues={leagues} currentUser={currentUser} tab={tab} theme={theme} styles={styles} notifPrefs={notifPrefs} />
        )}
        {tab === "Profile" && (
         <ProfileScreen 
           currentUser={currentUser}
           profile={profile}
           setProfile={setProfile}
           setCurrentUser={setCurrentUser}
           theme={theme}
           setThemeName={setThemeName}
           styles={styles}
           leagues={leagues}
           setTab={navigateTo}
           syncPicksAcrossLeagues={syncPicksAcrossLeagues}
           setSyncPicksAcrossLeagues={setSyncPicksAcrossLeagues}
           onReplayOnboarding={async () => {
             try { await AsyncStorage.setItem('ONBOARDING_COMPLETE', '0'); } catch {}
             setShowOnboarding(true);
             setShowWelcome(false);
           }}
           onLogout={handleLogout}
         />
        )}
        {tab === "Help" && (
          <HelpScreen
            theme={theme}
            styles={styles}
            setTab={navigateTo}
          />
        )}
        {tab === "NotificationSettings" && (
          <NotificationSettingsScreen
            theme={theme}
            styles={styles}
            setTab={navigateTo}
          />
        )}
        {tab === "AutoPickSettings" && (
          <AutoPickSettingsScreen
            theme={theme}
            styles={styles}
            setTab={navigateTo}
            leagues={leagues}
          />
        )}
        {tab === "Weekly" && (
          <WeeklyResultsScreen
            leagues={leagues}
            setLeagues={setLeagues}
            currentUser={currentUser}
            setTab={navigateTo}
            theme={theme}
            onNavigate={navigateTo}
          />
        )}
        {tab === "Trends" && (
          <TrendsScreen
            leagues={leagues}
            currentUser={currentUser}
            theme={theme}
          />
        )}
        {tab === "Leaderboard" && (
          <LeaderboardScreen
            leagues={leagues}
            currentUser={currentUser}
            theme={theme}
          />
        )}
        {tab === "Achievements" && (
          <AchievementsScreen
            leagues={leagues}
            currentUser={currentUser}
            theme={theme}
          />
        )}
        {tab.startsWith("UserProfile:") && (
          <UserProfileScreen
            userId={tab.split(":")[1]}
            username={tab.split(":")[2] || "User"}
            leagues={leagues}
            currentUser={currentUser}
            theme={theme}
            onBack={() => setTab(navStack[navStack.length - 2] || "Home")}
          />
        )}
        {tab === "Friends" && (
          <FriendsScreen
            currentUser={currentUser}
            leagues={leagues}
            setLeagues={setLeagues}
            theme={theme}
            onViewProfile={(userId, username) => navigateTo(`UserProfile:${userId}:${username}`)}
            onBack={() => setTab(navStack[navStack.length - 2] || "Profile")}
          />
        )}
        {tab.startsWith("LeagueDetails:") && (
          <LeagueDetailsScreen
            leagueCode={tab.split(":")[1]}
            leagues={leagues}
            setLeagues={setLeagues}
            currentUser={currentUser}
            setTab={navigateTo}
            theme={theme}
            styles={styles}
          />
        )}
        {tab.startsWith("LeagueSettings:") && (
          <LeagueSettingsScreen
            leagueCode={tab.split(":")[1]}
            leagues={leagues}
            setLeagues={setLeagues}
            currentUser={currentUser}
            setTab={navigateTo}
            theme={theme}
            styles={styles}
          />
        )}
        {tab.startsWith("HallOfFame:") && (
          <HallOfFameScreen
            leagueCode={tab.split(":")[1]}
            leagues={leagues}
            setTab={navigateTo}
            theme={theme}
            styles={styles}
          />
        )}
        {tab.startsWith("Picks:") && (
          <PicksScreen
            leagueCode={tab.split(":")[1]}
            leagues={leagues}
            setLeagues={setLeagues}
            currentUser={currentUser}
            setTab={navigateTo}
            theme={theme}
            styles={styles}
            notifPrefs={notifPrefs}
            syncPicksAcrossLeagues={syncPicksAcrossLeagues}
          />
        )}
      </Animated.View>

      {/* Onboarding - shown first for new users */}
      {showOnboarding && !currentUser && (
        <OnboardingScreen
          theme={theme}
          styles={styles}
          onEnableNotifications={async () => {
            try {
              const res = await registerForPushNotificationsAsync();
              // Enable prefs if granted
              const prefs = await getNotificationPrefs();
              const next = { ...prefs, enabled: !!res?.granted };
              await setNotificationPrefs(next);
              if (next.enabled && next.weeklyResults) {
                try { await scheduleWeeklyResultsReminderIfNeeded(); } catch {}
              }
            } catch (e) {
              console.warn('Enable notifications failed', e);
            }
          }}
          onDone={() => {
            setShowOnboarding(false);
            setShowWelcome(true);
          }}
        />
      )}

      {/* Welcome Screen - shown before auth */}
      {showWelcome && !currentUser && (
        <View style={[styles.modalOverlay, { backgroundColor: theme.colors.background }]}>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 }}>
            {/* App Logo */}
            <View style={{ alignItems: 'center', marginBottom: 60 }}>
              <Text style={{ fontSize: 80, marginBottom: 16 }}>🏈</Text>
              <Text style={{ fontSize: 32, fontWeight: '700', color: theme.colors.text, marginBottom: 8 }}>
                Spread Heads
              </Text>
              <Text style={{ fontSize: 16, color: theme.colors.muted, textAlign: 'center' }}>
                Compete with friends in NFL pick'em leagues
              </Text>
            </View>

            {/* Sign In Button */}
            <Pressable
              style={[styles.btnGreen, { paddingHorizontal: 48, paddingVertical: 16, marginBottom: 16, minWidth: 200 }]}
              onPress={() => {
                setShowWelcome(false);
                setShowAuth(true);
                setIsLogin(true);
              }}
            >
              <Text style={[styles.btnTxt, { fontSize: 18 }]}>Sign In</Text>
            </Pressable>

            {/* Sign Up Button */}
            <Pressable
              style={[styles.card, { backgroundColor: theme.colors.card, paddingHorizontal: 48, paddingVertical: 16, marginBottom: 32, minWidth: 200, alignItems: 'center' }]}
              onPress={() => {
                setShowWelcome(false);
                setShowAuth(true);
                setIsLogin(false);
              }}
            >
              <Text style={{ color: theme.colors.primary, fontSize: 18, fontWeight: '600' }}>Create Account</Text>
            </Pressable>

            {/* Continue as Guest */}
            <Pressable
              onPress={() => setShowWelcome(false)}
              style={{ marginTop: 16 }}
            >
              <Text style={{ color: theme.colors.muted, fontSize: 14 }}>
                Continue as Guest →
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Auth Modal */}
      {showAuth && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modal, { backgroundColor: theme.colors.card }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.h2}>{isLogin ? "Login" : "Sign Up"}</Text>
              <Pressable onPress={() => {
                setShowAuth(false);
                setShowWelcome(true);
              }}>
                <Text style={{ fontSize: 20, color: theme.colors.muted }}>×</Text>
              </Pressable>
            </View>

            {isLogin ? (
              <LoginForm
                styles={styles}
                onSubmit={async (user) => {
                  if (user) {
                    setCurrentUser(user);
                    // Ensure profile exists
                    try {
                      const { data: existingProfile, error: profileError } = await getUserProfile(user.id);
                      if (profileError && profileError.code !== 'PGRST116') {
                        console.warn('Profile fetch error:', profileError);
                      }
                      if (!existingProfile) {
                        const usernameMeta = user?.user_metadata?.username || user?.email?.split('@')?.[0] || 'user';
                        const displayNameMeta = user?.user_metadata?.display_name || usernameMeta;
                        await createUserProfile({ 
                          id: user.id, 
                          email: user.email, 
                          username: usernameMeta, 
                          display_name: displayNameMeta 
                        });
                        const { data: created } = await getUserProfile(user.id);
                        setProfile(created || null);
                      } else {
                        setProfile(existingProfile || null);
                      }
                    } catch (e) {
                      console.warn('Profile setup error:', e);
                    }
                    setShowAuth(false);
                    setShowWelcome(false);
                  }
                }}
              />
            ) : (
              <SignUpForm
                styles={styles}
                onSubmit={async (user) => {
                  if (user) {
                    setCurrentUser(user);
                    // Profile is already created in SignUpForm, just load it
                    try {
                      const { data: profileData } = await getUserProfile(user.id);
                      setProfile(profileData || null);
                    } catch (e) {
                      console.warn('Profile load error after signup:', e);
                    }
                    setShowAuth(false);
                    // Show onboarding only if not completed
                    try {
                      const ob = await AsyncStorage.getItem('ONBOARDING_COMPLETE');
                      if (ob !== '1') {
                        setShowOnboarding(true);
                        setShowWelcome(false);
                      } else {
                        setShowOnboarding(false);
                        setShowWelcome(false);
                      }
                    } catch {
                      setShowOnboarding(true);
                      setShowWelcome(false);
                    }
                  }
                }}
              />
            )}

            <Pressable
              onPress={() => setIsLogin(!isLogin)}
              style={{ marginTop: 12 }}
            >
              <Text style={{ color: theme.colors.primary, textAlign: "center" }}>
                {isLogin ? "Need an account? Sign up" : "Have an account? Login"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Global Legal Prompt for existing users when version updates */}
      {showLegalPrompt && (
        <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.modal, { backgroundColor: theme.colors.card, maxHeight: '80%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.h2}>Review Updated Terms</Text>
              {/* No close button to enforce acceptance before continuing */}
            </View>
            <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
              <Text style={{ color: theme.colors.text, marginBottom: 12 }}>
                To continue using Spread Heads, please review and accept our Terms of Service and Privacy Policy.
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                <Pressable onPress={() => setShowTermsGlobal(true)} style={[styles.btnBlue, { paddingVertical: 10, paddingHorizontal: 12 }]}>
                  <Text style={styles.btnTxt}>View Terms</Text>
                </Pressable>
                <Pressable onPress={() => setShowPrivacyGlobal(true)} style={[styles.btnBlue, { paddingVertical: 10, paddingHorizontal: 12 }]}>
                  <Text style={styles.btnTxt}>View Privacy</Text>
                </Pressable>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                <Pressable onPress={() => setAgreedLegal(!agreedLegal)} style={{ marginRight: 10 }}>
                  <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 1.5, borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: agreedLegal ? theme.colors.primary : 'transparent' }}>
                    {agreedLegal ? <Text style={{ color: 'white', fontWeight: '800' }}>✓</Text> : null}
                  </View>
                </Pressable>
                <Text style={{ color: theme.colors.muted }}>
                  I have read and agree to the Terms and Privacy Policy.
                </Text>
              </View>
              <Pressable
                disabled={!agreedLegal}
                style={[styles.btnGreen, !agreedLegal && styles.btnDisabled]}
                onPress={async () => {
                  try {
                    await supabaseUpdateUserMetadata({
                      accepted_terms_version: LEGAL_VERSION,
                      accepted_terms_at: new Date().toISOString(),
                    });
                    // Refresh current user to reflect metadata
                    const { user: refreshed } = await supabaseGetCurrentUser();
                    if (refreshed) setCurrentUser(refreshed);
                    setShowLegalPrompt(false);
                  } catch (e) {
                    console.warn('Failed to record legal acceptance', e);
                  }
                }}
              >
                <Text style={styles.btnTxt}>Agree & Continue</Text>
              </Pressable>
            </View>
          </View>

          {/* Terms modal */}
          {showTermsGlobal && (
            <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
              <View style={[styles.modal, { backgroundColor: 'white', maxHeight: '80%' }]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.h2}>Terms of Service</Text>
                  <Pressable onPress={() => setShowTermsGlobal(false)}><Text style={{ fontSize: 20, color: '#666' }}>×</Text></Pressable>
                </View>
                <ScrollView style={{ paddingHorizontal: 8 }}>
                  <Text style={{ color: '#333', lineHeight: 20, marginBottom: 16 }}>{TERMS_TEXT}</Text>
                </ScrollView>
              </View>
            </View>
          )}

          {/* Privacy modal */}
          {showPrivacyGlobal && (
            <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
              <View style={[styles.modal, { backgroundColor: 'white', maxHeight: '80%' }]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.h2}>Privacy Policy</Text>
                  <Pressable onPress={() => setShowPrivacyGlobal(false)}><Text style={{ fontSize: 20, color: '#666' }}>×</Text></Pressable>
                </View>
                <ScrollView style={{ paddingHorizontal: 8 }}>
                  <Text style={{ color: '#333', lineHeight: 20, marginBottom: 16 }}>{PRIVACY_TEXT}</Text>
                </ScrollView>
              </View>
            </View>
          )}
        </View>
      )}

      <View style={[styles.nav, { backgroundColor: theme.colors.navBg }] }>
        <Tab label="Home" active={tab === "Home"} onPress={() => navigateTo("Home")} theme={theme} styles={styles} />
        <Tab
          label="Scoreboard"
          active={tab === "Scoreboard"}
          onPress={() => navigateTo("Scoreboard")}
          theme={theme}
          styles={styles}
        />
        {currentUser && (
          <>
            <Tab
              label="Stats"
              active={tab === "Weekly"}
              onPress={() => navigateTo("Weekly")}
              theme={theme}
              styles={styles}
            />
            <Tab
              label="Profile"
              active={tab === "Profile"}
              onPress={() => navigateTo("Profile")}
              theme={theme}
              styles={styles}
            />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

/* ---------- Screens ---------- */

const LoginForm = ({ onSubmit, styles }) => {
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [faceIdEnabled, setFaceIdEnabled] = useState(false);
  const [faceIdAvailable, setFaceIdAvailable] = useState(false);
  const [faceIdAttempt, setFaceIdAttempt] = useState(false);
  const LocalAuthentication = require('expo-local-authentication');

  useEffect(() => {
    (async () => {
      const available = await LocalAuthentication.hasHardwareAsync();
      const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
      setFaceIdAvailable(available && types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION));
      // Check if user previously enabled FaceID
      const enabled = await AsyncStorage.getItem('FACEID_ENABLED');
      setFaceIdEnabled(enabled === '1');
    })();
  }, []);

  const handleFaceIdLogin = async () => {
    setFaceIdAttempt(true);
    try {
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Login with FaceID' });
      if (result.success) {
        // Retrieve saved credentials
        const savedEmail = await AsyncStorage.getItem('FACEID_EMAIL');
        const savedPassword = await AsyncStorage.getItem('FACEID_PASSWORD');
        if (savedEmail && savedPassword) {
          setForm({ email: savedEmail, password: savedPassword });
          handleSubmit(savedEmail, savedPassword, true);
        } else {
          setError('No saved credentials. Please login normally first.');
        }
      } else {
        setError('FaceID authentication failed.');
      }
    } catch (e) {
      setError('FaceID error: ' + e.message);
    } finally {
      setFaceIdAttempt(false);
    }
  };

  const handleSubmit = async (overrideEmail, overridePassword, isFaceId) => {
    try {
      setError("");
      setLoading(true);
      const credentials = isFaceId
        ? { email: overrideEmail, password: overridePassword }
        : form;
      const { user, error: loginError } = await supabaseSignIn(credentials);
      if (loginError) {
        console.error('Login failed:', loginError);
        setError(loginError.message);
      } else {
        console.log('Login successful, userId:', user?.id);
        onSubmit(user);
        // If user checked FaceID, save credentials
        if (faceIdAvailable && !faceIdEnabled && !isFaceId && form.email && form.password) {
          await AsyncStorage.setItem('FACEID_ENABLED', '1');
          await AsyncStorage.setItem('FACEID_EMAIL', form.email);
          await AsyncStorage.setItem('FACEID_PASSWORD', form.password);
          setFaceIdEnabled(true);
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View>
        <Label text="Email" styles={styles} />
        <TextInput
          style={[styles.input]}
          value={form.email}
          onChangeText={(text) => setForm(f => ({ ...f, email: text }))}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <View>
        <Label text="Password" styles={styles} />
        <TextInput
          style={[styles.input]}
          value={form.password}
          onChangeText={(text) => setForm(f => ({ ...f, password: text }))}
          secureTextEntry
        />
      </View>
      {faceIdAvailable && !faceIdEnabled && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
          <Pressable onPress={() => setFaceIdEnabled(!faceIdEnabled)} style={{ marginRight: 8 }}>
            <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 1.5, borderColor: '#888', alignItems: 'center', justifyContent: 'center', backgroundColor: faceIdEnabled ? '#1e90ff' : 'transparent' }}>
              {faceIdEnabled ? <Text style={{ color: 'white', fontWeight: '800' }}>✓</Text> : null}
            </View>
          </Pressable>
          <Text style={{ color: '#222' }}>Enable FaceID for future logins</Text>
        </View>
      )}
      {faceIdAvailable && faceIdEnabled && (
        <Pressable
          style={[styles.btnBlue, faceIdAttempt && styles.btnDisabled]}
          onPress={handleFaceIdLogin}
          disabled={faceIdAttempt}
        >
          <Text style={styles.btnTxt}>{faceIdAttempt ? 'Authenticating...' : 'Login with FaceID'}</Text>
        </Pressable>
      )}
      <Pressable
        style={[styles.btnBlue, loading && styles.btnDisabled]}
        onPress={() => handleSubmit()}
        disabled={loading}
      >
        <Text style={styles.btnTxt}>{loading ? "Logging in..." : "Login"}</Text>
      </Pressable>
    </View>
  );
};

const SignUpForm = ({ onSubmit, styles }) => {
  const [form, setForm] = useState({ email: "", password: "", username: "", displayName: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [debugCode, setDebugCode] = useState(null);
  const [lastReport, setLastReport] = useState(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [hasStoredDiag, setHasStoredDiag] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('LAST_SIGNUP_ERROR');
        setHasStoredDiag(!!raw);
        if (raw) setLastReport(JSON.parse(raw));
      } catch {}
    })();
  }, []);

  // Persist last failure for diagnostics and generate a compact support code
  const recordFailure = async (stage, details) => {
    const stamp = new Date().toISOString();
    const report = { stage, stamp, details, email: form.email, username: form.username };
    try { await AsyncStorage.setItem('LAST_SIGNUP_ERROR', JSON.stringify(report)); } catch {}
    const mini = `${stage.toUpperCase()}-${stamp.slice(11,19).replace(/:/g,'')}`; // e.g. AUTH-142233
    setDebugCode(mini);
    console.warn('Signup failure report:', report);
  };

  const handleSubmit = async () => {
    try {
      // Enhanced validation
      if (!form.username.trim()) {
        setError("Username is required");
        return;
      }
      if (form.username.length < 3) {
        setError("Username must be at least 3 characters");
        return;
      }
      if (form.username.length > 20) {
        setError("Username must be less than 20 characters");
        return;
      }
      if (!/^[a-zA-Z0-9_]+$/.test(form.username)) {
        setError("Username can only contain letters, numbers, and underscores");
        return;
      }
      if (!form.email.trim()) {
        setError("Email is required");
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
        setError("Please enter a valid email address");
        return;
      }
      if (!form.password.trim()) {
        setError("Password is required");
        return;
      }
      if (form.password.length < 6) {
        setError("Password must be at least 6 characters");
        return;
      }
      if (!agreed) {
        setError("You must agree to the Terms of Service and Privacy Policy to create an account.");
        return;
      }
      setError("");
      setLoading(true);
      // Pre-check username availability to avoid profile insert failures
      try {
        const { available, error: unameError } = await isUsernameAvailable(form.username);
        if (unameError) {
          console.warn('Username availability check failed:', unameError);
        } else if (!available) {
          setError('This username is already taken. Please choose another.');
          await AsyncStorage.setItem('LAST_SIGNUP_ERROR', JSON.stringify({
            stage: 'username_taken',
            stamp: new Date().toISOString(),
            email: form.email,
            username: form.username,
            details: { note: 'Pre-check found existing username' }
          }));
          return;
        }
      } catch {}
      const { user, session, error: signUpError } = await supabaseSignUp(form);
      if (signUpError) {
        const msg = signUpError.message || '';
        if (msg.includes('already registered')) {
          setError("This email is already registered. Try logging in instead.");
        } else if (msg.toLowerCase().includes('network')) {
          setError("Network error. Please check your connection and try again.");
        } else if (msg.toLowerCase().includes('password')) {
          setError('Password does not meet requirements.');
        } else {
          setError(msg);
        }
        recordFailure('auth', { supabaseMessage: msg, code: signUpError.code, status: signUpError.status });
      } else if (user) {
        // User created successfully - proceed regardless of session status
        console.log('User created:', user.id, 'Session:', session ? 'yes' : 'no');
        
        // Create profile in Supabase with display name
        const { data: profileData, error: profileError } = await createUserProfile({ 
          id: user.id, 
          email: form.email, 
          username: form.username,
          display_name: form.displayName || form.username
        });
        if (profileError) {
          console.error('Profile creation failed:', profileError);
          if (profileError.message?.includes('unique') || profileError.code === '23505') {
            setError("This username is already taken. Please choose another.");
          } else if (profileError.message?.includes('permission') || profileError.code === '42501') {
            setError("Permission error. Please contact support.");
          } else {
            setError(`Failed to create user profile: ${profileError.message || 'Unknown error'}`);
          }
          recordFailure('profile_insert', { profileError: profileError.message, code: profileError.code, userId: user.id });
          setLoading(false);
          return;
        }
        
        try {
          await supabaseUpdateUserMetadata({
            accepted_terms_version: LEGAL_VERSION,
            accepted_terms_at: new Date().toISOString(),
          });
        } catch (e) {
          console.warn('Failed to store legal acceptance in metadata', e);
        }
        
        // Allow user in regardless of email verification
        onSubmit(user);
      } else {
        setError("Something went wrong. Please try again.");
        recordFailure('unknown', { note: 'No user or explicit error returned from signUp.' });
      }
    } catch (err) {
      if (err.message?.includes('Network request failed') || err.message?.includes('fetch')) {
        setError("No internet connection. Please check your network and try again.");
      } else {
        setError(err.message || "An unexpected error occurred");
      }
      recordFailure('exception', { errorMessage: err.message, stack: err.stack?.slice(0,300) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      {error ? <Text style={styles.error}>{error}{debugCode ? ` (Code: ${debugCode})` : ''}</Text> : null}
      {/* If pending email verification, show a resend button */}
      {error?.startsWith('Account created! Please verify your email') && (
        <Pressable
          style={[styles.btnBlue, { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 }]}
          onPress={async () => {
            try {
              const email = form.email;
              if (!email) return;
              const { error: rvErr } = await resendVerificationEmail(email);
              if (rvErr) {
                Alert.alert('Resend Failed', rvErr.message || 'Could not resend verification email.');
              } else {
                Alert.alert('Sent', 'Verification email resent. Check your inbox.');
              }
            } catch (e) {
              Alert.alert('Error', e.message || 'Unexpected error while resending email');
            }
          }}
        >
          <Text style={styles.btnTxt}>Resend verification email</Text>
        </Pressable>
      )}
      {/* Diagnostics toggle (only shown if a debug code exists) */}
      {(debugCode || hasStoredDiag) && (
        <Pressable
          onPress={async () => {
            if (!showDiagnostics) {
              try {
                const raw = await AsyncStorage.getItem('LAST_SIGNUP_ERROR');
                if (raw) setLastReport(JSON.parse(raw));
              } catch {}
            }
            setShowDiagnostics(s => !s);
          }}
          style={{ alignSelf: 'center', marginBottom: 4 }}
        >
          <Text style={{ color: '#60a5fa', fontSize: 12 }}>{showDiagnostics ? 'Hide details ▲' : (debugCode ? 'Show technical details ▼' : 'View last signup error ▼')}</Text>
        </Pressable>
      )}
      {showDiagnostics && lastReport && (
        <View style={[styles.card, { backgroundColor: '#111', borderWidth: 1, borderColor: '#333' }]}>
          <Text style={{ color: '#fff', fontSize: 12, marginBottom: 4 }}>Stage: {lastReport.stage}</Text>
          <Text style={{ color: '#fff', fontSize: 12, marginBottom: 4 }}>Timestamp: {lastReport.stamp}</Text>
          <Text style={{ color: '#fff', fontSize: 12, marginBottom: 4 }}>Email: {lastReport.email}</Text>
          <Text style={{ color: '#fff', fontSize: 12, marginBottom: 8 }}>Username: {lastReport.username}</Text>
          <Text style={{ color: '#9ca3af', fontSize: 11, marginBottom: 8 }}>Details: {JSON.stringify(lastReport.details)}</Text>
          {/* Simple copy shim: select JSON string manually if needed (removed Clipboard dependency) */}
          <Text style={{ color: '#666', fontSize: 10, marginTop: 4 }}>Select text above to copy.</Text>
        </View>
      )}
      <View>
        <Label text="Display Name (optional)" styles={styles} />
        <TextInput
          style={[styles.input]}
          value={form.displayName}
          onChangeText={(text) => setForm(f => ({ ...f, displayName: text }))}
          autoCorrect={false}
          placeholder="How others see you"
        />
      </View>
      <View>
        <Label text="Username" styles={styles} />
        <TextInput
          style={[styles.input]}
          value={form.username}
          onChangeText={(text) => setForm(f => ({ ...f, username: text }))}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Your unique username"
        />
      </View>
      <View>
        <Label text="Email" styles={styles} />
        <TextInput
          style={[styles.input]}
          value={form.email}
          onChangeText={(text) => setForm(f => ({ ...f, email: text }))}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <View>
        <Label text="Password" styles={styles} />
        <TextInput
          style={[styles.input]}
          value={form.password}
          onChangeText={(text) => setForm(f => ({ ...f, password: text }))}
          secureTextEntry
        />
      </View>

      {/* Legal acceptance */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <Pressable onPress={() => setAgreed(!agreed)} style={{ marginTop: 2 }}>
          <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 1.5, borderColor: '#888', alignItems: 'center', justifyContent: 'center', backgroundColor: agreed ? '#1e90ff' : 'transparent' }}>
            {agreed ? <Text style={{ color: 'white', fontWeight: '800' }}>✓</Text> : null}
          </View>
        </Pressable>
        <Text style={{ flex: 1, color: '#666' }}>
          I agree to the 
          <Text style={{ color: '#1e90ff', textDecorationLine: 'underline' }} onPress={() => setShowTerms(true)}> Terms of Service</Text>
          
          and 
          <Text style={{ color: '#1e90ff', textDecorationLine: 'underline' }} onPress={() => setShowPrivacy(true)}> Privacy Policy</Text>.
        </Text>
      </View>

      {/* Terms overlay */}
      {showTerms && (
        <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.modal, { backgroundColor: 'white', maxHeight: '80%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.h2}>Terms of Service</Text>
              <Pressable onPress={() => setShowTerms(false)}><Text style={{ fontSize: 20, color: '#666' }}>×</Text></Pressable>
            </View>
            <ScrollView style={{ paddingHorizontal: 8 }}>
              <Text style={{ color: '#333', lineHeight: 20, marginBottom: 16 }}>{TERMS_TEXT}</Text>
            </ScrollView>
          </View>
        </View>
      )}

      {/* Privacy overlay */}
      {showPrivacy && (
        <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.modal, { backgroundColor: 'white', maxHeight: '80%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.h2}>Privacy Policy</Text>
              <Pressable onPress={() => setShowPrivacy(false)}><Text style={{ fontSize: 20, color: '#666' }}>×</Text></Pressable>
            </View>
            <ScrollView style={{ paddingHorizontal: 8 }}>
              <Text style={{ color: '#333', lineHeight: 20, marginBottom: 16 }}>{PRIVACY_TEXT}</Text>
            </ScrollView>
          </View>
        </View>
      )}
      <Pressable
        style={[styles.btnBlue, loading && styles.btnDisabled]}
        onPress={handleSubmit}
        disabled={loading}
      >
        <Text style={styles.btnTxt}>{loading ? "Creating Account..." : "Sign Up"}</Text>
      </Pressable>
    </View>
  );
}



const HomeScreen = ({ leagues, currentUser, setTab, onAuthPress, theme, styles }) => {
  const userId = currentUser?.id;
  const [showTutorial, setShowTutorial] = useState(false);
  const [results, setResults] = useState({});
  const [weeklyStats, setWeeklyStats] = useState(null);
  const [homeWeek, setHomeWeek] = useState(null);
  const recomputeRef = useRef(0);
  const prevLockSigRef = useRef('');

  // Shared compute for Home weekly stats
  const computeHomeWeeklyStats = useCallback(async () => {
    if (!currentUser) return;
    try {
      // Calculate current week consistently with LeagueDetails
      const now = new Date();
      const seasonStart2025 = new Date('2025-09-02T00:00:00');
      const diffDays = Math.floor((now - seasonStart2025) / (1000 * 60 * 60 * 24));
      const currentWeek = Math.max(1, Math.min(18, Math.floor(diffDays / 7) + 1));
      setHomeWeek(currentWeek);

      // Client fallback: grade per-league using locked_lines + finals
      // Skip server cache entirely and compute fresh from current data
      const { data: finals } = await fetchGameResults(currentWeek);
      const gameResults = finals || [];
      
      // If no final games yet, show 0-0
      if (gameResults.length === 0) {
        console.log(`[HomeStats] Week ${currentWeek}: No final games yet`);
        setWeeklyStats({ winPercentage: 0, overallWins: 0, overallLosses: 0 });
        return;
      }
      
      const resultIds = new Set(gameResults.map(g => String(g.game_id)));

      console.log(`[HomeStats] Week ${currentWeek}: ${gameResults.length} final games, ${resultIds.size} unique IDs`);

      let totalWins = 0;
      let totalLosses = 0;
      // Only include leagues the user is a member of
      const myLeagues = (leagues || []).filter((l) => (l.members || []).some(m => (typeof m === 'string' ? m : m?.userId) === userId));
      
      console.log(`[HomeStats] User in ${myLeagues.length} leagues`);
      
      for (const league of myLeagues) {
        // Build picks array for this league and current user, filtered to current week games
        const picksArray = [];
        const picksByUser = league.picks || {};
        const userPicks = picksByUser[userId] || {};
        Object.entries(userPicks).forEach(([gameId, pickObj]) => {
          if (!resultIds.has(String(gameId))) return; // only current week finals
          // Align with league behavior: only count games that have locked lines
          const locked = league.locked_lines || {};
          const lockedEntry = locked[String(gameId)] || locked[gameId];
          if (!lockedEntry || (!lockedEntry.spread && !lockedEntry.overUnder)) return;
          picksArray.push({
            user_id: userId,
            game_id: String(gameId),
            spread: pickObj.spread || null,
            total: pickObj.total || null,
            winner: pickObj.winner || null,
          });
        });
        
        if (picksArray.length === 0) {
          console.log(`[HomeStats] League ${league.code}: no picks for final games`);
          continue;
        }
        
        console.log(`[HomeStats] League ${league.code}: grading ${picksArray.length} picks`);
        
        const score = computeWeeklyPointsClientSide(league, picksArray, gameResults, userId);
        
        // Only count if games were actually graded (not just picked)
        if ((score.games_graded || 0) === 0) {
          console.log(`[HomeStats] League ${league.code}: 0 games graded (skipping)`);
          continue;
        }
        
        const leagueWins = (score.winner_correct || 0) + (score.spread_correct || 0) + (score.total_correct || 0);
        const leagueLosses = (score.winner_incorrect || 0) + (score.spread_incorrect || 0) + (score.total_incorrect || 0);
        
        console.log(`[HomeStats] League ${league.code}: ${leagueWins}-${leagueLosses} (${score.games_graded} graded)`);
        
        totalWins += leagueWins;
        totalLosses += leagueLosses;
      }

      console.log(`[HomeStats] Total: ${totalWins}-${totalLosses}`);

      const totalPicks = totalWins + totalLosses;
      const winPercentage = totalPicks > 0 ? Math.round((totalWins / totalPicks) * 100) : 0;
      setWeeklyStats({ winPercentage, overallWins: totalWins, overallLosses: totalLosses });
    } catch (err) {
      console.warn('Weekly aggregate fallback failed:', err);
      setWeeklyStats({ winPercentage: 0, overallWins: 0, overallLosses: 0 });
    }
  }, [leagues, currentUser, userId]);
  
  // Compute on mount/leagues/currentUser changes
  useEffect(() => {
    computeHomeWeeklyStats();
  }, [computeHomeWeeklyStats]);

  // Recompute automatically when final results change (same week)
  useEffect(() => {
    if (!homeWeek) return;
    const cleanup = subscribeToFinalResults(homeWeek, 2025, async () => {
      // Throttle rapid updates
      const last = recomputeRef.current;
      const now = Date.now();
      if (now - last < 1000) return; // 1s debounce
      recomputeRef.current = now;
      await computeHomeWeeklyStats();
    });
    return cleanup;
  }, [homeWeek, computeHomeWeeklyStats]);

  // Recompute when locked_lines change (snapshot added) to keep Home in sync
  useEffect(() => {
    if (!homeWeek || !currentUser) return;
    // Build a lightweight signature of locked lines counts per league
    const signature = (leagues || [])
      .filter(l => (l.members || []).some(m => (typeof m === 'string' ? m : m?.userId) === userId))
      .map(l => `${l.code}:${Object.keys(l.locked_lines || {}).length}`)
      .join('|');
    if (prevLockSigRef.current !== signature) {
      prevLockSigRef.current = signature;
      // Debounce similar to finals refresh
      const now = Date.now();
      if (now - recomputeRef.current < 500) return; // tighter debounce for lock changes
      recomputeRef.current = now;
      computeHomeWeeklyStats();
    }
  }, [leagues, homeWeek, computeHomeWeeklyStats, currentUser, userId]);
  
  const myLeagues = leagues.filter((l) => l.members.includes(userId));
  
  return (
    <ScrollView 
      style={{ flex: 1 }} 
      contentContainerStyle={{ paddingBottom: 100 }}
      showsVerticalScrollIndicator={true}
      nestedScrollEnabled={true}
    >
      <View style={styles.screenHeader}>
        <Text style={styles.h1}>Home</Text>
      </View>
      
      {!currentUser ? (
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 40 }]}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>🏈</Text>
          <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 8, textAlign: 'center' }]}>
            Welcome to NFL Pick'em
          </Text>
          <Text style={[styles.muted, { marginBottom: 24, textAlign: 'center', paddingHorizontal: 16 }]}>
            Sign in to create leagues, make picks, and compete with friends!
          </Text>
          <Pressable style={[styles.btnBlue, { paddingHorizontal: 32, paddingVertical: 12 }]} onPress={onAuthPress}>
            <Text style={styles.btnTxt}>Login / Sign Up</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {/* Quick Actions */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            <Pressable
              style={[styles.card, { flex: 1, backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 16 }]}
              onPress={() => setTab('Leagues')}
            >
              <Text style={{ fontSize: 22, marginBottom: 6 }}>📝</Text>
              <Text style={{ color: theme?.colors?.text, fontWeight: '600' }}>Make Picks</Text>
            </Pressable>
            <Pressable
              style={[styles.card, { flex: 1, backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 16 }]}
              onPress={() => setTab('Scoreboard')}
            >
              <Text style={{ fontSize: 22, marginBottom: 6 }}>📺</Text>
              <Text style={{ color: theme?.colors?.text, fontWeight: '600' }}>Scoreboard</Text>
            </Pressable>
          </View>

          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            <Pressable
              style={[styles.card, { flex: 1, backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 16 }]}
              onPress={() => setTab('Leaderboard')}
            >
              <Text style={{ fontSize: 22, marginBottom: 6 }}>🏆</Text>
              <Text style={{ color: theme?.colors?.text, fontWeight: '600' }}>Leaderboard</Text>
            </Pressable>
            <Pressable
              style={[styles.card, { flex: 1, backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 16 }]}
              onPress={() => setTab('Friends')}
            >
              <Text style={{ fontSize: 22, marginBottom: 6 }}>👥</Text>
              <Text style={{ color: theme?.colors?.text, fontWeight: '600' }}>Friends</Text>
            </Pressable>
          </View>

          {/* Your Week at a Glance */}
          {leagues.length > 0 && weeklyStats && (
            <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 12 }]}> 
              <Text style={{ color: theme?.colors?.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>
                THIS WEEK
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', gap: 16, flex: 1 }}>
                  <View style={{ flex: 1, alignItems: 'center' }}>
                    <Text style={{ fontSize: 26, fontWeight: '800', color: theme?.colors?.text }}>
                      {weeklyStats.winPercentage || 0}%
                    </Text>
                    <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>Win %</Text>
                  </View>
                  <View style={{ flex: 1, alignItems: 'center' }}>
                    <Text style={{ fontSize: 26, fontWeight: '800', color: theme?.colors?.text }}>
                      {weeklyStats.overallWins || 0}-{weeklyStats.overallLosses || 0}
                    </Text>
                    <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>Record</Text>
                  </View>
                </View>
                <Pressable
                  style={[styles.btnBlue, { paddingHorizontal: 16, paddingVertical: 10 }]}
                  onPress={() => setTab('Weekly')}
                >
                  <Text style={styles.btnTxt}>View Stats</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* Tutorial Modal */}
          {showTutorial && (
            <View style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.85)',
              zIndex: 1000,
              padding: 20,
              justifyContent: 'center',
            }}>
              <View style={[styles.card, { backgroundColor: theme?.colors?.card, maxHeight: '80%' }]}>
                <ScrollView>
                  <Text style={[styles.h1, { color: theme?.colors?.text, marginBottom: 16, textAlign: 'center' }]}>
                    📚 Quick Start Guide
                  </Text>
                  
                  <View style={{ marginBottom: 20 }}>
                    <Text style={{ color: theme?.colors?.primary, fontSize: 18, fontWeight: '700', marginBottom: 8 }}>
                      1️⃣ Create or Join a League
                    </Text>
                    <Text style={{ color: theme?.colors?.text, lineHeight: 20 }}>
                      Tap "Create/Join League" to start your own league or enter a code to join an existing one. You can be in multiple leagues at once!
                    </Text>
                  </View>

                  <View style={{ marginBottom: 20 }}>
                    <Text style={{ color: theme?.colors?.primary, fontSize: 18, fontWeight: '700', marginBottom: 8 }}>
                      2️⃣ Make Your Picks
                    </Text>
                    <Text style={{ color: theme?.colors?.text, lineHeight: 20, marginBottom: 8 }}>
                      Select spreads and over/unders for each game. You can edit picks until 1 hour before game time.
                    </Text>
                    <Text style={{ color: theme?.colors?.success, fontSize: 14, fontWeight: '600', marginBottom: 4 }}>
                      💡 Pro Tip: Cross-League Syncing
                    </Text>
                    <Text style={{ color: theme?.colors?.text, lineHeight: 18, fontSize: 13 }}>
                      In multiple leagues of the same type? Enable "Sync Picks Across Leagues" in Profile settings to automatically copy your picks to all similar leagues. Make picks once, compete everywhere!
                    </Text>
                  </View>

                  <View style={{ marginBottom: 20 }}>
                    <Text style={{ color: theme?.colors?.primary, fontSize: 18, fontWeight: '700', marginBottom: 8 }}>
                      3️⃣ Never Miss a Week
                    </Text>
                    <Text style={{ color: theme?.colors?.text, lineHeight: 20, marginBottom: 8 }}>
                      Life gets busy! Set up Auto-Picks in Profile settings to automatically make picks when lines lock if you haven't picked yet.
                    </Text>
                    <Text style={{ color: theme?.colors?.muted, fontSize: 12, fontStyle: 'italic' }}>
                      Choose from strategies like favorites, underdogs, home teams, or let the system pick randomly.
                    </Text>
                  </View>

                  <View style={{ marginBottom: 20 }}>
                    <Text style={{ color: theme?.colors?.primary, fontSize: 18, fontWeight: '700', marginBottom: 8 }}>
                      4️⃣ Track Your Performance
                    </Text>
                    <Text style={{ color: theme?.colors?.text, lineHeight: 20 }}>
                      Check the Scoreboard for live results and the Stats tab for your overall performance. Your stats count unique picks, not duplicates across leagues!
                    </Text>
                  </View>

                  <View style={{ marginBottom: 20 }}>
                    <Text style={{ color: theme?.colors?.primary, fontSize: 18, fontWeight: '700', marginBottom: 8 }}>
                      5️⃣ Chat with League Members
                    </Text>
                    <Text style={{ color: theme?.colors?.text, lineHeight: 20 }}>
                      Use the Chat tab in each league to trash talk, discuss picks, and celebrate wins!
                    </Text>
                  </View>

                  <Pressable
                    style={[styles.btnGreen, { marginTop: 16 }]}
                    onPress={() => setShowTutorial(false)}
                  >
                    <Text style={styles.btnTxt}>Got It! Let's Play</Text>
                  </Pressable>
                </ScrollView>
              </View>
            </View>
          )}

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={[styles.h2, { color: theme?.colors?.text }]}>Your Leagues</Text>
            <Pressable onPress={() => setShowTutorial(true)}>
              <Text style={{ color: theme?.colors?.primary, fontSize: 24 }}>❓</Text>
            </Pressable>
          </View>
          
          {myLeagues.length === 0 ? (
            <View style={[styles.card, { backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 40 }]}>
              <Text style={{ fontSize: 48, marginBottom: 16 }}>🏈</Text>
              <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 8 }]}>
                No Leagues Yet
              </Text>
              <Text style={[styles.muted, { marginBottom: 16, textAlign: 'center' }]}>
                Create your first league or join an existing one to get started!
              </Text>
              <Pressable
                style={[styles.btnGreen, { paddingHorizontal: 24, paddingVertical: 12 }]}
             onPress={() => setTab("Leagues")}
              >
             <Text style={styles.btnTxt}>Create/Join League</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ gap: 12 }}>
              {myLeagues.map((league) => {
                // Compute user's win% in this league
                const s = computeUserStats({ leagues: [league], userId, results, pickType: 'all', timePeriod: 'allTime' });
                const winPercentage = s.winPercentage || 0;

                // Compute rank among league members
                const memberStats = league.members.map(mid => {
                  const ms = computeUserStats({ leagues: [league], userId: mid, results, pickType: 'all', timePeriod: 'allTime' });
                  return { userId: mid, winPercentage: ms.winPercentage || 0, wins: ms.overallWins || 0 };
                }).sort((a, b) => (b.winPercentage - a.winPercentage) || (b.wins - a.wins));

                const standing = Math.max(1, memberStats.findIndex(m => m.userId === userId) + 1);
                const totalMembers = league.members.length;

                return (
                  <Pressable
                    key={league.code}
                    style={[styles.card, { backgroundColor: theme?.colors?.card || '#fff' }]}
                    onPress={() => setTab(`LeagueDetails:${league.code}`)}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={{ fontWeight: "700", fontSize: 18, color: theme?.colors?.text }}>{league.name}</Text>
                        {/* League Type Badge */}
                        <View style={{ 
                          backgroundColor: theme?.colors?.primary || '#2563eb', 
                          paddingHorizontal: 8, 
                          paddingVertical: 3, 
                          borderRadius: 4,
                          alignSelf: 'flex-start',
                          marginTop: 4
                        }}>
                          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }}>
                            {(() => {
                              const { LEAGUE_TYPE_DETAILS } = require('./leagueTypes');
                              const typeDetails = LEAGUE_TYPE_DETAILS[league.type];
                              return typeDetails?.name || 'League';
                            })()}
                          </Text>
                        </View>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ fontSize: 12, color: theme?.colors?.muted || '#6b7280' }}>Standing</Text>
                        <Text style={{ fontWeight: '700', fontSize: 16, color: theme?.colors?.primary || '#2563eb' }}>
                          {standing}/{totalMembers}
                        </Text>
                      </View>
                    </View>
                    
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View>
                        <Text style={{ fontSize: 12, color: theme?.colors?.muted || '#6b7280' }}>Win %</Text>
                        <Text style={{ fontWeight: '600', fontSize: 16, color: theme?.colors?.text }}>
                          {winPercentage}%
                        </Text>
                      </View>
                      
                      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                        <Text style={{ fontSize: 12, color: theme?.colors?.muted }}>
                          {league.members.length} member{league.members.length !== 1 ? 's' : ''}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                );
              })}
              
              <View style={{ alignItems: "center", marginTop: 16 }}>
                <Pressable
                  style={[styles.btnGreen, { paddingHorizontal: 24, paddingVertical: 12 }]}
                    onPress={() => setTab("Leagues")}
                >
                    <Text style={styles.btnTxt}>Create/Join League</Text>
                </Pressable>
              </View>
            </View>
          )}
        </>
      )}
      
      <AppFooter theme={theme} styles={styles} />
    </ScrollView>
  );
};

const LeagueDetailsScreen = ({ leagueCode, leagues, setLeagues, currentUser, setTab, theme, styles }) => {
  const league = leagues.find((l) => l.code === leagueCode);
  const userId = currentUser?.id;
  const [showChat, setShowChat] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePhone, setInvitePhone] = useState("");
  const [activeTab, setActiveTab] = useState('standings'); // standings, chat, history
  const [standingsFilter, setStandingsFilter] = useState('all'); // 'all' or 'friends'
  const [results, setResults] = useState({});
  const [memberNames, setMemberNames] = useState(new Map()); // id -> { display_name, username }
  const [friends, setFriends] = useState([]); // Load friends list
  const [showInviteFriends, setShowInviteFriends] = useState(false);
  const [inviteSending, setInviteSending] = useState(false);
  const [weeklyPointsRows, setWeeklyPointsRows] = useState([]); // server weekly_points rows for this league
  const [fallbackWeekScores, setFallbackWeekScores] = useState(null); // client-computed fallback per member
  const [currentWeek, setCurrentWeek] = useState(null);

  // Load friends list
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { loadFriends } = await import('./storage');
        const data = await loadFriends(userId);
        if (mounted) {
          const friendIds = (data.friends || []).map(f => f.userId);
          setFriends(friendIds);
        }
      } catch (e) {
        console.warn('Failed to load friends:', e);
      }
    })();
    return () => { mounted = false; };
  }, [userId]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const r = await loadResults();
        if (mounted) setResults(r || {});
      } catch {}
    })();
    return () => { mounted = false; };
  }, [leagueCode]);

  // Loader to refresh weekly standings (server weekly_points first, else client fallback)
  const loadLeagueWeekData = useCallback(async (wk) => {
    if (!league) return;
    const { data, error } = await fetchWeeklyPoints(league.code, wk);
    if (!error && data && data.length > 0) {
      setWeeklyPointsRows(data);
      setFallbackWeekScores(null);
      return;
    }
    try {
      const { data: finals } = await fetchGameResults(wk);
      const gameResults = finals || [];
      const validIds = new Set(gameResults.map(g => String(g.game_id)));
      const picksArray = [];
      const picksByUser = league.picks || {};
      Object.keys(picksByUser).forEach(uId => {
        Object.entries(picksByUser[uId] || {}).forEach(([gameId, pickObj]) => {
          if (!validIds.has(String(gameId))) return;
          picksArray.push({
            user_id: uId,
            game_id: String(gameId),
            spread: pickObj.spread || null,
            total: pickObj.total || null,
            winner: pickObj.winner || null,
          });
        });
      });
      const scores = {};
      (league.members || []).forEach(member => {
        const memberId = typeof member === 'string' ? member : member?.userId;
        if (!memberId) return;
        scores[memberId] = computeWeeklyPointsClientSide(league, picksArray, gameResults, memberId);
      });
      setWeeklyPointsRows([]);
      setFallbackWeekScores(scores);
    } catch (e) {
      console.warn('League weekly fallback compute failed:', e);
    }
  }, [league]);

  // Determine current NFL week (same logic as HomeScreen) and load weekly_points for this league
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!league) return;
      const now = new Date();
      const seasonStart2025 = new Date('2025-09-02T00:00:00');
      const diffDays = Math.floor((now - seasonStart2025) / (1000 * 60 * 60 * 24));
      const wk = Math.max(1, Math.min(18, Math.floor(diffDays / 7) + 1));
      if (mounted) setCurrentWeek(wk);
      if (!mounted) return;
      await loadLeagueWeekData(wk);
    })();
    return () => { mounted = false; };
  }, [leagueCode, leagues, loadLeagueWeekData]);

  // Auto-refresh standings when final results change
  useEffect(() => {
    if (!currentWeek) return;
    const cleanup = subscribeToFinalResults(currentWeek, 2025, async () => {
      await loadLeagueWeekData(currentWeek);
    });
    return cleanup;
  }, [currentWeek, loadLeagueWeekData]);

  // Load member display names/usernames
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!league || !league.members || league.members.length === 0) return;
        const { data: map, error } = await getProfilesByIds(league.members);
        if (!error && mounted) {
          setMemberNames(new Map(map));
        }
      } catch (e) {
        console.warn('Failed to load member profiles:', e);
      }
    })();
    return () => { mounted = false; };
  }, [leagueCode, leagues]);

  const getDisplayLabel = (id) => {
    const p = memberNames.get(id);
    if (p?.display_name) return p.display_name;
    if (p?.username) return p.username;
    return id ? `User ${id.slice(0, 8)}` : 'User';
  };

  if (!league) {
    return (
      <View style={styles.container}>
        <View style={styles.screenHeader}>
          <Pressable onPress={() => setTab("Home")} style={{ marginRight: 8 }}>
            <Text style={{ fontSize: 24, color: theme?.colors?.heading }}>←</Text>
          </Pressable>
          <Text style={styles.h1}>League Not Found</Text>
        </View>
      </View>
    );
  }

  // Weekly per-league standings using weekly_points (preferred) or fallback client compute
  const weeklyPointsMap = new Map();
  weeklyPointsRows.forEach(row => weeklyPointsMap.set(row.user_id, row));
  // Normalize member list to pure userId strings
  const memberIdsNormalized = (league.members || []).map(m => typeof m === 'string' ? m : m?.userId).filter(Boolean);
  const standings = memberIdsNormalized.map(memberId => {
    // Prefer client-computed fallback if it graded any games (more resilient)
    const fallback = fallbackWeekScores?.[memberId];
    if (fallback && (fallback.games_graded || 0) > 0) {
      const wins = (fallback.winner_correct || 0) + (fallback.spread_correct || 0) + (fallback.total_correct || 0);
      const losses = (fallback.winner_incorrect || 0) + (fallback.spread_incorrect || 0) + (fallback.total_incorrect || 0);
      const totalPicks = fallback.games_picked || (wins + losses + (fallback.spread_push || 0) + (fallback.total_push || 0));
      const winPercentage = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : 0;
      return { userId: memberId, username: getDisplayLabel(memberId), wins, losses, totalPicks, winPercentage };
    }
    // Otherwise fall back to server weekly_points if present
    const serverRow = weeklyPointsMap.get(memberId);
    if (serverRow) {
      const wins = (serverRow.winner_correct || 0) + (serverRow.spread_correct || 0) + (serverRow.total_correct || 0);
      const losses = (serverRow.winner_incorrect || 0) + (serverRow.spread_incorrect || 0) + (serverRow.total_incorrect || 0);
      const totalPicks = wins + losses + (serverRow.spread_push || 0) + (serverRow.total_push || 0);
      const winPercentage = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : 0;
      return { userId: memberId, username: getDisplayLabel(memberId), wins, losses, totalPicks, winPercentage };
    }
    // No data yet
    return { userId: memberId, username: getDisplayLabel(memberId), wins: 0, losses: 0, totalPicks: 0, winPercentage: 0 };
  }).sort((a, b) => (b.winPercentage - a.winPercentage) || (b.wins - a.wins));

  const userRank = standings.findIndex((s) => s.userId === userId) + 1;

  // Build list of friend IDs not already in league for invite modal
  const friendsEligible = friends.filter(fid => !league.members.includes(fid) && fid !== userId);

  const handleSendInvite = async (friendId) => {
    try {
      setInviteSending(true);
      const { data, error } = await createInvite({ league_code: league.code, inviter_id: userId, invitee_id: friendId });
      if (error) {
        Alert.alert('Invite Failed', error.message || 'Unable to send invite');
      } else {
        Alert.alert('Invite Sent', 'Your friend will see this invite in the Friends screen.');
      }
    } catch (e) {
      Alert.alert('Error', e.message || 'Unexpected error sending invite');
    } finally {
      setInviteSending(false);
    }
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.screenHeader}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
            <Pressable onPress={() => setTab("Home")} style={{ marginRight: 8 }}>
              <Text style={{ fontSize: 24, color: theme?.colors?.heading }}>←</Text>
            </Pressable>
            <Text style={[styles.h1, { marginBottom: 0, flex: 1 }]}>{league.name}</Text>
          </View>
          <Pressable onPress={() => setTab(`LeagueSettings:${leagueCode}`)} style={{ padding: 8 }}>
            <Text style={{ fontSize: 24, color: theme?.colors?.heading }}>⚙️</Text>
          </Pressable>
        </View>
        <Text style={{ color: theme?.colors?.muted, marginTop: 4 }}>
          Code: {league.code} • {league.members.length} members
        </Text>
      </View>

      {/* Make Picks Button */}
      <Pressable 
        style={[styles.btnBlue, { marginBottom: 16 }]} 
        onPress={() => setTab(`Picks:${league.code}`)}
      >
        <Text style={styles.btnTxt}>Make Picks</Text>
      </Pressable>

      {/* Invite Friends Button */}
      <Pressable
        style={[styles.btnGreen, { marginBottom: 16 }]}
        onPress={() => setShowInviteFriends(true)}
      >
        <Text style={styles.btnTxt}>Invite Friends</Text>
      </Pressable>

      {/* Tab Navigation */}
      <View style={{ flexDirection: 'row', marginBottom: 16, borderBottomWidth: 1, borderBottomColor: theme?.colors?.border }}>
        <Pressable
          style={[
            { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: activeTab === 'standings' ? theme?.colors?.primary : 'transparent' }
          ]}
          onPress={() => setActiveTab('standings')}
        >
          <Text style={{ color: activeTab === 'standings' ? theme?.colors?.primary : theme?.colors?.muted, fontWeight: '600', fontSize: 13 }}>
            Leaderboard
          </Text>
        </Pressable>
        <Pressable
          style={[
            { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: activeTab === 'season' ? theme?.colors?.primary : 'transparent' }
          ]}
          onPress={() => setActiveTab('season')}
        >
          <Text style={{ color: activeTab === 'season' ? theme?.colors?.primary : theme?.colors?.muted, fontWeight: '600', fontSize: 13 }}>
            Season
          </Text>
        </Pressable>
        <Pressable
          style={[
            { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: activeTab === 'chat' ? theme?.colors?.primary : 'transparent' }
          ]}
          onPress={() => setActiveTab('chat')}
        >
          <Text style={{ color: activeTab === 'chat' ? theme?.colors?.primary : theme?.colors?.muted, fontWeight: '600', fontSize: 13 }}>
            Chat
          </Text>
        </Pressable>
        <Pressable
          style={[
            { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: activeTab === 'history' ? theme?.colors?.primary : 'transparent' }
          ]}
          onPress={() => setActiveTab('history')}
        >
          <Text style={{ color: activeTab === 'history' ? theme?.colors?.primary : theme?.colors?.muted, fontWeight: '600', fontSize: 13 }}>
            History
          </Text>
        </Pressable>
      </View>

      {/* Standings Tab */}
      {activeTab === 'standings' && (
        <>
          {/* Standings Header with Filter */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 0 }]}>Standings</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: standingsFilter === 'all' ? theme?.colors?.primary : theme?.colors?.card,
                  borderWidth: 1,
                  borderColor: standingsFilter === 'all' ? theme?.colors?.primary : theme?.colors?.border,
                }}
                onPress={() => setStandingsFilter('all')}
              >
                <Text style={{ 
                  color: standingsFilter === 'all' ? '#fff' : theme?.colors?.text, 
                  fontSize: 12, 
                  fontWeight: '600' 
                }}>
                  All
                </Text>
              </Pressable>
              <Pressable
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: standingsFilter === 'friends' ? theme?.colors?.primary : theme?.colors?.card,
                  borderWidth: 1,
                  borderColor: standingsFilter === 'friends' ? theme?.colors?.primary : theme?.colors?.border,
                }}
                onPress={() => setStandingsFilter('friends')}
              >
                <Text style={{ 
                  color: standingsFilter === 'friends' ? '#fff' : theme?.colors?.text, 
                  fontSize: 12, 
                  fontWeight: '600' 
                }}>
                  Friends
                </Text>
              </Pressable>
            </View>
          </View>
          
          {/* Filter standings based on selected filter */}
          {(() => {
            const filteredStandings = standingsFilter === 'friends'
              ? standings.filter(member => friends.includes(member.userId) || member.userId === userId)
              : standings;

            if (filteredStandings.length === 0) {
              return (
                <View style={[styles.card, { backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 30 }]}>
                  <Text style={{ fontSize: 32, marginBottom: 8 }}>👥</Text>
                  <Text style={{ color: theme?.colors?.text, fontSize: 16, fontWeight: '600', marginBottom: 4 }}>
                    No Friends in This League
                  </Text>
                  <Text style={{ color: theme?.colors?.muted, fontSize: 14, textAlign: 'center' }}>
                    Add friends or invite them to join this league!
                  </Text>
                </View>
              );
            }

            const allZero = filteredStandings.every(m => (m.wins || 0) === 0 && (m.losses || 0) === 0);
            if (allZero) {
              return (
                <View style={[styles.card, { backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 20, marginBottom: 8 }]}>
                  <Text style={{ color: theme?.colors?.muted, fontSize: 14 }}>
                    No graded games yet for this week.
                  </Text>
                </View>
              );
            }

            return filteredStandings.map((member, index) => (
              <Pressable
                key={member.userId}
                onPress={() => setTab(`UserProfile:${member.userId}:${member.username}`)}
                style={[
                  styles.card,
                  { 
                    backgroundColor: theme?.colors?.card,
                    borderLeftWidth: 4,
                    borderLeftColor: member.userId === userId ? theme?.colors?.success : friends.includes(member.userId) ? theme?.colors?.primary : 'transparent',
                  }
                ]}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={{ 
                    fontSize: 20, 
                    fontWeight: '800', 
                    color: index === 0 ? '#fbbf24' : index === 1 ? '#d1d5db' : index === 2 ? '#f97316' : theme?.colors?.muted,
                    width: 40,
                  }}>
                    #{index + 1}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>
                        {member.username}
                        {member.userId === userId && ' (You)'}
                      </Text>
                      {friends.includes(member.userId) && member.userId !== userId && (
                        <Text style={{ fontSize: 12 }}>👥</Text>
                      )}
                    </View>
                    <Text style={{ color: theme?.colors?.muted, fontSize: 14 }}>
                      {member.wins}-{member.losses} • {member.totalPicks} picks
                    </Text>
                  </View>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: theme?.colors?.text }}>
                    {member.winPercentage}%
                  </Text>
                </View>
              </Pressable>
            ));
          })()}
        </>
      )}
      {/* Invite Friends Modal */}
      {showInviteFriends && (
        <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.modal, { backgroundColor: theme.colors.card, maxHeight: '70%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.h2}>Invite Friends</Text>
              <Pressable onPress={() => setShowInviteFriends(false)}><Text style={{ fontSize: 20, color: theme.colors.muted }}>×</Text></Pressable>
            </View>
            <ScrollView style={{ marginBottom: 12 }}>
              {friendsEligible.length === 0 && (
                <Text style={{ color: theme.colors.muted, fontSize: 14 }}>All your friends are already in this league or none available.</Text>
              )}
              {friendsEligible.map(fid => (
                <View key={fid} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
                  <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{getDisplayLabel(fid)}</Text>
                  <Pressable
                    onPress={() => handleSendInvite(fid)}
                    disabled={inviteSending}
                    style={{ backgroundColor: theme.colors.primary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, opacity: inviteSending ? 0.6 : 1 }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '600' }}>{inviteSending ? 'Sending...' : 'Invite'}</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
            <Pressable
              onPress={() => setShowInviteFriends(false)}
              style={[styles.btnBlue, { paddingVertical: 10 }]}
            >
              <Text style={styles.btnTxt}>Close</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Chat Tab */}
        {/* Season Tab */}
        {activeTab === 'season' && (
          <>
            <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 12 }]}>Season Standings</Text>
            <Text style={{ color: theme?.colors?.muted, fontSize: 14, marginBottom: 16 }}>
              Week-by-week performance breakdown for all league members
            </Text>

            {(() => {
              // Group picks and results by week
              const weeklyData = {};
              const memberIds = league.members || [];
            
              // Initialize structure for each member
              memberIds.forEach(memberId => {
                weeklyData[memberId] = {};
              });

              // Process all results in this league
              if (results && results.length > 0) {
                results.forEach(result => {
                  if (result.leagueCode === leagueCode) {
                    const weekKey = result.week || 'Unknown';
                    const memberId = result.userId;
                  
                    if (!weeklyData[memberId]) {
                      weeklyData[memberId] = {};
                    }
                  
                    if (!weeklyData[memberId][weekKey]) {
                      weeklyData[memberId][weekKey] = { wins: 0, losses: 0, pushes: 0 };
                    }
                  
                    if (result.result === 'win') {
                      weeklyData[memberId][weekKey].wins++;
                    } else if (result.result === 'loss') {
                      weeklyData[memberId][weekKey].losses++;
                    } else if (result.result === 'push') {
                      weeklyData[memberId][weekKey].pushes++;
                    }
                  }
                });
              }

              // Get all unique weeks across all members
              const allWeeks = new Set();
              Object.values(weeklyData).forEach(memberWeeks => {
                Object.keys(memberWeeks).forEach(week => allWeeks.add(week));
              });
              const sortedWeeks = Array.from(allWeeks).sort((a, b) => {
                // Extract week numbers for sorting
                const weekNumA = parseInt(a.replace(/\D/g, '')) || 0;
                const weekNumB = parseInt(b.replace(/\D/g, '')) || 0;
                return weekNumA - weekNumB;
              });

              if (sortedWeeks.length === 0) {
                return (
                  <View style={[styles.card, { backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 40 }]}>
                    <Text style={{ fontSize: 40, marginBottom: 12 }}>📊</Text>
                    <Text style={{ color: theme?.colors?.muted, textAlign: 'center' }}>
                      No season data yet. Make picks to see weekly breakdowns!
                    </Text>
                  </View>
                );
              }

              // Calculate cumulative stats for each member
              const cumulativeStats = {};
              memberIds.forEach(memberId => {
                cumulativeStats[memberId] = { totalWins: 0, totalLosses: 0, totalPushes: 0, weeklyRecords: [] };
                sortedWeeks.forEach(week => {
                  const weekStats = weeklyData[memberId]?.[week] || { wins: 0, losses: 0, pushes: 0 };
                  cumulativeStats[memberId].totalWins += weekStats.wins;
                  cumulativeStats[memberId].totalLosses += weekStats.losses;
                  cumulativeStats[memberId].totalPushes += weekStats.pushes;
                  cumulativeStats[memberId].weeklyRecords.push({
                    week,
                    wins: weekStats.wins,
                    losses: weekStats.losses,
                    pushes: weekStats.pushes,
                    cumulativeWins: cumulativeStats[memberId].totalWins,
                    cumulativeLosses: cumulativeStats[memberId].totalLosses,
                  });
                });
              });

              // Render week-by-week table
              return (
                <ScrollView horizontal={true} showsHorizontalScrollIndicator={true} style={{ marginBottom: 16 }}>
                  <View>
                    {/* Header Row */}
                    <View style={{ flexDirection: 'row', borderBottomWidth: 2, borderBottomColor: theme?.colors?.border, paddingBottom: 8, marginBottom: 8 }}>
                      <View style={{ width: 120, paddingRight: 12 }}>
                        <Text style={{ color: theme?.colors?.text, fontWeight: '700', fontSize: 14 }}>Member</Text>
                      </View>
                      {sortedWeeks.map((week, idx) => (
                        <View key={idx} style={{ width: 80, alignItems: 'center', paddingHorizontal: 4 }}>
                          <Text style={{ color: theme?.colors?.text, fontWeight: '600', fontSize: 12 }}>{week}</Text>
                        </View>
                      ))}
                      <View style={{ width: 100, alignItems: 'center', paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: theme?.colors?.border }}>
                        <Text style={{ color: theme?.colors?.text, fontWeight: '700', fontSize: 14 }}>Total</Text>
                      </View>
                    </View>

                    {/* Member Rows */}
                    {memberIds.map(memberId => {
                      const memberStats = cumulativeStats[memberId];
                      const displayLabel = getDisplayLabel(memberId);
                      const totalPicks = memberStats.totalWins + memberStats.totalLosses + memberStats.totalPushes;
                      const winPct = totalPicks > 0 ? ((memberStats.totalWins / totalPicks) * 100).toFixed(1) : '0.0';

                      return (
                        <View key={memberId} style={{ flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme?.colors?.border }}>
                          <View style={{ width: 120, paddingRight: 12, justifyContent: 'center' }}>
                            <Text style={{ color: theme?.colors?.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                              {displayLabel}
                              {memberId === userId && ' (You)'}
                            </Text>
                          </View>
                          {sortedWeeks.map((week, idx) => {
                            const weekStats = weeklyData[memberId]?.[week] || { wins: 0, losses: 0, pushes: 0 };
                            const hasData = weekStats.wins > 0 || weekStats.losses > 0 || weekStats.pushes > 0;
                          
                            return (
                              <View key={idx} style={{ width: 80, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
                                {hasData ? (
                                  <Text style={{ color: theme?.colors?.text, fontSize: 12 }}>
                                    {weekStats.wins}-{weekStats.losses}
                                    {weekStats.pushes > 0 && `-${weekStats.pushes}`}
                                  </Text>
                                ) : (
                                  <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>—</Text>
                                )}
                              </View>
                            );
                          })}
                          <View style={{ width: 100, alignItems: 'center', justifyContent: 'center', paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: theme?.colors?.border }}>
                            <Text style={{ color: theme?.colors?.text, fontWeight: '700', fontSize: 14 }}>
                              {memberStats.totalWins}-{memberStats.totalLosses}
                            </Text>
                            <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>
                              {winPct}%
                            </Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              );
            })()}

            {/* Best Week */}
            {(() => {
              const memberIds = league.members || [];
              let bestWeek = null;
              let bestWins = 0;
            
              if (results && results.length > 0) {
                const weeklyPerformance = {};
              
                results.forEach(result => {
                  if (result.leagueCode === leagueCode && result.userId === userId) {
                    const weekKey = result.week || 'Unknown';
                    if (!weeklyPerformance[weekKey]) {
                      weeklyPerformance[weekKey] = { wins: 0, losses: 0 };
                    }
                    if (result.result === 'win') {
                      weeklyPerformance[weekKey].wins++;
                    } else if (result.result === 'loss') {
                      weeklyPerformance[weekKey].losses++;
                    }
                  }
                });
              
                Object.entries(weeklyPerformance).forEach(([week, stats]) => {
                  if (stats.wins > bestWins) {
                    bestWins = stats.wins;
                    bestWeek = { week, ...stats };
                  }
                });
              }

              if (bestWeek) {
                return (
                  <View style={[styles.card, { backgroundColor: theme?.colors?.success, marginTop: 16 }]}>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 4 }}>🏆 Your Best Week</Text>
                    <Text style={{ color: '#fff', fontSize: 24, fontWeight: '800' }}>{bestWeek.week}</Text>
                    <Text style={{ color: '#fff', opacity: 0.9 }}>
                      {bestWeek.wins}-{bestWeek.losses} ({((bestWeek.wins / (bestWeek.wins + bestWeek.losses)) * 100).toFixed(1)}%)
                    </Text>
                  </View>
                );
              }
              return null;
            })()}
          </>
        )}

        {/* Chat Tab */}
        {activeTab === 'chat' && (
        <>
                  <View style={{ marginBottom: 20 }}>
            <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 12 }]}>League Chat</Text>
            
            {/* Chat Messages */}
            <View style={{ minHeight: 300 }}>
              {(!league.chat || league.chat.length === 0) ? (
                <View style={[styles.card, { backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 40 }]}>
                  <Text style={{ fontSize: 40, marginBottom: 12 }}>💬</Text>
                  <Text style={{ color: theme?.colors?.muted, textAlign: 'center' }}>
                    No messages yet. Start the conversation!
                  </Text>
                </View>
              ) : (
                league.chat.map((msg, idx) => {
                  const reactions = msg.reactions || {};
                  const reactionCounts = {};
                  Object.values(reactions).forEach(emoji => {
                    reactionCounts[emoji] = (reactionCounts[emoji] || 0) + 1;
                  });
                  
                  const addReaction = (emoji) => {
                    const updated = leagues.map(l => {
                      if (l.code === leagueCode) {
                        const updatedChat = [...l.chat];
                        if (!updatedChat[idx].reactions) {
                          updatedChat[idx].reactions = {};
                        }
                        // Toggle reaction
                        if (updatedChat[idx].reactions[userId] === emoji) {
                          delete updatedChat[idx].reactions[userId];
                        } else {
                          updatedChat[idx].reactions[userId] = emoji;
                        }
                        return { ...l, chat: updatedChat };
                      }
                      return l;
                    });
                    setLeagues(updated);
                  };

                  return (
                    <View
                      key={idx}
                      style={[
                        styles.card,
                        { 
                          backgroundColor: msg.userId === userId ? theme?.colors?.primary : theme?.colors?.card,
                          marginBottom: 8,
                          alignSelf: msg.userId === userId ? 'flex-end' : 'flex-start',
                          maxWidth: '80%',
                        }
                      ]}
                    >
                      <Text style={{ 
                        color: msg.userId === userId ? '#fff' : theme?.colors?.text, 
                        fontWeight: '600', 
                        fontSize: 12, 
                        marginBottom: 4 
                      }}>
                        {getDisplayLabel(msg.userId)} {msg.userId === userId && '(You)'}
                      </Text>
                      <Text style={{ color: msg.userId === userId ? '#fff' : theme?.colors?.text }}>
                        {msg.message}
                      </Text>
                      <Text style={{ 
                        color: msg.userId === userId ? 'rgba(255,255,255,0.7)' : theme?.colors?.muted, 
                        fontSize: 10, 
                        marginTop: 4 
                      }}>
                        {new Date(msg.timestamp).toLocaleString([], { 
                          month: 'short', 
                          day: 'numeric', 
                          hour: 'numeric', 
                          minute: '2-digit' 
                        })}
                      </Text>
                      
                      {/* Reactions */}
                      {Object.keys(reactionCounts).length > 0 && (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                          {Object.entries(reactionCounts).map(([emoji, count]) => (
                            <Pressable
                              key={emoji}
                              onPress={() => addReaction(emoji)}
                              style={{
                                backgroundColor: reactions[userId] === emoji ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.1)',
                                borderRadius: 12,
                                paddingHorizontal: 8,
                                paddingVertical: 2,
                                flexDirection: 'row',
                                alignItems: 'center',
                              }}
                            >
                              <Text style={{ fontSize: 12 }}>{emoji}</Text>
                              <Text style={{ 
                                fontSize: 10, 
                                marginLeft: 4,
                                color: msg.userId === userId ? '#fff' : theme?.colors?.text 
                              }}>
                                {count}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      )}
                      
                      {/* Quick Reactions */}
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.1)' }}>
                        {['👍', '❤️', '😂', '🔥', '💯'].map(emoji => (
                          <Pressable
                            key={emoji}
                            onPress={() => addReaction(emoji)}
                            style={{ opacity: reactions[userId] === emoji ? 1 : 0.5 }}
                          >
                            <Text style={{ fontSize: 16 }}>{emoji}</Text>
                          </Pressable>
                        ))}
                      </View>
                    </View>
                  );
                })
              )}
            </View>

            {/* Message Input */}
            <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginTop: 12 }]}>
              <TextInput
                style={[styles.input, { backgroundColor: theme?.colors?.background, color: theme?.colors?.text, marginBottom: 8 }]}
                placeholder="Type your message..."
                placeholderTextColor={theme?.colors?.muted}
                value={chatMessage}
                onChangeText={setChatMessage}
                multiline
                maxLength={500}
              />
              <Pressable
                style={[styles.btnBlue]}
                onPress={() => {
                  if (!chatMessage.trim()) return;
                  
                  const selfLabel = getDisplayLabel(userId) || currentUser?.user_metadata?.display_name || currentUser?.user_metadata?.username || currentUser?.email?.split('@')[0] || 'You';
                  const newMessage = {
                    userId: userId,
                    username: selfLabel,
                    message: chatMessage.trim(),
                    timestamp: new Date().toISOString(),
                  };

                  const updated = leagues.map((l) =>
                    l.code === leagueCode
                      ? { ...l, chat: [...(l.chat || []), newMessage] }
                      : l
                  );
                  setLeagues(updated);
                  setChatMessage("");
                }}
              >
                <Text style={styles.btnTxt}>Send Message</Text>
              </Pressable>
            </View>
          </View>
        </>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <>
                  <View style={{ marginBottom: 20 }}>
            <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 12 }]}>League History</Text>
            
            {(!league.history || league.history.length === 0) ? (
              <View style={[styles.card, { backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 40 }]}>
                <Text style={{ fontSize: 40, marginBottom: 12 }}>📊</Text>
                <Text style={{ color: theme?.colors?.muted, textAlign: 'center' }}>
                  No history yet. Complete a week to see past results!
                </Text>
              </View>
            ) : (
              league.history.map((week, idx) => (
                <View key={idx} style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 12 }]}>
                  <Text style={{ color: theme?.colors?.text, fontWeight: '700', fontSize: 16, marginBottom: 8 }}>
                    {week.weekName || `Week ${idx + 1}`}
                  </Text>
                  <Text style={{ color: theme?.colors?.muted, fontSize: 14, marginBottom: 12 }}>
                    {new Date(week.endDate).toLocaleDateString([], { 
                      month: 'long', 
                      day: 'numeric', 
                      year: 'numeric' 
                    })}
                  </Text>
                  
                  {/* Top 3 for the week */}
                  <Text style={{ color: theme?.colors?.muted, fontSize: 12, fontWeight: '600', marginBottom: 8 }}>
                    TOP PERFORMERS
                  </Text>
                  {week.topPerformers?.slice(0, 3).map((performer, pIdx) => (
                    <View key={pIdx} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ color: theme?.colors?.text }}>
                        {pIdx === 0 ? '🥇' : pIdx === 1 ? '🥈' : '🥉'} {performer.username}
                      </Text>
                      <Text style={{ color: theme?.colors?.text, fontWeight: '600' }}>
                        {performer.wins}-{performer.losses}
                      </Text>
                    </View>
                  ))}
                </View>
              ))
            )}
          </View>
        </>
      )}

      {/* Your Rank Card */}
      {userRank > 0 && (
        <View style={[styles.card, { backgroundColor: theme?.colors?.primary, marginBottom: 16 }]}>
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 12, opacity: 0.9 }}>YOUR STATS</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }}>
            {/* Rank */}
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 48, fontWeight: '800', lineHeight: 52 }}>#{userRank}</Text>
              <Text style={{ color: '#fff', fontSize: 12, opacity: 0.9, marginTop: 4 }}>RANK</Text>
            </View>
            
            {/* Record */}
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 48, fontWeight: '800', lineHeight: 52 }}>
                {standings[userRank - 1].wins}-{standings[userRank - 1].losses}
              </Text>
              <Text style={{ color: '#fff', fontSize: 12, opacity: 0.9, marginTop: 4 }}>RECORD</Text>
            </View>
            
            {/* Win Percentage */}
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 48, fontWeight: '800', lineHeight: 52 }}>
                {standings[userRank - 1].winPercentage}%
              </Text>
              <Text style={{ color: '#fff', fontSize: 12, opacity: 0.9, marginTop: 4 }}>WIN %</Text>
            </View>
          </View>
        </View>
      )}

      {/* Actions */}
      <View style={{ marginTop: 16, marginBottom: 16 }}>
        <Pressable 
          style={[styles.card, { backgroundColor: theme?.colors?.card, borderLeftWidth: 4, borderLeftColor: '#fbbf24', padding: 16, alignItems: 'center', marginBottom: 16 }]} 
          onPress={() => setTab(`HallOfFame:${league.code}`)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ fontSize: 24, marginRight: 10 }}>🏆</Text>
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>View Hall of Fame</Text>
          </View>
          <Text style={{ fontSize: 12, color: theme?.colors?.muted, marginTop: 4 }}>
            Records, champions, and achievements
          </Text>
        </Pressable>

        {/* Invite Friends */}
        <Pressable
          style={[styles.card, { backgroundColor: theme?.colors?.success, marginBottom: 16, padding: 12 }]}
          onPress={() => setShowInvite(!showInvite)}
        >
          <Text style={{ color: '#fff', fontWeight: '600', textAlign: 'center' }}>📧 Invite Friends</Text>
        </Pressable>

        {/* Invite Form */}
        {showInvite && (
          <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 100 }]}>
            <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 12 }]}>Invite Friends</Text>
            
            {/* QR Code for in-person sharing */}
            <View style={{ alignItems: 'center', marginBottom: 16, padding: 16, backgroundColor: '#fff', borderRadius: 8 }}>
              <QRCode
                value={`myfirstapp://join?code=${league.code}`}
                size={150}
                backgroundColor="white"
                color="black"
              />
              <Text style={{ color: '#000', marginTop: 12, fontSize: 14, fontWeight: '600' }}>
                Scan to Join
              </Text>
            </View>

            {/* Join Link */}
            <View style={{ marginBottom: 16, padding: 12, backgroundColor: theme?.colors?.surface, borderRadius: 6, borderWidth: 1, borderColor: theme?.colors?.border }}>
              <Text style={{ color: theme?.colors?.muted, fontSize: 12, marginBottom: 4 }}>Join Link:</Text>
              <Text style={{ color: theme?.colors?.primary, fontSize: 13, fontWeight: '600' }} selectable>
                myfirstapp://join?code={league.code}
              </Text>
            </View>

            {/* League Code */}
            <View style={{ marginBottom: 16, padding: 12, backgroundColor: theme?.colors?.surface, borderRadius: 6, borderWidth: 1, borderColor: theme?.colors?.border }}>
              <Text style={{ color: theme?.colors?.muted, fontSize: 12, marginBottom: 4 }}>League Code:</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: theme?.colors?.primary, fontSize: 20, fontWeight: '700', letterSpacing: 2 }}>
                  {league.code}
                </Text>
                <Pressable
                  style={{ padding: 8, backgroundColor: theme?.colors?.primary, borderRadius: 6 }}
                  onPress={async () => {
                    try {
                      Alert.alert('Code Copied', `League code ${league.code} ready to share!`);
                    } catch {}
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>📋 Copy</Text>
                </Pressable>
              </View>
            </View>

            {/* Share via native sheet */}
            <Pressable
              style={[styles.btnGreen, { marginBottom: 12 }]}
              onPress={async () => {
                try {
                  await Share.share({
                    message: `🏈 Join my NFL Pick'em league "${league.name}"!\n\nOpen the app and use code: ${league.code}\n\nOr tap this link: myfirstapp://join?code=${league.code}`,
                    title: `Join ${league.name}`,
                  });
                } catch (e) {
                  console.warn('Share failed:', e);
                  Alert.alert('Share failed', 'Unable to open share sheet on this device.');
                }
              }}
            >
              <Text style={styles.btnTxt}>📤 Share Invite Link</Text>
            </Pressable>
            
            <Text style={{ color: theme?.colors?.muted, fontSize: 12, textAlign: 'center', fontStyle: 'italic', marginTop: 8 }}>
              Friends can scan the QR code, use the league code, or tap the invite link to join
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
};

const LeagueSettingsScreen = ({ leagueCode, leagues, setLeagues, currentUser, setTab, theme, styles }) => {
  const userId = currentUser?.id;
  const league = leagues.find((l) => l.code === leagueCode);
  
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [memberNames, setMemberNames] = useState(new Map());

  // Fetch member display names
  useEffect(() => {
    if (!league?.members) return;
    const fetchMembers = async () => {
      const names = new Map();
      for (const memberId of league.members) {
        const profile = await getProfile(memberId);
        if (profile) names.set(memberId, profile);
      }
      setMemberNames(names);
    };
    fetchMembers();
  }, [league?.members]);

  const getDisplayLabel = (id) => {
    const p = memberNames.get(id);
    if (p?.display_name) return p.display_name;
    if (p?.username) return p.username;
    return id ? `User ${id.slice(0, 8)}` : 'User';
  };

  const handleLeaveLeague = () => {
    // Check if this is an individual league or if leaving will result in 0 members
    const isIndividualLeague = league.type === 'individual';
    const willBeEmpty = league.members.length === 1;
    
    const actionText = (isIndividualLeague || willBeEmpty) ? "Delete League" : "Leave League";
    const confirmText = (isIndividualLeague || willBeEmpty) 
      ? `This will permanently delete ${league.name}. Are you sure?`
      : `Are you sure you want to leave ${league.name}?`;
    
    Alert.alert(
      actionText,
      confirmText,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: (isIndividualLeague || willBeEmpty) ? "Delete" : "Leave",
          style: "destructive",
          onPress: async () => {
            if (isIndividualLeague || willBeEmpty) {
              // Delete the league entirely
              const { deleteLeague } = await import('./supabaseLeague');
              const { data, error } = await deleteLeague(leagueCode);
              
              if (error) {
                Alert.alert("Error", "Failed to delete league: " + error.message);
                return;
              }
              
              // Remove from local state
              const updated = leagues.filter((l) => l.code !== leagueCode);
              setLeagues(updated);
              setTab("Home");
              Alert.alert("League Deleted", `${league.name} has been deleted`);
            } else {
              // Just remove user from league
              const { removeUserFromLeague } = await import('./supabaseLeague');
              const { data, error } = await removeUserFromLeague(leagueCode, userId);
              
              if (error) {
                Alert.alert("Error", "Failed to leave league: " + error.message);
                return;
              }
              
              // Update local state
              const updated = leagues.map((l) =>
                l.code === leagueCode
                  ? { ...l, members: l.members.filter((id) => id !== userId) }
                  : l
              );
              setLeagues(updated);
              setTab("Home");
              Alert.alert("Left League", `You have left ${league.name}`);
            }
          },
        },
      ]
    );
  };

  if (!league) {
    return (
      <View style={styles.container}>
        <View style={styles.screenHeader}>
          <Pressable onPress={() => setTab("Home")} style={{ padding: 8 }}>
            <Text style={{ fontSize: 32, color: theme?.colors?.heading }}>←</Text>
          </Pressable>
          <Text style={[styles.h1, { color: theme?.colors?.text }]}>Settings</Text>
        </View>
        <Text style={{ color: theme?.colors?.muted, textAlign: 'center', marginTop: 20 }}>League not found</Text>
      </View>
    );
  }

  const isCommissioner = league.creator === userId;

  // Non-commissioner view - read-only
  if (!isCommissioner) {
    return (
      <ScrollView style={styles.container}>
        <View style={styles.screenHeader}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
              <Pressable onPress={() => setTab(`LeagueDetails:${leagueCode}`)} style={{ padding: 8 }}>
                <Text style={{ fontSize: 32, color: theme?.colors?.heading }}>←</Text>
              </Pressable>
              <Text style={[styles.h1, { color: theme?.colors?.text, flex: 1 }]}>League Settings</Text>
            </View>
          </View>
        </View>

        {/* Info Banner */}
        <View style={[styles.card, { backgroundColor: theme?.colors?.warning || '#FEF3C7', borderLeftWidth: 4, borderLeftColor: theme?.colors?.primary, marginBottom: 16 }]}>
          <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 4 }}>📋 View Only</Text>
          <Text style={{ color: theme?.colors?.text, fontSize: 14 }}>
            Only the commissioner can modify league settings. Contact {getDisplayLabel(league.creator)} to request changes.
          </Text>
        </View>

        {/* Read-only League Info */}
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8 }]}>
          <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>League Name</Text>
          <Text style={{ color: theme?.colors?.text, fontSize: 16 }}>{league.name}</Text>
        </View>

        <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8 }]}>
          <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>League Code</Text>
          <Text style={{ fontSize: 20, fontWeight: '700', color: theme?.colors?.primary }}>{league.code}</Text>
          <Text style={{ color: theme?.colors?.muted, marginTop: 4, fontSize: 14 }}>Share this code with friends to join</Text>
        </View>

        <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8 }]}>
          <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>Line Lock</Text>
          <Text style={{ color: theme?.colors?.text, fontSize: 14 }}>
            {String(typeof league?.settings?.lockOffsetMinutes === 'number' ? league?.settings?.lockOffsetMinutes : (typeof league?.settings?.lineLockTime === 'number' ? league?.settings?.lineLockTime * 60 : 60))} minutes before kickoff
          </Text>
        </View>

        <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8 }]}>
          <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>Tiebreaker</Text>
          <Text style={{ color: theme?.colors?.text, fontSize: 14 }}>
            {(() => {
              const rule = league?.settings?.tiebreaker || 'totalPoints';
              const option = [
                { value: 'totalPoints', desc: 'Most total points wins' },
                { value: 'winPercentage', desc: 'Highest win % wins' },
                { value: 'headToHead', desc: 'Best record vs tied players' },
                { value: 'bestWeek', desc: 'Highest single week score' },
                { value: 'fewestMissed', desc: 'Least missed picks' },
                { value: 'mostRecentWin', desc: 'Last to win' },
              ].find(o => o.value === rule);
              return option?.desc || 'Most total points wins';
            })()}
          </Text>
        </View>

        <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8 }]}>
          <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>Commissioner</Text>
          <Text style={{ color: theme?.colors?.text, fontSize: 16 }}>{getDisplayLabel(league.creator)}</Text>
        </View>

        {/* Leave League */}
        <Pressable 
          style={[styles.card, { backgroundColor: theme?.colors?.danger, padding: 12, marginBottom: 100 }]} 
          onPress={handleLeaveLeague}
        >
          <Text style={{ color: '#fff', fontWeight: '600', textAlign: 'center' }}>Leave League</Text>
        </Pressable>
      </ScrollView>
    );
  }

  // Commissioner view - full edit access
  return (
    <ScrollView style={styles.container}>
      <View style={styles.screenHeader}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
            <Pressable onPress={() => setTab(`LeagueDetails:${leagueCode}`)} style={{ padding: 8 }}>
              <Text style={{ fontSize: 32, color: theme?.colors?.heading }}>←</Text>
            </Pressable>
            <Text style={[styles.h1, { color: theme?.colors?.text, flex: 1 }]}>League Settings</Text>
          </View>
        </View>
      </View>

      {/* Commissioner Badge */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.primary, marginBottom: 16 }]}>
        <Text style={{ fontWeight: '600', color: '#fff', marginBottom: 4 }}>👑 Commissioner Mode</Text>
        <Text style={{ color: '#fff', fontSize: 14, opacity: 0.9 }}>
          You have full access to modify all league settings.
        </Text>
      </View>

      {/* Rename League */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8 }]}>
        <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>League Name</Text>
        {editingName ? (
          <View>
            <TextInput
              style={styles.input}
              value={newName}
              onChangeText={setNewName}
              placeholder="Enter new league name"
              placeholderTextColor={theme?.colors?.muted}
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable
                style={[styles.btnGreen, { flex: 1 }]}
                onPress={async () => {
                  if (!newName.trim()) {
                    Alert.alert("Error", "League name cannot be empty");
                    return;
                  }
                  // Update in Supabase
                  const { renameLeague } = await import('./supabaseLeague');
                  const { data, error } = await renameLeague(leagueCode, newName.trim());
                  
                  if (error) {
                    Alert.alert("Error", "Failed to update league name: " + error.message);
                    return;
                  }
                  
                  // Update local state
                  const updated = leagues.map((l) =>
                    l.code === leagueCode ? { ...l, name: newName.trim() } : l
                  );
                  setLeagues(updated);
                  setEditingName(false);
                  Alert.alert("Success", "League name updated!");
                }}
              >
                <Text style={styles.btnTxt}>Save</Text>
              </Pressable>
              <Pressable
                style={[styles.card, { flex: 1, backgroundColor: theme?.colors?.muted, padding: 12 }]}
                onPress={() => {
                  setEditingName(false);
                  setNewName("");
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '600', textAlign: 'center' }}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            onPress={() => {
              setNewName(league.name);
              setEditingName(true);
            }}
          >
            <Text style={{ color: theme?.colors?.text, fontSize: 16 }}>{league.name}</Text>
            <Text style={{ color: theme?.colors?.primary, marginTop: 4, fontSize: 14 }}>Tap to edit</Text>
          </Pressable>
        )}
      </View>

      {/* Share Code */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8 }]}>
        <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>League Code</Text>
        <Text style={{ fontSize: 20, fontWeight: '700', color: theme?.colors?.primary }}>{league.code}</Text>
        <Text style={{ color: theme?.colors?.muted, marginTop: 4, fontSize: 14 }}>Share this code with friends to join</Text>
      </View>

      {/* Line Lock Settings */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8 }]}>
        <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>Line Lock</Text>
        <Text style={{ color: theme?.colors?.muted, marginBottom: 8, fontSize: 13 }}>
          When do spreads and totals lock before game time?
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[
            { label: '1 Hour', value: 1 },
            { label: '2 Hours', value: 2 },
            { label: '3 Hours', value: 3 },
            { label: '4 Hours', value: 4 },
            { label: '5 Hours', value: 5 },
            { label: '6 Hours', value: 6 },
            { label: '12 Hours', value: 12 },
            { label: '24 Hours', value: 24 },
            { label: 'Opening Line', value: 'opening' },
          ].map((opt) => {
            const isSelected = (
              (opt.value === 'opening' && league?.settings?.lineLockTime === 'opening') ||
              (typeof opt.value === 'number' && (
                league?.settings?.lineLockTime === opt.value ||
                league?.settings?.lockOffsetMinutes === opt.value * 60
              ))
            );
            return (
              <Pressable
                key={String(opt.value)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: isSelected ? (theme?.colors?.primary || '#2563eb') : (theme?.colors?.border || '#d1d5db'),
                  backgroundColor: isSelected ? (theme?.colors?.primary || '#2563eb') : 'white',
                }}
                onPress={async () => {
                  const minutes = opt.value === 'opening' ? 60 : (opt.value * 60);
                  const lineLockTime = opt.value === 'opening' ? 'opening' : opt.value;
                  
                  const newSettings = {
                    ...(league.settings || {}),
                    lockOffsetMinutes: minutes,
                    lineLockTime,
                  };
                  
                  // Update in Supabase
                  const { updateLeagueSettings } = await import('./supabaseLeague');
                  const { data, error } = await updateLeagueSettings(leagueCode, newSettings);
                  
                  if (error) {
                    Alert.alert("Error", "Failed to update settings: " + error.message);
                    return;
                  }
                  
                  // Update local state
                  const updated = leagues.map((l) =>
                    l.code === leagueCode
                      ? {
                          ...l,
                          settings: newSettings
                        }
                      : l
                  );
                  setLeagues(updated);
                  Alert.alert('Saved', `Lines will lock ${minutes} minutes before kickoff.`);
                }}
              >
                <Text style={{ color: isSelected ? '#fff' : (theme?.colors?.text || '#1f2937') }}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={{ color: theme?.colors?.muted, marginTop: 8, fontSize: 12 }}>
          Current: {String(typeof league?.settings?.lockOffsetMinutes === 'number' ? league?.settings?.lockOffsetMinutes : (typeof league?.settings?.lineLockTime === 'number' ? league?.settings?.lineLockTime * 60 : 60))} minutes before kickoff
        </Text>
      </View>

      {/* Tiebreaker Settings */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8 }]}>
        <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>Tiebreaker Rules</Text>
        <Text style={{ color: theme?.colors?.muted, marginBottom: 8, fontSize: 13 }}>
          How should ties be broken on the leaderboard?
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[
            { label: 'Total Points', value: 'totalPoints', desc: 'Most points wins' },
            { label: 'Win %', value: 'winPercentage', desc: 'Highest win % wins' },
            { label: 'Head-to-Head', value: 'headToHead', desc: 'Best record vs tied players' },
            { label: 'Best Week', value: 'bestWeek', desc: 'Highest single week' },
            { label: 'Fewest Missed', value: 'fewestMissed', desc: 'Least missed picks' },
            { label: 'Most Recent', value: 'mostRecentWin', desc: 'Last to win' },
          ].map((opt) => {
            const isSelected = league?.settings?.tiebreaker === opt.value;
            return (
              <Pressable
                key={opt.value}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: isSelected ? (theme?.colors?.primary || '#2563eb') : (theme?.colors?.border || '#d1d5db'),
                  backgroundColor: isSelected ? (theme?.colors?.primary || '#2563eb') : 'white',
                  minWidth: '48%',
                }}
                onPress={async () => {
                  const newSettings = {
                    ...(league.settings || {}),
                    tiebreaker: opt.value,
                  };
                  
                  // Update in Supabase
                  const { updateLeagueSettings } = await import('./supabaseLeague');
                  const { data, error } = await updateLeagueSettings(leagueCode, newSettings);
                  
                  if (error) {
                    Alert.alert("Error", "Failed to update settings: " + error.message);
                    return;
                  }
                  
                  // Update local state
                  const updated = leagues.map((l) =>
                    l.code === leagueCode
                      ? {
                          ...l,
                          settings: newSettings
                        }
                      : l
                  );
                  setLeagues(updated);
                  Alert.alert('Saved', `Tiebreaker set to: ${opt.desc}`);
                }}
              >
                <Text style={{ color: isSelected ? '#fff' : (theme?.colors?.text || '#1f2937'), fontWeight: '600', fontSize: 13 }}>
                  {opt.label}
                </Text>
                <Text style={{ color: isSelected ? 'rgba(255,255,255,0.8)' : (theme?.colors?.muted || '#6b7280'), fontSize: 11, marginTop: 2 }}>
                  {opt.desc}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={{ color: theme?.colors?.muted, marginTop: 8, fontSize: 12 }}>
          Current: {(() => {
            const rule = league?.settings?.tiebreaker || 'totalPoints';
            const option = [
              { value: 'totalPoints', desc: 'Most total points wins' },
              { value: 'winPercentage', desc: 'Highest win % wins' },
              { value: 'headToHead', desc: 'Best record vs tied players' },
              { value: 'bestWeek', desc: 'Highest single week score' },
              { value: 'fewestMissed', desc: 'Least missed picks' },
              { value: 'mostRecentWin', desc: 'Last to win' },
            ].find(o => o.value === rule);
            return option?.desc || 'Most total points wins';
          })()}
        </Text>
      </View>

      {/* Members Management (Creator only) */}
      {league.creator === userId && (
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 8 }]}>
          <Text style={{ fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>Members</Text>
          {league.members.map((memberId) => (
            <View key={memberId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme?.colors?.border }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{ fontSize: 16, color: theme?.colors?.text, fontWeight: '600' }}>
                  {getDisplayLabel(memberId)}
                </Text>
                {memberId === league.creator && (
                  <Text style={{ marginLeft: 8, fontSize: 12, color: theme?.colors?.muted }}>(Commissioner)</Text>
                )}
                {memberId === userId && (
                  <Text style={{ marginLeft: 8, fontSize: 12, color: theme?.colors?.muted }}>(You)</Text>
                )}
              </View>
              {/* Remove button, not for self or commissioner */}
              {memberId !== league.creator && (
                <Pressable
                  style={[styles.card, { backgroundColor: theme?.colors?.danger, paddingHorizontal: 12, paddingVertical: 6 }]}
                  onPress={() => {
                    // Check if removing this member will leave the league empty
                    const remainingMembers = league.members.filter(id => id !== memberId);
                    const willBeEmpty = remainingMembers.length === 0;
                    
                    Alert.alert(
                      'Remove Member',
                      willBeEmpty 
                        ? `${getDisplayLabel(memberId)} is the last member. Removing them will delete the league permanently. Continue?`
                        : `Remove ${getDisplayLabel(memberId)} from ${league.name}?`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { 
                          text: willBeEmpty ? 'Delete League' : 'Remove', 
                          style: 'destructive',
                          onPress: async () => {
                            if (willBeEmpty) {
                              // Delete the entire league
                              const { deleteLeague } = await import('./supabaseLeague');
                              const { data, error } = await deleteLeague(leagueCode);
                              
                              if (error) {
                                Alert.alert("Error", "Failed to delete league: " + error.message);
                                return;
                              }
                              
                              // Remove from local state
                              const updated = leagues.filter(l => l.code !== leagueCode);
                              setLeagues(updated);
                              setTab("Home");
                              Alert.alert('League Deleted', `${league.name} has been deleted as it had no remaining members.`);
                            } else {
                              // Just remove the member
                              const { removeUserFromLeague } = await import('./supabaseLeague');
                              const { data, error } = await removeUserFromLeague(leagueCode, memberId);
                              
                              if (error) {
                                Alert.alert("Error", "Failed to remove member: " + error.message);
                                return;
                              }
                              
                              // Update local state
                              const updated = leagues.map(l =>
                                l.code === leagueCode 
                                  ? { ...l, members: l.members.filter(id => id !== memberId) } 
                                  : l
                              );
                              setLeagues(updated);
                              Alert.alert('Removed', `${getDisplayLabel(memberId)} has been removed.`);
                            }
                          }
                        }
                      ]
                    );
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Remove</Text>
                </Pressable>
              )}
            </View>
          ))}
          {league.members.length <= 1 && (
            <Text style={{ color: theme?.colors?.muted, fontSize: 12, marginTop: 8 }}>No other members to manage.</Text>
          )}
        </View>
      )}

      {/* Leave League */}
      <Pressable 
        style={[styles.card, { backgroundColor: theme?.colors?.danger, padding: 12, marginBottom: 8 }]} 
        onPress={handleLeaveLeague}
      >
        <Text style={{ color: '#fff', fontWeight: '600', textAlign: 'center' }}>Leave League</Text>
      </Pressable>

      {/* Delete League (only for creator) */}
      {league.creator === userId && (
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, borderWidth: 1, borderColor: theme?.colors?.danger, marginBottom: 100 }]}>
          <Text style={{ fontWeight: '600', color: theme?.colors?.danger, marginBottom: 8 }}>Danger Zone</Text>
          <Text style={{ color: theme?.colors?.muted, marginBottom: 12, fontSize: 14 }}>
            Once you delete a league, there is no going back. This will remove all picks and data.
          </Text>
          <Pressable
            style={[styles.card, { backgroundColor: theme?.colors?.danger, padding: 12 }]}
            onPress={() => {
              Alert.alert(
                "Delete League",
                `Are you sure you want to permanently delete ${league.name}? This cannot be undone.`,
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: async () => {
                      // Delete from Supabase
                      const { deleteLeague } = await import('./supabaseLeague');
                      const { data, error } = await deleteLeague(leagueCode);
                      
                      if (error) {
                        Alert.alert("Error", "Failed to delete league: " + error.message);
                        return;
                      }
                      
                      // Update local state
                      const updated = leagues.filter((l) => l.code !== leagueCode);
                      setLeagues(updated);
                      setTab("Home");
                      Alert.alert("League Deleted", `${league.name} has been permanently deleted`);
                    },
                  },
                ]
              );
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', textAlign: 'center' }}>Delete League</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
};

const LeaguesScreen = ({ leagues, setLeagues, currentUser, setTab, theme, styles, profile }) => {
  const [joinCode, setJoinCode] = useState("");
  const userId = currentUser?.id;

  const joinLeague = () => {
    if (!joinCode) return Alert.alert("Enter a league code!");
    const league = leagues.find((l) => l.code === joinCode?.toUpperCase());
    if (!league) return Alert.alert("League not found!", "Double-check the code and try again.");
    if (league.members.includes(userId)) {
      Alert.alert("Already a Member", `You're already in "${league.name}"!`);
      return;
    }
    // Add user to league in Supabase
    import('./supabaseLeague').then(({ addUserToLeague }) => {
      addUserToLeague(league.code, userId).then(({ data, error }) => {
        if (error) {
          Alert.alert("Error", "Failed to join league: " + error.message);
        } else {
          // Update local state with new members
          const updated = leagues.map((l) =>
            l.code === league.code ? { ...l, members: data.members } : l
          );
          setLeagues(updated);
          Alert.alert("Success!", `You've joined "${league.name}"!`);
          setJoinCode("");
          setTab(`LeagueDetails:${league.code}`);
        }
      });
    });
  };

  const userLeagues = leagues.filter(l => l.members.includes(userId));

  return (
    <ScrollView style={styles.container}>
      <View style={styles.screenHeader}>
        <Text style={styles.h1}>My Leagues</Text>
        <Text style={styles.h2}>{userLeagues.length} active league{userLeagues.length !== 1 ? 's' : ''}</Text>
      </View>

      {/* Master Picks Button (if enabled) */}
      {profile?.master_picks_enabled && (profile?.master_picks_leagues || []).length > 0 && (
        <View style={[styles.card, { backgroundColor: theme?.colors?.primary || '#2563eb', borderLeftWidth: 4, borderLeftColor: theme?.colors?.warning || '#f59e0b' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ fontSize: 24, marginRight: 8 }}>⚡</Text>
            <Text style={[styles.h2, { color: '#fff', marginBottom: 0 }]}>Master Picks</Text>
          </View>
          <Text style={{ color: '#fff', opacity: 0.9, marginBottom: 12, fontSize: 14 }}>
            Make picks once and sync to {(profile?.master_picks_leagues || []).length} league{(profile?.master_picks_leagues || []).length !== 1 ? 's' : ''}
          </Text>
          <Pressable 
            style={{ backgroundColor: '#fff', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center' }} 
            onPress={() => setTab("MasterPicks")}
          >
            <Text style={{ color: theme?.colors?.primary || '#2563eb', fontWeight: '700', fontSize: 15 }}>
              Open Master Picks →
            </Text>
          </Pressable>
        </View>
      )}

      {/* Create League Card */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card || '#fff', borderLeftWidth: 4, borderLeftColor: theme?.colors?.success }]}>
        <Text style={[styles.h2, { marginBottom: 4 }]}>🏈 Create a New League</Text>
        <Text style={[styles.muted, { marginBottom: 12 }]}>Start a new league and invite friends to join.</Text>
        <Pressable style={[styles.btnGreen]} onPress={() => setTab("CreateLeague")}>
          <Text style={styles.btnTxt}>Create League</Text>
        </Pressable>
      </View>

      {/* Join by Code Card */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card || '#fff', borderLeftWidth: 4, borderLeftColor: theme?.colors?.primary }]}>
        <Text style={[styles.h2, { marginBottom: 4 }]}>🔗 Join a League</Text>
        <Text style={[styles.muted, { marginBottom: 12 }]}>Enter a league code to join an existing league.</Text>
        <TextInput
          placeholder="Enter League Code (e.g., ABC123)"
          placeholderTextColor={theme?.colors?.muted}
          value={joinCode}
          autoCapitalize="characters"
          onChangeText={(t) => setJoinCode(t.toUpperCase())}
          style={[styles.input, { backgroundColor: theme?.colors?.surface || 'white', borderColor: theme?.colors?.border || '#d1d5db', color: theme?.colors?.text || '#1f2937', marginBottom: 8 }]}
        />
        <Pressable 
          style={[styles.btnBlue, !joinCode && { opacity: 0.5 }]} 
          onPress={joinLeague}
          disabled={!joinCode}
        >
          <Text style={styles.btnTxt}>Join League</Text>
        </Pressable>
      </View>

      {/* Your Leagues */}
      {userLeagues.length > 0 && (
        <>
          <Text style={[styles.h2, { color: theme?.colors?.text, marginTop: 16, marginBottom: 12, paddingHorizontal: 4 }]}>
            Your Leagues
          </Text>
          {userLeagues.map((league) => (
            <View key={league.code} style={[styles.card, { backgroundColor: theme?.colors?.card }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: theme?.colors?.text }}>
                    {league.name}
                  </Text>
                </View>
                <View style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                  {/* League Type Badge */}
                  <View style={{ 
                    backgroundColor: theme?.colors?.primary || '#2563eb', 
                    paddingHorizontal: 8, 
                    paddingVertical: 4, 
                    borderRadius: 6,
                    alignSelf: 'flex-end'
                  }}>
                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: '600' }}>
                      {(() => {
                        const { LEAGUE_TYPE_DETAILS } = require('./leagueTypes');
                        const typeDetails = LEAGUE_TYPE_DETAILS[league.type];
                        return typeDetails?.name || 'League';
                      })()}
                    </Text>
                  </View>
                  {/* Share Button */}
                  <Pressable
                    style={{ padding: 6, backgroundColor: theme?.colors?.success, borderRadius: 6 }}
                    onPress={async () => {
                      try {
                        await Share.share({
                          message: `🏈 Join my NFL Pick'em league "${league.name}"!\n\nOpen the app and use code: ${league.code}\n\nOr tap this link: myfirstapp://join?code=${league.code}`,
                          title: `Join ${league.name}`,
                        });
                      } catch (e) {
                        console.warn('Share failed:', e);
                      }
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>📤 Share</Text>
                  </Pressable>
                </View>
              </View>
              <Text style={{ color: theme?.colors?.muted, fontSize: 14, marginBottom: 8 }}>
                Code: {league.code} • {league.members.length} member{league.members.length !== 1 ? 's' : ''}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Pressable
                  style={[styles.btnBlue, { flex: 1 }]}
                  onPress={() => setTab(`LeagueDetails:${league.code}`)}
                >
                  <Text style={styles.btnTxt}>View Details</Text>
                </Pressable>
                <Pressable
                  style={[styles.btnGreen, { flex: 1 }]}
                  onPress={() => setTab(`Picks:${league.code}`)}
                >
                  <Text style={styles.btnTxt}>Make Picks</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </>
      )}

      {userLeagues.length === 0 && (
        <View style={[styles.card, { backgroundColor: theme?.colors?.surface, padding: 24, alignItems: 'center' }]}>
          <Text style={{ fontSize: 48, marginBottom: 12 }}>🏈</Text>
          <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text, marginBottom: 8, textAlign: 'center' }}>
            No Leagues Yet
          </Text>
          <Text style={{ color: theme?.colors?.muted, textAlign: 'center' }}>
            Create a league or join one using a code to get started!
          </Text>
        </View>
      )}
      
      <AppFooter theme={theme} styles={styles} />
    </ScrollView>
  );
};

const PicksScreen = ({ leagueCode, leagues, setLeagues, currentUser, setTab, theme, styles, notifPrefs, syncPicksAcrossLeagues }) => {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [pickVersion, setPickVersion] = useState(0); // Force re-render tracker
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastType, setToastType] = useState('info');
  const league = leagues.find((l) => l.code === leagueCode);
  const userId = currentUser?.id;
  
  // Check if this is Moneyline Mania mode (pick winners only)
  const isMoneylineMode = league?.type === 'moneylineMania';

  const teamLogos = {
    "Arizona Cardinals": "https://a.espncdn.com/i/teamlogos/nfl/500/ari.png",
    "Atlanta Falcons": "https://a.espncdn.com/i/teamlogos/nfl/500/atl.png",
    "Baltimore Ravens": "https://a.espncdn.com/i/teamlogos/nfl/500/bal.png",
    "Buffalo Bills": "https://a.espncdn.com/i/teamlogos/nfl/500/buf.png",
    "Carolina Panthers": "https://a.espncdn.com/i/teamlogos/nfl/500/car.png",
    "Chicago Bears": "https://a.espncdn.com/i/teamlogos/nfl/500/chi.png",
    "Cincinnati Bengals": "https://a.espncdn.com/i/teamlogos/nfl/500/cin.png",
    "Cleveland Browns": "https://a.espncdn.com/i/teamlogos/nfl/500/cle.png",
    "Dallas Cowboys": "https://a.espncdn.com/i/teamlogos/nfl/500/dal.png",
    "Denver Broncos": "https://a.espncdn.com/i/teamlogos/nfl/500/den.png",
    "Detroit Lions": "https://a.espncdn.com/i/teamlogos/nfl/500/det.png",
    "Green Bay Packers": "https://a.espncdn.com/i/teamlogos/nfl/500/gb.png",
    "Houston Texans": "https://a.espncdn.com/i/teamlogos/nfl/500/htx.png",
    "Indianapolis Colts": "https://a.espncdn.com/i/teamlogos/nfl/500/ind.png",
    "Jacksonville Jaguars": "https://a.espncdn.com/i/teamlogos/nfl/500/jax.png",
    "Kansas City Chiefs": "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png",
    "Las Vegas Raiders": "https://a.espncdn.com/i/teamlogos/nfl/500/lv.png",
    "Los Angeles Chargers": "https://a.espncdn.com/i/teamlogos/nfl/500/lac.png",
    "Los Angeles Rams": "https://a.espncdn.com/i/teamlogos/nfl/500/lar.png",
    "Miami Dolphins": "https://a.espncdn.com/i/teamlogos/nfl/500/mia.png",
    "Minnesota Vikings": "https://a.espncdn.com/i/teamlogos/nfl/500/min.png",
    "New England Patriots": "https://a.espncdn.com/i/teamlogos/nfl/500/ne.png",
    "New Orleans Saints": "https://a.espncdn.com/i/teamlogos/nfl/500/no.png",
    "New York Giants": "https://a.espncdn.com/i/teamlogos/nfl/500/nyg.png",
    "New York Jets": "https://a.espncdn.com/i/teamlogos/nfl/500/nyj.png",
    "Philadelphia Eagles": "https://a.espncdn.com/i/teamlogos/nfl/500/phi.png",
    "Pittsburgh Steelers": "https://a.espncdn.com/i/teamlogos/nfl/500/pit.png",
    "San Francisco 49ers": "https://a.espncdn.com/i/teamlogos/nfl/500/sf.png",
    "Seattle Seahawks": "https://a.espncdn.com/i/teamlogos/nfl/500/sea.png",
    "Tampa Bay Buccaneers": "https://a.espncdn.com/i/teamlogos/nfl/500/tb.png",
    "Tennessee Titans": "https://a.espncdn.com/i/teamlogos/nfl/500/ten.png",
    "Washington Commanders": "https://a.espncdn.com/i/teamlogos/nfl/500/was.png",
  };

  // Quietly backfill locked lines for this league if freeze passed and entry missing
  const maybeBackfillLockedLines = useCallback(async (gameList) => {
    try {
      const freshLeague = leagues.find((l) => l.code === leagueCode);
      if (!freshLeague || !Array.isArray(gameList) || gameList.length === 0) return;

      const lockOffsetMinutes = getLockOffsetMinutes(freshLeague);
      const now = new Date();
      const existing = { ...(freshLeague.locked_lines || {}) };
      let changed = false;

      const parseNum = (val) => {
        if (val === null || val === undefined) return null;
        if (typeof val === 'number') return Number.isFinite(val) ? val : null;
        const s = String(val).replace(/[^0-9+\-.]/g, '').trim();
        if (!s) return null;
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
      };

      for (const g of gameList) {
        if (!g?.id || !g?.startISO) continue;
        if (existing[g.id]) continue; // already locked
        const start = new Date(g.startISO);
        const freeze = new Date(start.getTime() - lockOffsetMinutes * 60 * 1000);
        if (now < freeze) continue; // not frozen yet

        const homeVal = parseNum(g.homeSpread);
        const awayVal = parseNum(g.awaySpread);
        let spreadToken = null;
        let spreadNumber = null;

        if (homeVal !== null && awayVal !== null) {
          if (homeVal < 0) {
            spreadToken = g.homeAbbr || g.homeTeam;
            spreadNumber = homeVal;
          } else if (awayVal < 0) {
            spreadToken = g.awayAbbr || g.awayTeam;
            spreadNumber = awayVal;
          } else {
            // Pick'em or unknown favorite; default home if equal/non-negative
            spreadToken = g.homeAbbr || g.homeTeam;
            spreadNumber = homeVal || 0;
          }
        }

        const ouVal = parseNum(g.overUnder);
        const lockedEntry = {
          lockedAt: new Date().toISOString(),
        };
        if (spreadToken != null && spreadNumber != null) {
          lockedEntry.spread = `${spreadToken} ${spreadNumber > 0 ? `+${spreadNumber}` : `${spreadNumber}`}`;
        }
        if (ouVal != null) {
          lockedEntry.overUnder = `${ouVal}`;
        }

        existing[g.id] = lockedEntry;
        changed = true;
      }

      if (changed) {
        try {
          await updateLeagueLockedLines(freshLeague.code, existing);
        } catch (e) {
          console.warn('Failed to persist locked_lines backfill:', e?.message || e);
        }
        setLeagues((prev) => prev.map((l) => l.code === freshLeague.code ? { ...l, locked_lines: existing } : l));
      }
    } catch (e) {
      console.warn('maybeBackfillLockedLines error:', e?.message || e);
    }
  }, [leagueCode, leagues, setLeagues]);

  useEffect(() => {
    let isMounted = true;
    const abortController = new AbortController();
    
    const fetchGames = async () => {
      await fetchNFLGames(abortController.signal, isMounted);
    };
    
    fetchGames();
    
    return () => {
      isMounted = false;
      abortController.abort();
    };
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchNFLGames(null, true);
    setRefreshing(false);
  };

  const fetchNFLGames = async (signal = null, isMounted = true) => {
    try {
      setLoading(true);
      setError(null);
      
      // Calculate current week
      const now = new Date();
      const seasonStart2025 = new Date('2025-09-02T00:00:00');
      const diffTime = now - seasonStart2025;
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      const currentWeek = Math.max(1, Math.min(18, Math.floor(diffDays / 7) + 1));
      
      // Rate limiting check
      if (!espnRateLimiter.canMakeRequest()) {
        const waitTime = Math.ceil(espnRateLimiter.getWaitTime() / 1000);
        if (isMounted) {
          setError(`Rate limit reached. Please wait ${waitTime} seconds before refreshing.`);
          setLoading(false);
        }
        return;
      }
      
      // Check network connectivity
      let espnData, oddsData;
      
      try {
        const espnRes = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${currentWeek}`,
          { 
            timeout: 10000,
            headers: { 'Accept': 'application/json' },
            signal
          }
        );
        
        if (!espnRes.ok) {
          if (espnRes.status === 429) {
            throw new Error('Rate limit exceeded. Please wait a moment and try again.');
          } else if (espnRes.status >= 500) {
            throw new Error('ESPN server error. Please try again later.');
          } else if (espnRes.status === 404) {
            throw new Error('No games found for this week.');
          }
          throw new Error(`ESPN API error: ${espnRes.status}`);
        }
        
        espnData = await espnRes.json();
        
        if (!espnData || !espnData.events) {
          throw new Error('Invalid data from ESPN API');
        }
      } catch (espnErr) {
        if (espnErr.message?.includes('Network request failed') || espnErr.message?.includes('fetch')) {
          throw new Error('No internet connection. Please check your network and try again.');
        }
        throw espnErr;
      }

      // Fetch odds with error handling
      try {
        const apiKey = "886148fe24130e611bb794dee4d00c03";
        const oddsRes = await fetch(
          `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=${apiKey}&regions=us&markets=spreads,totals&oddsFormat=decimal`,
          { 
            timeout: 10000,
            headers: { 'Accept': 'application/json' },
            signal
          }
        );
        
        if (oddsRes.ok) {
          oddsData = await oddsRes.json();
        } else {
          console.warn('Odds API failed, using fallback spreads');
          oddsData = []; // Continue without odds
        }
      } catch (oddsErr) {
        console.warn('Odds API error:', oddsErr.message);
        oddsData = []; // Continue without odds
      }

      const parsedGames = (espnData.events || []).map((event) => {
        const comp = event.competitions[0];
        const away = comp.competitors.find(c => c.homeAway === "away") || comp.competitors[0];
        const home = comp.competitors.find(c => c.homeAway === "home") || comp.competitors[1];
        const startISO = event.date;
        const gameTime = new Date(startISO).toLocaleString([], {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });

        const oddsGame = oddsData.find(g =>
          g.home_team === home.team.displayName && g.away_team === away.team.displayName
        );

        const spreadMarket = oddsGame?.bookmakers?.[0]?.markets?.find(m => m.key === "spreads");
        const totalsMarket = oddsGame?.bookmakers?.[0]?.markets?.find(m => m.key === "totals");

        const awaySpread = spreadMarket?.outcomes?.find(o => o.name === away.team.displayName)?.point;
        const homeSpread = spreadMarket?.outcomes?.find(o => o.name === home.team.displayName)?.point;
        const overUnder = totalsMarket?.outcomes?.[0]?.point;

        return {
          id: event.id,
          awayTeam: away.team.displayName,
          homeTeam: home.team.displayName,
          awayAbbr: away.team.abbreviation || away.team.displayName,
          homeAbbr: home.team.abbreviation || home.team.displayName,
          awayLogo: teamLogos[away.team.displayName],
          homeLogo: teamLogos[home.team.displayName],
          gameTime,
          startISO,
          venue: comp.venue?.fullName || "TBD",
          awaySpread: awaySpread !== undefined ? (awaySpread > 0 ? `+${awaySpread}` : awaySpread) : "—",
          homeSpread: homeSpread !== undefined ? (homeSpread > 0 ? `+${homeSpread}` : homeSpread) : "—",
          overUnder: overUnder || null,
        };
      });

      if (parsedGames.length === 0) {
        if (isMounted) {
          setError('No games scheduled for this week.');
          setGames([]);
          setLoading(false);
        }
        return;
      }

      if (isMounted) {
        setGames(parsedGames);
        setError(null);
      }

      // After games load, silently backfill locked lines if missing
      try {
        await maybeBackfillLockedLines(parsedGames);
      } catch {}

      // Schedule game reminder notifications (24h, 4h, 1h before kickoff)
      // Create league objects with games attached for notification scheduling
      try {
        const prefs = notifPrefs || (await getNotificationPrefs());
        
        // Attach games to each league for per-league notifications
        const leaguesWithGames = leagues.map(league => ({
          league_name: league.league_name,
          league_code: league.league_code,
          games: parsedGames
        }));
        
        const { totalScheduled, totalSkipped } = await scheduleWeeklyGameReminders(leaguesWithGames, prefs);
        console.log(`[Notifications] Scheduled ${totalScheduled} league reminders, skipped ${totalSkipped}`);

        // Schedule line lock notifications per game based on league setting
        try {
          const lockOffsetMinutes = getLockOffsetMinutes(league);
          if (!prefs || (prefs.enabled && prefs.lineLocks)) {
            for (const game of parsedGames) {
              if (!game.startISO) continue;
              const startTime = new Date(game.startISO);
              const lockTime = new Date(startTime.getTime() - lockOffsetMinutes * 60 * 1000);
              await scheduleLineLockNotificationIfNeeded(game, lockTime);
            }
          }
        } catch (e) {
          console.warn('Failed to schedule line lock notifications:', e);
        }
      } catch (notifErr) {
        console.warn('Failed to schedule notifications:', notifErr);
      }
    } catch (error) {
      // Don't update state if component unmounted or request aborted
      if (error.name === 'AbortError' || !isMounted) {
        console.log('Fetch aborted or component unmounted');
        return;
      }
      console.error('Error fetching NFL games:', error);
      if (isMounted) {
        setError(error.message || 'Failed to load games. Please try again.');
        setGames([]);
      }
    } finally {
      if (isMounted) {
        setLoading(false);
      }
    }
  };

  if (!league) return <Text>League not found!</Text>;

  const makePick = async (gameId, pickType, value) => {
    const currentPick = league?.picks?.[userId]?.[gameId]?.[pickType];
    const hasExistingPick = currentPick !== undefined && currentPick !== null;
    const isChangingPick = hasExistingPick && currentPick !== value;
    const isRemovingPick = currentPick === value;

    // Update pick immediately without confirmation for seamless UX
    await updatePick(gameId, pickType, value, isChangingPick);
  };

  const updatePick = async (gameId, pickType, value, isEdit) => {
    try {
      const game = (games || []).find(g => g.id === gameId);
      const currentLeague = leagues.find(league => league.code === leagueCode);
      const skippedSyncTargets = [];
      const actuallyUpdatedCodes = new Set();
      const updated = leagues.map((l) => {
        const shouldSyncBase = syncPicksAcrossLeagues && currentLeague && l.type === currentLeague.type;
        // Determine if target league's pick for this game is already locked
        let targetLocked = false;
        if (shouldSyncBase && game) {
          const lockOffsetMinutes = getLockOffsetMinutes(l);
          const startDate = game?.startISO ? new Date(game.startISO) : new Date(game?.gameTime);
          const pickCutoffTime = startDate; // cutoff at kickoff
          const now = new Date();
            targetLocked = now >= pickCutoffTime; 
        }
        const shouldSync = shouldSyncBase && !targetLocked;
        if (l.code === leagueCode || (shouldSync && l.members.includes(userId))) {
          const picks = { ...(l.picks || {}) };
          picks[userId] = { ...(picks[userId] || {}) };
          picks[userId][gameId] = { ...(picks[userId][gameId] || {}) };
          const currentPick = picks[userId][gameId][pickType];
          if (currentPick === value) {
            delete picks[userId][gameId][pickType];
            if (picks[userId][gameId].editedAt) {
              delete picks[userId][gameId].editedAt;
            }
            if (picks[userId][gameId].timestamp) {
              delete picks[userId][gameId].timestamp;
            }
            if (Object.keys(picks[userId][gameId]).length === 0) {
              delete picks[userId][gameId];
            }
          } else {
            // Normalize value before saving to keep server scoring consistent
            let normalized = value;
            if (game) {
              if (pickType === 'spread' || pickType === 'winner') {
                // Map full team name to abbreviation if needed
                if (value === game.homeTeam) normalized = game.homeAbbr || value;
                else if (value === game.awayTeam) normalized = game.awayAbbr || value;
              } else if (pickType === 'total') {
                // Ensure lowercase 'over'/'under'
                normalized = String(value).toLowerCase();
              }
            }
            picks[userId][gameId][pickType] = normalized;
            const now = new Date().toISOString();
            if (isEdit) {
              picks[userId][gameId].editedAt = now;
            }
            if (!picks[userId][gameId].timestamp) {
              picks[userId][gameId].timestamp = now;
            }
          }
          actuallyUpdatedCodes.add(l.code);
          return { ...l, picks };
        }
        if (shouldSyncBase && targetLocked) {
          skippedSyncTargets.push(l.code);
        }
        return l;
      });

      setLeagues(updated);
      setPickVersion(v => v + 1);

      // Save to local storage immediately for reliability
      try {
        await saveLeagues(updated);
        console.log('✅ Picks saved to local storage successfully');
      } catch (e) {
        console.warn('Failed to save picks locally:', e);
        Alert.alert('Warning', 'Could not save picks locally. Your picks may not be restored if you close the app.');
      }

      // Save to Supabase for cloud sync
      try {
        const now = new Date();
        const seasonStart2025 = new Date('2025-09-04T00:00:00');
        const diffTime = now - seasonStart2025;
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        const week = now >= seasonStart2025 ? Math.max(1, Math.min(18, Math.floor(diffDays / 7) + 1)) : 9;
        
        const online = await isOnline();
        const leaguesToSave = updated.filter(l => actuallyUpdatedCodes.has(l.code));
        
        for (const updatedLeague of leaguesToSave) {
          const gamePicks = updatedLeague?.picks?.[userId]?.[gameId];
          
          if (online) {
            // Try to save directly to Supabase
            const { data, error } = await savePick({
              league_code: updatedLeague.code,
              user_id: userId,
              game_id: gameId,
              week: week,
              spread: gamePicks?.spread || null,
              total: gamePicks?.total || null,
              winner: gamePicks?.winner || null,
            });
            
            if (error) {
              console.error('Supabase savePick error:', error);
              console.error('Failed to save pick to Supabase:', error);
              // Queue for later if save failed
              await queueOfflinePick({
                leagueCode: updatedLeague.code,
                userId: userId,
                gameId: gameId,
                week: week,
                spread: gamePicks?.spread || null,
                total: gamePicks?.total || null,
                winner: gamePicks?.winner || null,
              });
              Alert.alert('Pick Queued', 'Could not save pick immediately. It will be saved when connection improves.');
            } else {
              console.log('✅ Supabase savePick success for game:', gameId, 'in league:', updatedLeague.code);
            }
          } else {
            // Offline - queue the pick
            console.log('📴 Offline: Queueing pick for later sync');
            await queueOfflinePick({
              leagueCode: updatedLeague.code,
              userId: userId,
              gameId: gameId,
              week: week,
              spread: gamePicks?.spread || null,
              total: gamePicks?.total || null,
              winner: gamePicks?.winner || null,
            });
          }
        }
        
        if (skippedSyncTargets.length > 0) {
          setToastType('info');
          setToastMessage(`Skipped sync to ${skippedSyncTargets.length} locked league(s).`);
          setToastVisible(true);
          setTimeout(() => setToastVisible(false), 2500);
        }
      } catch (error) {
        console.error('Failed to save pick to Supabase:', error);
        Alert.alert('Warning', 'Could not save picks to the server. Your picks are saved locally and will sync when online.');
      }
    } catch (error) {
      console.error('FATAL ERROR in updatePick:', error);
      Alert.alert('Error', 'Failed to save pick: ' + error.message);
    }
  };

  const getUserPick = (gameId) => {
    // Get fresh league data directly from props to avoid stale closures
    const freshLeague = leagues.find((l) => l.code === leagueCode);
    const pick = freshLeague?.picks?.[userId]?.[gameId];
    return pick;
  };

  const getLockOffsetMinutes = (lg) => {
    const m = lg?.settings?.lockOffsetMinutes;
    if (typeof m === 'number' && !Number.isNaN(m)) return m;
    const lt = lg?.settings?.lineLockTime;
    if (typeof lt === 'number' && !Number.isNaN(lt)) return Math.max(0, Math.round(lt * 60));
    if (lt === 'opening') return 60; // temporary mapping
    return 60;
  };

  const getGameStatus = (game) => {
    // Lines freeze at lockOffsetMinutes before kickoff (odds stop updating)
    // Picks remain editable until kickoff
    const lockOffsetMinutes = getLockOffsetMinutes(league);
    const startDate = game?.startISO ? new Date(game.startISO) : new Date(game?.gameTime);
    const lineFreezeTime = new Date(startDate.getTime() - (lockOffsetMinutes * 60 * 1000));
    const pickCutoffTime = startDate; // Picks lock at kickoff
    const now = new Date();
    const msUntilFreeze = lineFreezeTime - now;
    const msUntilCutoff = pickCutoffTime - now;

    const linesFrozen = msUntilFreeze <= 0;
    const picksClosed = msUntilCutoff <= 0;

    // For UI, show status based on whichever is soonest/most relevant
    if (picksClosed) {
      return { 
        locked: true, 
        linesFrozen: true, 
        picksClosed: true, 
        status: '🔒 Locked', 
        color: theme?.colors?.muted 
      };
    }
    
    if (linesFrozen) {
      // Lines frozen but picks still open
      const minutesUntilCutoff = Math.ceil(msUntilCutoff / (1000 * 60));
      if (minutesUntilCutoff < 60) {
        return { 
          locked: false, 
          linesFrozen: true, 
          picksClosed: false, 
          status: `📊 Lines frozen • ${minutesUntilCutoff}m to pick`, 
          color: '#f59e0b' 
        };
      }
      const hours = Math.floor(minutesUntilCutoff / 60);
      return { 
        locked: false, 
        linesFrozen: true, 
        picksClosed: false, 
        status: `📊 Lines frozen • ${hours}h to pick`, 
        color: '#f59e0b' 
      };
    }

    // Neither frozen nor closed
    const minutes = Math.ceil(msUntilFreeze / (1000 * 60));
    if (minutes < 60) {
      return { 
        locked: false, 
        linesFrozen: false, 
        picksClosed: false, 
        status: `⏰ ${minutes}m until freeze`, 
        color: theme?.colors?.danger 
      };
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return { 
        locked: false, 
        linesFrozen: false, 
        picksClosed: false, 
        status: `⏰ ${hours}h until freeze`, 
        color: '#f59e0b' 
      };
    }
    const days = Math.floor(hours / 24);
    return { 
      locked: false, 
      linesFrozen: false, 
      picksClosed: false, 
      status: `📅 ${days}d ${hours % 24}h`, 
      color: theme?.colors?.muted 
    };
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <Toast message={toastMessage} type={toastType} visible={toastVisible} onDismiss={() => setToastVisible(false)} />
        <View style={styles.screenHeader}>
          <Text style={styles.h1}>{league.name} — Make Picks</Text>
        </View>
        <SkeletonLoader theme={theme} styles={styles} />
        <SkeletonLoader theme={theme} styles={styles} />
        <SkeletonLoader theme={theme} styles={styles} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.container}>
        <View style={styles.screenHeader}>
          <Text style={styles.h1}>{league.name} — Make Picks</Text>
        </View>
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, padding: 24, alignItems: 'center' }]}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>⚠️</Text>
          <Text style={{ fontSize: 18, fontWeight: '700', color: theme?.colors?.text, marginBottom: 8, textAlign: 'center' }}>
            Unable to Load Games
          </Text>
          <Text style={{ color: theme?.colors?.muted, marginBottom: 24, textAlign: 'center' }}>
            {error}
          </Text>
          <Pressable 
            style={[styles.btnBlue, { width: '100%' }]} 
            onPress={() => {
              setError(null);
              fetchNFLGames();
            }}
          >
            <Text style={styles.btnTxt}>Try Again</Text>
          </Pressable>
          <Pressable 
            style={[styles.card, { marginTop: 12, width: '100%', padding: 12, backgroundColor: theme?.colors?.surface }]} 
            onPress={() => setTab("Home")}
          >
            <Text style={{ color: theme?.colors?.text, fontWeight: '600', textAlign: 'center' }}>Return to Home</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (games.length === 0 && !loading) {
    return (
      <View style={styles.container}>
        <View style={styles.screenHeader}>
          <Text style={styles.h1}>{league.name} — Make Picks</Text>
        </View>
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, padding: 24, alignItems: 'center' }]}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>🏈</Text>
          <Text style={{ fontSize: 18, fontWeight: '700', color: theme?.colors?.text, marginBottom: 8, textAlign: 'center' }}>
            No Games This Week
          </Text>
          <Text style={{ color: theme?.colors?.muted, marginBottom: 24, textAlign: 'center' }}>
            Check back later for upcoming NFL games.
          </Text>
          <Pressable 
            style={[styles.btnBlue, { width: '100%' }]} 
            onPress={() => fetchNFLGames()}
          >
            <Text style={styles.btnTxt}>Refresh</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <ScrollView 
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          colors={[theme?.colors?.primary || '#2563eb']}
          tintColor={theme?.colors?.primary || '#2563eb'}
        />
      }
    >
      <View style={styles.screenHeader}>
        <Text style={styles.h1}>{league.name} — Make Picks</Text>
        <Text style={{ color: theme?.colors?.muted || '#6b7280' }}>
          {isMoneylineMode 
            ? 'Pick the winner of each game' 
            : 'Click spreads or over/under to make your picks'}
        </Text>
      </View>

      {/* Action Buttons */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <Pressable
          style={[styles.card, { flex: 1, backgroundColor: showHistory ? theme?.colors?.primary : theme?.colors?.card, padding: 12 }]}
          onPress={() => setShowHistory(!showHistory)}
        >
          <Text style={{ color: showHistory ? '#fff' : theme?.colors?.text, fontWeight: '600', textAlign: 'center', fontSize: 14 }}>
            📜 {showHistory ? 'Hide' : 'View'} History
          </Text>
        </Pressable>
      </View>

      {/* Clear All Picks Button */}
      {league?.picks?.[userId] && Object.keys(league.picks[userId]).length > 0 && (
        <Pressable
          style={[styles.card, { backgroundColor: theme?.colors?.danger || '#ef4444', padding: 10, marginBottom: 12 }]}
          onPress={() => {
            Alert.alert(
              'Clear All Picks?',
              'This will remove all your picks for this week. This cannot be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Clear All',
                  style: 'destructive',
                  onPress: () => {
                    const updated = leagues.map((l) => {
                      if (l.code === leagueCode) {
                        const picks = { ...l.picks };
                        // Only clear picks for games where picks aren't closed
                        const openGameIds = games
                          .filter(g => !getGameStatus(g).picksClosed)
                          .map(g => g.id);
                        
                        if (picks[userId]) {
                          openGameIds.forEach(gameId => {
                            delete picks[userId][gameId];
                          });
                        }
                        
                        return { ...l, picks };
                      }
                      return l;
                    });
                    setLeagues(updated);
                    Alert.alert('Picks Cleared', 'All open picks have been removed.');
                  },
                },
              ]
            );
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600', textAlign: 'center', fontSize: 14 }}>
            🗑️ Clear All Picks (Open Games)
          </Text>
        </Pressable>
      )}

      {/* Pick History */}
      {showHistory && (
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 12 }]}>
          <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 12 }]}>Your Pick History</Text>
          {(!league?.picks?.[userId] || Object.keys(league?.picks?.[userId] || {}).length === 0) ? (
            <Text style={{ color: theme?.colors?.muted, textAlign: 'center', paddingVertical: 20 }}>
              No picks yet. Start making picks below!
            </Text>
          ) : (
            <View>
              {Object.entries(league?.picks?.[userId] || {}).map(([gameId, pick]) => {
                const game = games.find(g => g.id === gameId);
                if (!game) return null;
                
                return (
                  <View key={gameId} style={{ borderBottomWidth: 1, borderBottomColor: theme?.colors?.border, paddingBottom: 8, marginBottom: 8 }}>
                    <Text style={{ color: theme?.colors?.text, fontWeight: '600', fontSize: 14, marginBottom: 4 }}>
                      {game.awayTeam} @ {game.homeTeam}
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {isMoneylineMode ? (
                        // Moneyline Mode: Show winner pick
                        pick.winner && (
                          <View style={{ backgroundColor: theme?.colors?.primary, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 }}>
                            <Text style={{ color: '#fff', fontSize: 12 }}>
                              Winner: {pick.winner}
                            </Text>
                          </View>
                        )
                      ) : (
                        // Standard Mode: Show spread and total
                        <>
                          {pick.spread && (
                            <View style={{ backgroundColor: theme?.colors?.primary, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 }}>
                              <Text style={{ color: '#fff', fontSize: 12 }}>
                                Spread: {pick.spread}
                              </Text>
                            </View>
                          )}
                          {pick.total && (
                            <View style={{ backgroundColor: theme?.colors?.success, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 }}>
                              <Text style={{ color: '#fff', fontSize: 12 }}>
                                {pick.total}
                              </Text>
                            </View>
                          )}
                        </>
                      )}
                    </View>
                    {pick.timestamp && (
                      <Text style={{ color: theme?.colors?.muted, fontSize: 10, marginTop: 4 }}>
                        Picked: {new Date(pick.timestamp).toLocaleString([], { 
                          month: 'short', 
                          day: 'numeric', 
                          hour: 'numeric', 
                          minute: '2-digit' 
                        })}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}

      {/* Picks Summary */}
      {games.length > 0 && (
        <>
          <View style={[styles.card, { backgroundColor: theme?.colors?.primary, marginBottom: 12 }]}>
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 4 }}>Your Progress</Text>
            <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800' }}>
              {games.filter(g => {
                const pick = league?.picks?.[userId]?.[g.id];
                return isMoneylineMode ? pick?.winner : (pick?.spread || pick?.total);
              }).length} / {games.length} games
            </Text>
            <Text style={{ color: '#fff', opacity: 0.9, fontSize: 12, marginTop: 2 }}>
              {games.filter(g => {
                const pick = league?.picks?.[userId]?.[g.id];
                return isMoneylineMode ? !pick?.winner : (!pick?.spread && !pick?.total);
              }).length} games without picks
            </Text>
          </View>

          {/* Unpicked Games Warning */}
          {games.filter(g => {
            const pick = league?.picks?.[userId]?.[g.id];
            const gameStatus = getGameStatus(g);
            const hasNoPick = isMoneylineMode ? !pick?.winner : (!pick?.spread || !pick?.total);
            return hasNoPick && !gameStatus.picksClosed;
          }).length > 0 && (
            <View style={[styles.card, { backgroundColor: '#fef3c7', borderWidth: 1, borderColor: '#f59e0b', marginBottom: 12 }]}>
              <Text style={{ color: '#92400e', fontSize: 14, fontWeight: '600', marginBottom: 4 }}>⚠️ Reminder</Text>
              <Text style={{ color: '#92400e', fontSize: 12 }}>
                You have {games.filter(g => {
                  const pick = league?.picks?.[userId]?.[g.id];
                  const gameStatus = getGameStatus(g);
                  const hasNoPick = isMoneylineMode ? !pick?.winner : (!pick?.spread || !pick?.total);
                  return hasNoPick && !gameStatus.picksClosed;
                }).length} incomplete pick{games.filter(g => {
                  const pick = league?.picks?.[userId]?.[g.id];
                  const gameStatus = getGameStatus(g);
                  const hasNoPick = isMoneylineMode ? !pick?.winner : (!pick?.spread || !pick?.total);
                  return hasNoPick && !gameStatus.picksClosed;
                }).length !== 1 ? 's' : ''}. Complete them before the games start!
              </Text>
            </View>
          )}
        </>
      )}
      
      {games.map((game) => {
        // Prefer league.locked_lines for display once available; never hide locked numbers
        const lockedLine = league?.locked_lines?.[game.id];
        const parseLockedSpread = (spreadStr, homeAbbr, awayAbbr) => {
          if (!spreadStr || spreadStr === 'N/A') return null;
          const m = String(spreadStr).match(/^([A-Z]{2,4})\s*([-+]?\d+(?:\.\d+)?)/);
          const n = String(spreadStr).match(/([-+]?\d+(?:\.\d+)?)/);
          if (!m && !n) return null;
          let line = null; let favSide = null; let token = null; let signed = null;
          if (m) {
            token = m[1];
            signed = m[2];
            line = Math.abs(parseFloat(signed));
            if (signed.startsWith('-')) {
              favSide = (token === homeAbbr) ? 'home' : (token === awayAbbr) ? 'away' : null;
            } else if (signed.startsWith('+')) {
              favSide = (token === homeAbbr) ? 'away' : (token === awayAbbr) ? 'home' : null;
            } else {
              favSide = (token === homeAbbr) ? 'home' : (token === awayAbbr) ? 'away' : null;
            }
          } else if (n) {
            line = Math.abs(parseFloat(n[1]));
            // Without token, default home favorite for negative, away if positive based on leading sign in string
            if (String(spreadStr).trim().startsWith('-')) favSide = 'home';
            else if (String(spreadStr).trim().startsWith('+')) favSide = 'away';
          }
          if (line == null || favSide == null) return null;
          const homeVal = favSide === 'home' ? -line : line;
          const awayVal = -homeVal;
          const fmt = (v) => v > 0 ? `+${v}` : `${v}`;
          return { home: fmt(homeVal), away: fmt(awayVal) };
        };
        const lockedSpreads = lockedLine?.spread ? parseLockedSpread(lockedLine.spread, game.homeAbbr, game.awayAbbr) : null;
        const displayHomeSpread = lockedSpreads ? lockedSpreads.home : game.homeSpread;
        const displayAwaySpread = lockedSpreads ? lockedSpreads.away : game.awaySpread;
        const displayOverUnder = lockedLine?.overUnder || game.overUnder;
        const userPick = getUserPick(game.id);
        const hasPicks = isMoneylineMode ? userPick?.winner : (userPick?.spread || userPick?.total);
        const isComplete = isMoneylineMode ? !!userPick?.winner : (userPick?.spread && userPick?.total);
        const gameStatus = getGameStatus(game);
        
        return (
          <View 
            key={game.id} 
            style={[
              styles.card, 
              { 
                backgroundColor: theme?.colors?.card || '#fff',
                borderLeftWidth: 4,
                borderLeftColor: gameStatus.picksClosed 
                  ? theme?.colors?.muted 
                  : isComplete 
                    ? theme?.colors?.success 
                    : !hasPicks 
                      ? theme?.colors?.danger 
                      : '#fbbf24',
                opacity: gameStatus.picksClosed ? 0.7 : 1,
              }
            ]}
          >
            {/* Column Headers */}
            <View style={{ flexDirection: "row", marginBottom: 8 }}>
              <View style={{ flex: 1 }}>
                {gameStatus.picksClosed ? (
                  <Text style={{ color: gameStatus.color, fontSize: 12, fontWeight: '600' }}>{gameStatus.status}</Text>
                ) : !hasPicks ? (
                  <Text style={{ color: theme?.colors?.danger, fontSize: 12, fontWeight: '600' }}>⚠️ No picks yet</Text>
                ) : hasPicks && !isComplete ? (
                  <Text style={{ color: '#f59e0b', fontSize: 12, fontWeight: '600' }}>⚠️ Incomplete</Text>
                ) : null}
              </View>
              {!isMoneylineMode && (
                <View style={{ flexDirection: "row", width: 140, justifyContent: "space-between" }}>
                  <Text style={{ color: theme?.colors?.muted || "#6b7280", fontSize: 12, width: 60, textAlign: "center" }}>SPREAD</Text>
                  <Text style={{ color: theme?.colors?.muted || "#6b7280", fontSize: 12, width: 60, textAlign: "center" }}>O/U</Text>
                </View>
              )}
            </View>

            {/* Away Team: Logo + Name + Spread + O/U */}
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View style={{ flexDirection: "row", alignItems: "center", flex: 1, marginRight: 8 }}>
                {game.awayLogo && <Image source={{ uri: game.awayLogo }} style={styles.logo} />}
                <Text style={{ marginLeft: 8, fontWeight: "600", fontSize: 16, flexShrink: 1, color: theme?.colors?.text }} numberOfLines={2}>
                  {game.awayTeam}
                </Text>
              </View>
              {isMoneylineMode ? (
                // Moneyline Mode: Single button to pick winner
                <Pressable
                  style={[
                    styles.pickButton,
                    { width: 80 },
                    (userPick?.winner === game.awayTeam || userPick?.winner === game.awayAbbr) && styles.pickButtonSelected,
                    gameStatus.picksClosed && { opacity: 0.5 }
                  ]}
                  onPress={() => {
                    if (!gameStatus.picksClosed) {
                      makePick(game.id, 'winner', game.awayTeam);
                    }
                  }}
                  disabled={gameStatus.picksClosed}
                >
                  <Text style={[
                    styles.pickButtonText,
                    (userPick?.winner === game.awayTeam || userPick?.winner === game.awayAbbr) && styles.pickButtonTextSelected
                  ]}>
                    {(userPick?.winner === game.awayTeam || userPick?.winner === game.awayAbbr) ? '✓ WIN' : 'Pick'}
                  </Text>
                </Pressable>
              ) : (
                // Standard Mode: Spread and O/U buttons
                <View style={{ flexDirection: "row", width: 140, justifyContent: "space-between" }}>
                  <Pressable
                    style={[
                      styles.pickButton,
                      (userPick?.spread === game.awayTeam || userPick?.spread === game.awayAbbr) && styles.pickButtonSelected,
                      gameStatus.picksClosed && { opacity: 0.5 }
                    ]}
                    onPress={() => {
                      if (!gameStatus.picksClosed) {
                        makePick(game.id, 'spread', game.awayTeam);
                      }
                    }}
                    disabled={gameStatus.picksClosed}
                  >
                    <Text style={[
                      styles.pickButtonText,
                      (userPick?.spread === game.awayTeam || userPick?.spread === game.awayAbbr) && styles.pickButtonTextSelected
                    ]}>
                      {displayAwaySpread || '—'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.pickButton,
                      (userPick?.total === 'over' || userPick?.total === 'O') && styles.pickButtonSelected,
                      gameStatus.picksClosed && { opacity: 0.5 }
                    ]}
                    onPress={() => {
                      console.log('Total (over) button pressed', { gameId: game.id, locked: gameStatus.picksClosed });
                      if (!gameStatus.picksClosed) {
                        makePick(game.id, 'total', 'over');
                      }
                    }}
                    disabled={gameStatus.picksClosed}
                  >
                    <Text style={[
                      styles.pickButtonText,
                      (userPick?.total === 'over' || userPick?.total === 'O') && styles.pickButtonTextSelected
                    ]}>
                      {displayOverUnder ? `O ${displayOverUnder}` : "—"}
                    </Text>
                  </Pressable>
                </View>
              )}
            </View>

            {/* Home Team: Logo + Name + Spread */}
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", flex: 1, marginRight: 8 }}>
                <Text style={{ color: theme?.colors?.muted || "#6b7280", fontSize: 14, fontWeight: "700", marginRight: 4 }}>@</Text>
                {game.homeLogo && <Image source={{ uri: game.homeLogo }} style={styles.logo} />}
                <Text style={{ marginLeft: 8, fontWeight: "600", fontSize: 16, flexShrink: 1, color: theme?.colors?.text }} numberOfLines={2}>
                  {game.homeTeam}
                </Text>
              </View>
              {isMoneylineMode ? (
                // Moneyline Mode: Single button to pick winner
                <Pressable
                  style={[
                    styles.pickButton,
                    { width: 80 },
                    (userPick?.winner === game.homeTeam || userPick?.winner === game.homeAbbr) && styles.pickButtonSelected,
                    gameStatus.picksClosed && { opacity: 0.5 }
                  ]}
                  onPress={() => {
                    if (!gameStatus.picksClosed) {
                      makePick(game.id, 'winner', game.homeTeam);
                    }
                  }}
                  disabled={gameStatus.picksClosed}
                >
                  <Text style={[
                    styles.pickButtonText,
                    (userPick?.winner === game.homeTeam || userPick?.winner === game.homeAbbr) && styles.pickButtonTextSelected
                  ]}>
                    {(userPick?.winner === game.homeTeam || userPick?.winner === game.homeAbbr) ? '✓ WIN' : 'Pick'}
                  </Text>
                </Pressable>
              ) : (
                // Standard Mode: Spread and U buttons
                <View style={{ flexDirection: "row", width: 140, justifyContent: "space-between" }}>
                  <Pressable
                    style={[
                      styles.pickButton,
                      (userPick?.spread === game.homeTeam || userPick?.spread === game.homeAbbr) && styles.pickButtonSelected,
                      gameStatus.picksClosed && { opacity: 0.5 }
                    ]}
                    onPress={() => {
                      if (!gameStatus.picksClosed) {
                        makePick(game.id, 'spread', game.homeTeam);
                      }
                    }}
                    disabled={gameStatus.picksClosed}
                  >
                    <Text style={[
                      styles.pickButtonText,
                      (userPick?.spread === game.homeTeam || userPick?.spread === game.homeAbbr) && styles.pickButtonTextSelected
                    ]}>
                      {displayHomeSpread || '—'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.pickButton,
                      (userPick?.total === 'under' || userPick?.total === 'U') && styles.pickButtonSelected,
                      gameStatus.picksClosed && { opacity: 0.5 }
                    ]}
                    onPress={() => {
                      if (!gameStatus.picksClosed) {
                        makePick(game.id, 'total', 'under');
                      }
                    }}
                    disabled={gameStatus.picksClosed}
                  >
                    <Text style={[
                      styles.pickButtonText,
                      (userPick?.total === 'under' || userPick?.total === 'U') && styles.pickButtonTextSelected
                    ]}>
                      {displayOverUnder ? `U ${displayOverUnder}` : "—"}
                    </Text>
                  </Pressable>
                </View>
              )}
            </View>

            {/* Game details at bottom */}
            <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme?.colors?.border || "#e5e7eb" }}>
              <Text style={{ color: theme?.colors?.muted || "#6b7280", fontSize: 14, textAlign: "center" }}>
                {game.venue} • {game.gameTime}
              </Text>
              {!gameStatus.picksClosed && (
                <Text style={{ color: gameStatus.color, fontSize: 12, textAlign: "center", marginTop: 4, fontWeight: '600' }}>
                  {gameStatus.status}
                </Text>
              )}
            </View>

            {/* Your Pick Summary */}
            {userPick && (isMoneylineMode ? userPick.winner : (userPick.spread || userPick.total)) && !gameStatus.picksClosed && (
              <View style={{ marginTop: 8, padding: 8, backgroundColor: theme?.colors?.success ? 'rgba(22,163,74,0.12)' : '#f0fdf4', borderRadius: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme?.colors?.success || "#16a34a", fontWeight: "600", textAlign: "center", fontSize: 14 }}>
                      {isMoneylineMode ? (
                        `✓ ${userPick.winner}`
                      ) : (
                        <>
                          {userPick.spread && `✓ ${userPick.spread} ${(userPick.spread === game.awayTeam || userPick.spread === game.awayAbbr) ? (displayAwaySpread || game.awaySpread) : (displayHomeSpread || game.homeSpread)}`}
                          {userPick.spread && userPick.total && ' • '}
                          {userPick.total && `✓ ${userPick.total === 'O' ? 'OVER' : userPick.total === 'U' ? 'UNDER' : userPick.total.toUpperCase()} ${displayOverUnder || game.overUnder}`}
                        </>
                      )}
                    </Text>
                    {userPick.editedAt && (
                      <Text style={{ color: '#f59e0b', fontSize: 10, textAlign: 'center', marginTop: 2, fontStyle: 'italic' }}>
                        ✏️ Edited {new Date(userPick.editedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </Text>
                    )}
                  </View>
                  {!gameStatus.locked && (
                    <Pressable
                      onPress={() => {
                        Alert.alert(
                          'Clear Pick?',
                          `Remove your ${isMoneylineMode ? 'pick' : (userPick.spread && userPick.total ? 'picks' : 'pick')} for this game?`,
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Clear',
                              style: 'destructive',
                              onPress: () => {
                                const updated = leagues.map((l) => {
                                  if (l.code === leagueCode) {
                                    const picks = { ...l.picks };
                                    if (picks[userId]?.[game.id]) {
                                      delete picks[userId][game.id];
                                    }
                                    return { ...l, picks };
                                  }
                                  return l;
                                });
                                setLeagues(updated);
                              },
                            },
                          ]
                        );
                      }}
                      style={{ padding: 6 }}
                    >
                      <Text style={{ color: theme?.colors?.danger || '#ef4444', fontSize: 18 }}>🗑️</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )}



            {/* Edit Notification */}
            {userPick && (isMoneylineMode ? userPick.winner : (userPick.spread || userPick.total)) && !gameStatus.locked && (
              <Text style={{ color: theme?.colors?.muted, fontSize: 11, textAlign: 'center', marginTop: 6, fontStyle: 'italic' }}>
                💡 You can change your {isMoneylineMode ? 'pick' : 'picks'} until game time
              </Text>
            )}
          </View>
        );
      })}
      
      <Pressable style={[styles.btnGreen, { marginTop: 16, marginBottom: 32 }]} onPress={() => setTab("Home")}>
        <Text style={styles.btnTxt}>Save Picks & Return Home</Text>
      </Pressable>
    </ScrollView>
  );
};

// CORRECTED: SCOREBOARD WITH YOUR EXACT LAYOUT
const ScoreboardScreen = ({ leagues, currentUser, tab, theme, styles, notifPrefs }) => {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all'); // 'all', 'live', 'mypicks'
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [countdown, setCountdown] = useState({}); // Track countdown for each game
  const [selectedWeek, setSelectedWeek] = useState(null); // null = auto-detect current week
  const [currentNFLWeek, setCurrentNFLWeek] = useState(1);
  const weekScrollViewRef = useRef(null);
  const userId = currentUser?.id;

  // Calculate current NFL week based on season start
  const getCurrentNFLWeek = () => {
    const now = new Date();
    
    // NFL 2025 Season Week Calculation
    // Week 1 starts: Tuesday, September 2, 2025
    // Each week runs Tuesday-Monday (ends after Monday Night Football)
    const seasonStart2025 = new Date('2025-09-02T00:00:00'); // Tuesday of Week 1

    if (now >= seasonStart2025) {
      // We're in the 2025 season
      const diffTime = now - seasonStart2025;
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      
      // Each week is 7 days: Tuesday-Monday
      // Week 1 = days 0-6 (Tue Sept 2 - Mon Sept 8)
      // Week 2 = days 7-13 (Tue Sept 9 - Mon Sept 15), etc.
      const week = Math.floor(diffDays / 7) + 1;
      return Math.max(1, Math.min(18, week));
    }

    // Offseason - default to week 1
    return 1;
  };

  const teamLogos = {
    "Arizona Cardinals": "https://a.espncdn.com/i/teamlogos/nfl/500/ari.png",
    "Atlanta Falcons": "https://a.espncdn.com/i/teamlogos/nfl/500/atl.png",
    "Baltimore Ravens": "https://a.espncdn.com/i/teamlogos/nfl/500/bal.png",
    "Buffalo Bills": "https://a.espncdn.com/i/teamlogos/nfl/500/buf.png",
    "Carolina Panthers": "https://a.espncdn.com/i/teamlogos/nfl/500/car.png",
    "Chicago Bears": "https://a.espncdn.com/i/teamlogos/nfl/500/chi.png",
    "Cincinnati Bengals": "https://a.espncdn.com/i/teamlogos/nfl/500/cin.png",
    "Cleveland Browns": "https://a.espncdn.com/i/teamlogos/nfl/500/cle.png",
    "Dallas Cowboys": "https://a.espncdn.com/i/teamlogos/nfl/500/dal.png",
    "Denver Broncos": "https://a.espncdn.com/i/teamlogos/nfl/500/den.png",
    "Detroit Lions": "https://a.espncdn.com/i/teamlogos/nfl/500/det.png",
    "Green Bay Packers": "https://a.espncdn.com/i/teamlogos/nfl/500/gb.png",
    "Houston Texans": "https://a.espncdn.com/i/teamlogos/nfl/500/htx.png",
    "Indianapolis Colts": "https://a.espncdn.com/i/teamlogos/nfl/500/ind.png",
    "Jacksonville Jaguars": "https://a.espncdn.com/i/teamlogos/nfl/500/jax.png",
    "Kansas City Chiefs": "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png",
    "Las Vegas Raiders": "https://a.espncdn.com/i/teamlogos/nfl/500/lv.png",
    "Los Angeles Chargers": "https://a.espncdn.com/i/teamlogos/nfl/500/lac.png",
    "Los Angeles Rams": "https://a.espncdn.com/i/teamlogos/nfl/500/lar.png",
    "Miami Dolphins": "https://a.espncdn.com/i/teamlogos/nfl/500/mia.png",
    "Minnesota Vikings": "https://a.espncdn.com/i/teamlogos/nfl/500/min.png",
    "New England Patriots": "https://a.espncdn.com/i/teamlogos/nfl/500/ne.png",
    "New Orleans Saints": "https://a.espncdn.com/i/teamlogos/nfl/500/no.png",
    "New York Giants": "https://a.espncdn.com/i/teamlogos/nfl/500/nyg.png",
    "New York Jets": "https://a.espncdn.com/i/teamlogos/nfl/500/nyj.png",
    "Philadelphia Eagles": "https://a.espncdn.com/i/teamlogos/nfl/500/phi.png",
    "Pittsburgh Steelers": "https://a.espncdn.com/i/teamlogos/nfl/500/pit.png",
    "San Francisco 49ers": "https://a.espncdn.com/i/teamlogos/nfl/500/sf.png",
    "Seattle Seahawks": "https://a.espncdn.com/i/teamlogos/nfl/500/sea.png",
    "Tampa Bay Buccaneers": "https://a.espncdn.com/i/teamlogos/nfl/500/tb.png",
    "Tennessee Titans": "https://a.espncdn.com/i/teamlogos/nfl/500/ten.png",
    "Washington Commanders": "https://a.espncdn.com/i/teamlogos/nfl/500/was.png",
  };

  const fetchNFLGames = async (week = null) => {
    try {
      setLoading(true);
      setError(null);

      // If no week specified, auto-detect current week
      const targetWeek = week !== null ? week : getCurrentNFLWeek();
      
      // Rate limiting check
      if (!espnRateLimiter.canMakeRequest()) {
        const waitTime = Math.ceil(espnRateLimiter.getWaitTime() / 1000);
        setError(`Rate limit reached. Please wait ${waitTime} seconds before refreshing.`);
        setLoading(false);
        return;
      }

      // Fetch specific week from ESPN API
      const espnRes = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${targetWeek}`,
        { 
          timeout: 10000,
          headers: { 'Accept': 'application/json' }
        }
      );
      
      if (!espnRes.ok) {
        if (espnRes.status === 429) {
          throw new Error('Rate limit exceeded. Please wait a moment and try again.');
        } else if (espnRes.status >= 500) {
          throw new Error('ESPN server error. Please try again later.');
        } else if (espnRes.status === 404) {
          throw new Error('No games found for this week.');
        }
        throw new Error(`ESPN API error: ${espnRes.status}`);
      }
      
      const espnData = await espnRes.json();
      
      if (!espnData || !espnData.events || espnData.events.length === 0) {
        setError('No games scheduled for this week.');
        setGames([]);
        setLoading(false);
        return;
      }

      const parsedGames = (espnData.events || []).map((event) => {
        const comp = event.competitions[0];
        const away = comp.competitors.find(c => c.homeAway === "away") || comp.competitors[0];
        const home = comp.competitors.find(c => c.homeAway === "home") || comp.competitors[1];
        const awayScore = Number(away.score || 0);
        const homeScore = Number(home.score || 0);
        const status = event.status.type.detail;
        const startISO = event.date;
        const gameTime = new Date(startISO).toLocaleString([], {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });

        // Get spread and total from ESPN odds
        const odds = comp.odds?.[0];
        let awaySpreadVal, homeSpreadVal, overUnderVal;
        
        // Get the actual spread value (the line, not the odds)
        if (odds) {
          // ESPN API structure: odds.spread or odds.details contains the actual line
          // Try different possible fields for the spread line
          if (odds.awayTeamOdds?.spreadLine !== undefined) {
            awaySpreadVal = parseFloat(odds.awayTeamOdds.spreadLine);
            homeSpreadVal = -awaySpreadVal;
          } else if (odds.homeTeamOdds?.spreadLine !== undefined) {
            homeSpreadVal = parseFloat(odds.homeTeamOdds.spreadLine);
            awaySpreadVal = -homeSpreadVal;
          } else if (odds.spread !== undefined) {
            // Sometimes it's just in odds.spread
            homeSpreadVal = parseFloat(odds.spread);
            awaySpreadVal = -homeSpreadVal;
          } else if (odds.details !== undefined) {
            // Check in details string
            const spreadMatch = odds.details.match(/([-+]?\d+\.?\d*)/);
            if (spreadMatch) {
              homeSpreadVal = parseFloat(spreadMatch[1]);
              awaySpreadVal = -homeSpreadVal;
            }
          }
          
          // Get over/under
          if (odds.overUnder !== undefined && odds.overUnder !== null) {
            overUnderVal = parseFloat(odds.overUnder);
          } else if (odds.total !== undefined && odds.total !== null) {
            overUnderVal = parseFloat(odds.total);
          }
        }
        
        // Format the values for display
        const awaySpread = (awaySpreadVal ?? null) !== null ? (awaySpreadVal > 0 ? `+${awaySpreadVal.toFixed(1)}` : awaySpreadVal.toFixed(1)) : "—";
        const homeSpread = (homeSpreadVal ?? null) !== null ? (homeSpreadVal > 0 ? `+${homeSpreadVal.toFixed(1)}` : homeSpreadVal.toFixed(1)) : "—";
        const overUnder = (overUnderVal ?? null) !== null ? `O/U ${overUnderVal.toFixed(1)}` : "—";

        let userPick = null;
        leagues.forEach(league => {
          if (league?.picks?.[userId]?.[event.id]) {
            const pick = league.picks[userId][event.id];
            userPick = pick.spread || pick.total ? pick : null;
          }
        });

        return {
          id: event.id,
          awayAbbr: away.team.abbreviation,
          homeAbbr: home.team.abbreviation,
          awayTeam: away.team.displayName,
          homeTeam: home.team.displayName,
          awayLogo: teamLogos[away.team.displayName],
          homeLogo: teamLogos[home.team.displayName],
          awayScore,
          homeScore,
          status,
          gameTime,
          venue: comp.venue?.fullName || "TBD",
          startISO,
          awaySpread,
          homeSpread,
          overUnder,
          awaySpreadNum: awaySpreadVal ?? null,
          homeSpreadNum: homeSpreadVal ?? null,
          overUnderNum: overUnderVal ?? null,
          userPick,
          isFinal: status.includes("Final"),
        };
      });

      // Persist final game results for stats AND populate game_results for automatic scoring
      try {
        const finals = parsedGames.filter(g => g.isFinal);
        if (finals.length) {
          // Persist local cache of finals
          const toMerge = finals.reduce((acc, g) => {
            acc[g.id] = {
              id: g.id,
              awayTeam: g.awayTeam,
              homeTeam: g.homeTeam,
              awayScore: g.awayScore,
              homeScore: g.homeScore,
              awaySpread: (typeof g.awaySpreadNum === 'number') ? g.awaySpreadNum : null,
              homeSpread: (typeof g.homeSpreadNum === 'number') ? g.homeSpreadNum : null,
              overUnder: (typeof g.overUnderNum === 'number') ? g.overUnderNum : null,
              isFinal: true,
              finalizedAt: new Date().toISOString(),
            };
            return acc;
          }, {});
          await mergeResults(toMerge);

          // Prefer Edge Function (service role) for game_results upsert to avoid RLS issues
          console.log(`[App] Detected ${finals.length} final games → edge populate-game-results`);
          const supabaseUrl = 'https://dqlbdwugykzhrrqtafbx.supabase.co';
          // Helper with one retry/backoff
          const callEdge = async () => {
            const url = `${supabaseUrl}/functions/v1/populate-game-results?week=${targetWeek}&season=2025`;
            const attempt = async () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            let res = await attempt();
            if (!res.ok) {
              // Retry once after 2s if 5xx or rate limited
              if (res.status >= 500 || res.status === 429) {
                await new Promise(r => setTimeout(r, 2000));
                res = await attempt();
              }
            }
            return res;
          };
          try {
            const edgeRes = await callEdge();
            if (!edgeRes.ok) {
              const txt = await edgeRes.text();
              console.warn('[GameResults] Edge function failed after retry:', edgeRes.status, txt);
            } else {
              const payload = await edgeRes.json();
              console.log(`[GameResults] Edge populate success: inserted=${payload.inserted} errors=${payload.errors}`);
            }
          } catch (edgeErr) {
            console.warn('[GameResults] Edge function request error (no fallback):', edgeErr?.message || edgeErr);
          }

          // Trigger weekly recompute per league
          try {
            for (const league of leagues) {
              if (!league?.code) continue;
              const { data: recomputeCount, error: recomputeErr } = await recomputeWeeklyPoints(league.code, targetWeek);
              if (recomputeErr) {
                console.warn(`[Scoring] Recompute failed for league ${league.code}:`, recomputeErr.message || recomputeErr);
              } else {
                console.log(`[Scoring] Recomputed weekly points for ${league.code} (users: ${recomputeCount ?? 'n/a'})`);
              }
            }
          } catch (autoErr) {
            console.warn('[Scoring] Automatic recompute error:', autoErr?.message || autoErr);
          }
        }
      } catch (persistErr) {
        console.warn('Failed to persist results:', persistErr?.message || persistErr);
      }

      setGames(parsedGames);

      // Schedule pick reminders 1 hour before each game if user has incomplete picks
      try {
        const now = new Date();
        for (const game of parsedGames) {
          if (!game.startISO || game.isFinal || game.statusState === 'in' || game.statusState === 'post') continue;
          const startTime = new Date(game.startISO);
          const reminderTime = new Date(startTime.getTime() - 60 * 60 * 1000); // 1 hour before
          if (reminderTime <= now) continue; // Skip past reminders
          // Check all leagues to see if user has made a pick for this game
          let hasCompletePick = false;
          for (const league of leagues) {
            const userPick = league?.picks?.[currentUser?.id]?.[game.id];
            if (userPick?.spread || userPick?.total) {
              hasCompletePick = true;
              break;
            }
          }
          if (hasCompletePick) continue; // Skip if user has already made a pick in any league
          if (notifPrefs && (!notifPrefs.enabled || !notifPrefs.gameReminders)) continue; // Skip if disabled
          await scheduleLocalNotification({
            title: '⏰ Game Starting Soon!',
            body: `${game.awayTeam} @ ${game.homeTeam} starts in 1 hour. Make your picks!`,
            date: reminderTime,
          });
        }

        // Schedule line lock notifications per game based on default league setting (first league if exists)
        try {
          const firstLeague = leagues[0];
          const lockOffsetMinutes = firstLeague ? (firstLeague.settings ? (typeof firstLeague.settings.lockOffsetMinutes === 'number' ? firstLeague.settings.lockOffsetMinutes : (typeof firstLeague.settings.lineLockTime === 'number' ? Math.round(firstLeague.settings.lineLockTime * 60) : 60)) : 60) : 60;
          if (!notifPrefs || (notifPrefs.enabled && notifPrefs.lineLocks)) {
            for (const game of parsedGames) {
              if (!game.startISO || game.isFinal || game.statusState === 'in' || game.statusState === 'post') continue;
              const startTime = new Date(game.startISO);
              const lockTime = new Date(startTime.getTime() - lockOffsetMinutes * 60 * 1000);
              await scheduleLineLockNotificationIfNeeded(game, lockTime);
            }
          }
        } catch (e) {
          console.warn('Failed to schedule line lock notifications:', e);
        }
      } catch (notifErr) {
        console.warn('Failed to schedule notifications:', notifErr);
      }
    } catch (err) {
      setError(err.message);
      console.error("Fetch Error:", err);
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchNFLGames(selectedWeek);
    setRefreshing(false);
  };

  // Helper function to check if a game is actually live (in progress)
  const isGameLive = (game) => {
    if (game.isFinal) return false;
    // ESPN uses status.type.state: 'pre' (scheduled), 'in' (in progress), 'post' (final)
    // But we only have the detail string, so check for time-based status
    // Live games will have quarter/time info like "1st 12:45", "2nd 8:23", "Half", etc.
    // Scheduled games will have date/time like "Thu, Oct 31 8:20 PM"
    const status = game.status;
    
    // If status contains day of week or PM/AM, it's scheduled, not live
    if (status.includes('Sun') || status.includes('Mon') || status.includes('Tue') || 
        status.includes('Wed') || status.includes('Thu') || status.includes('Fri') || 
        status.includes('Sat') || status.includes('PM') || status.includes('AM')) {
      return false;
    }
    
    // If it contains quarter info, it's live
    if (status.includes('1st') || status.includes('2nd') || status.includes('3rd') || 
        status.includes('4th') || status.includes('Half') || status.includes('OT') ||
        status.includes('Q1') || status.includes('Q2') || status.includes('Q3') || status.includes('Q4')) {
      return true;
    }
    
    return false;
  };

  useEffect(() => {
    if (tab === "Scoreboard") {
      const detectedWeek = getCurrentNFLWeek();
      setCurrentNFLWeek(detectedWeek);
      if (selectedWeek === null) {
        setSelectedWeek(detectedWeek);
      }
      fetchNFLGames(selectedWeek);
    }
  }, [tab, selectedWeek]);

  // Scroll to center selected week
  useEffect(() => {
    if (weekScrollViewRef.current && selectedWeek !== null) {
      // Each week button is 70px wide + 8px gap = 78px total
      const screenWidth = Dimensions.get('window').width;
      const buttonWidth = 78;
      // Calculate offset to center the button: 
      // (week index * button width) - (half screen) + (half button) + padding adjustment
      const offset = (selectedWeek - 1) * buttonWidth - (screenWidth / 2) + (buttonWidth / 2) + 16;
      
      // Scroll with slight delay to ensure render is complete
      setTimeout(() => {
        weekScrollViewRef.current?.scrollTo({ 
          x: Math.max(0, offset), 
          animated: true 
        });
      }, 50);
    }
  }, [selectedWeek]);

  useEffect(() => {
    // Auto-refresh every 60 seconds if there are live games AND viewing current week
    const isViewingCurrentWeek = selectedWeek === currentNFLWeek;
    const hasLiveGames = games.some(g => isGameLive(g));
    let interval;
    
    if (hasLiveGames && tab === "Scoreboard" && isViewingCurrentWeek) {
      interval = setInterval(() => {
        fetchNFLGames(selectedWeek);
      }, 60000); // Refresh every 60 seconds
    }
    
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [games, tab, selectedWeek, currentNFLWeek]);

  const filteredGames = games.filter(game => {
    if (filter === 'all') return true;
    if (filter === 'live') return isGameLive(game);
    if (filter === 'mypicks') return game.userPick;
    return true;
  });

  if (loading) return (
    <View style={styles.container}>
      <View style={styles.screenHeader}>
        <Text style={styles.h1}>NFL Scoreboard</Text>
        <Text style={styles.muted}>Loading games...</Text>
      </View>
      <SkeletonLoader theme={theme} styles={styles} />
      <SkeletonLoader theme={theme} styles={styles} />
      <SkeletonLoader theme={theme} styles={styles} />
    </View>
  );

  if (error) return (
    <View style={styles.container}>
      <View style={styles.screenHeader}>
        <Text style={styles.h1}>NFL Scoreboard</Text>
      </View>
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, padding: 24, alignItems: 'center' }]}>
        <Text style={{ fontSize: 48, marginBottom: 16 }}>⚠️</Text>
        <Text style={{ fontSize: 18, fontWeight: '700', color: theme?.colors?.text, marginBottom: 8, textAlign: 'center' }}>
          Unable to Load Scores
        </Text>
        <Text style={{ color: theme?.colors?.muted, marginBottom: 24, textAlign: 'center' }}>
          {error}
        </Text>
        <Pressable 
          style={[styles.btnBlue, { width: '100%' }]} 
          onPress={() => fetchNFLGames(selectedWeek)}
        >
          <Text style={styles.btnTxt}>Try Again</Text>
        </Pressable>
      </View>
    </View>
  );

  if (games.length === 0 && !loading) {
    return (
      <View style={styles.container}>
        <View style={styles.screenHeader}>
          <Text style={styles.h1}>NFL Scoreboard</Text>
        </View>
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, padding: 24, alignItems: 'center' }]}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>🏈</Text>
          <Text style={{ fontSize: 18, fontWeight: '700', color: theme?.colors?.text, marginBottom: 8, textAlign: 'center' }}>
            No Games This Week
          </Text>
          <Text style={{ color: theme?.colors?.muted, marginBottom: 24, textAlign: 'center' }}>
            Check back later for upcoming NFL games and live scores.
          </Text>
          <Pressable 
            style={[styles.btnBlue, { width: '100%' }]} 
            onPress={() => fetchNFLGames(selectedWeek)}
          >
            <Text style={styles.btnTxt}>Refresh</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.screenHeader}>
        <Text style={styles.h1}>NFL Scoreboard</Text>
        <Text style={styles.h2}>Week {selectedWeek || currentNFLWeek} • {games.length} Games</Text>
      </View>

      {/* Week Selector */}
      <View style={{ marginBottom: 12 }}>
        <ScrollView 
          ref={weekScrollViewRef}
          horizontal 
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
          onLayout={() => {
            // Scroll to selected week on initial layout
            if (selectedWeek && weekScrollViewRef.current) {
              const screenWidth = Dimensions.get('window').width;
              const buttonWidth = 78; // 70px button + 8px gap
              const offset = (selectedWeek - 1) * buttonWidth - (screenWidth / 2) + (buttonWidth / 2) + 16; // +16 for padding
              weekScrollViewRef.current.scrollTo({ x: Math.max(0, offset), animated: false });
            }
          }}
        >
          {[...Array(18)].map((_, idx) => {
            const week = idx + 1;
            const isCurrentWeek = week === currentNFLWeek;
            const isSelected = week === selectedWeek;
            const hasLiveGames = isCurrentWeek && isSelected && games.some(g => isGameLive(g));
            
            return (
              <Pressable
                key={week}
                style={[
                  styles.card,
                  { 
                    padding: 10,
                    minWidth: 70,
                    backgroundColor: isSelected 
                      ? theme?.colors?.primary 
                      : isCurrentWeek 
                        ? theme?.colors?.navActive
                        : theme?.colors?.card,
                    borderWidth: isCurrentWeek && !isSelected ? 2 : 0,
                    borderColor: theme?.colors?.primary
                  }
                ]}
                onPress={() => setSelectedWeek(week)}
              >
                <Text style={{ 
                  textAlign: 'center', 
                  fontWeight: isSelected || isCurrentWeek ? '700' : '600',
                  color: isSelected ? '#fff' : theme?.colors?.text,
                  fontSize: 12
                }}>
                  Week {week}
                </Text>
                {hasLiveGames && (
                  <Text style={{ 
                    textAlign: 'center', 
                    fontSize: 10,
                    color: '#fff',
                    marginTop: 2,
                    fontWeight: '700'
                  }}>
                    🔴 LIVE
                  </Text>
                )}
                {isCurrentWeek && !isSelected && (
                  <Text style={{ 
                    textAlign: 'center', 
                    fontSize: 10,
                    color: theme?.colors?.primary,
                    marginTop: 2
                  }}>
                    NOW
                  </Text>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Filter Buttons */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <Pressable
          style={[
            styles.card,
            { flex: 1, padding: 10, backgroundColor: filter === 'all' ? theme?.colors?.primary : theme?.colors?.card }
          ]}
          onPress={() => setFilter('all')}
        >
          <Text style={{ textAlign: 'center', fontWeight: '600', color: filter === 'all' ? '#fff' : theme?.colors?.text }}>
            All ({games.length})
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.card,
            { flex: 1, padding: 10, backgroundColor: filter === 'live' ? theme?.colors?.primary : theme?.colors?.card }
          ]}
          onPress={() => setFilter('live')}
        >
          <Text style={{ textAlign: 'center', fontWeight: '600', color: filter === 'live' ? '#fff' : theme?.colors?.text }}>
            Live ({games.filter(g => isGameLive(g)).length})
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.card,
            { flex: 1, padding: 10, backgroundColor: filter === 'mypicks' ? theme?.colors?.primary : theme?.colors?.card }
          ]}
          onPress={() => setFilter('mypicks')}
        >
          <Text style={{ textAlign: 'center', fontWeight: '600', color: filter === 'mypicks' ? '#fff' : theme?.colors?.text }}>
            My Picks ({games.filter(g => g.userPick).length})
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={filteredGames}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[theme?.colors?.primary || '#2563eb']}
            tintColor={theme?.colors?.primary || '#2563eb'}
          />
        }
        renderItem={({ item }) => (
          <View style={[styles.card, { backgroundColor: theme?.colors?.card || '#fff' }] }>
            {/* Column Headers */}
            <View style={{ flexDirection: "row", marginBottom: 8 }}>
              <View style={{ flex: 1 }} />
              <View style={{ flexDirection: "row", width: 200, justifyContent: "space-between" }}>
                <Text style={{ color: theme?.colors?.muted || "#6b7280", fontSize: 12, width: 60, textAlign: "right" }}>SPREAD</Text>
                <Text style={{ color: theme?.colors?.muted || "#6b7280", fontSize: 12, width: 60, textAlign: "right" }}>O/U</Text>
                <Text style={{ color: theme?.colors?.muted || "#6b7280", fontSize: 12, width: 60, textAlign: "right" }}>SCORE</Text>
              </View>
            </View>

            {/* Away Team: Logo + Name + Spread + O/U + Score */}
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
                {item.awayLogo && <Image source={{ uri: item.awayLogo }} style={styles.logo} />}
                <Text style={{ marginLeft: 8, fontWeight: "600", fontSize: 16, color: theme?.colors?.text }}>
                  {item.awayTeam}
                </Text>
              </View>
              <View style={{ flexDirection: "row", width: 200, justifyContent: "space-between" }}>
                <Text style={{ color: theme?.colors?.muted || "#6b7280", fontWeight: "500", width: 60, textAlign: "right" }}>
                  {item.awaySpread}
                </Text>
                <Text style={{ color: theme?.colors?.muted || "#6b7280", fontWeight: "500", width: 60, textAlign: "right" }}>
                  {item.overUnder}
                </Text>
                <Text style={{ color: theme?.colors?.text, fontWeight: "700", fontSize: 18, width: 60, textAlign: "right" }}>
                  {item.awayScore || '—'}
                </Text>
              </View>
            </View>

            {/* Home Team: Logo + Name + Spread + Score */}
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
                {item.homeLogo && <Image source={{ uri: item.homeLogo }} style={styles.logo} />}
                <Text style={{ marginLeft: 8, fontWeight: "600", fontSize: 16, color: theme?.colors?.text }}>
                  {item.homeTeam}
                </Text>
              </View>
              <View style={{ flexDirection: "row", width: 200, justifyContent: "space-between" }}>
                <Text style={{ color: theme?.colors?.muted || "#6b7280", fontWeight: "500", width: 60, textAlign: "right" }}>
                  {item.homeSpread}
                </Text>
                <Text style={{ color: theme?.colors?.muted || "#6b7280", fontWeight: "500", width: 60, textAlign: "right" }}>
                  {"\u00A0"}
                </Text>
                <Text style={{ color: theme?.colors?.text, fontWeight: "700", fontSize: 18, width: 60, textAlign: "right" }}>
                  {item.homeScore || '—'}
                </Text>
              </View>
            </View>

            {/* Game details at bottom */}
            <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme?.colors?.border || "#e5e7eb" }}>
              <Text style={{ color: theme?.colors?.muted || "#6b7280", fontSize: 14, textAlign: "center" }}>
                {item.venue} • {item.gameTime}
              </Text>
              {isGameLive(item) && (
                <Text style={{ color: theme?.colors?.success, fontSize: 12, textAlign: "center", marginTop: 4, fontWeight: '600' }}>
                  🔴 LIVE • {item.status}
                </Text>
              )}
              
              {/* Countdown Timer for upcoming games */}
              {!item.isFinal && item.status === 'Pre-Game' && (() => {
                const gameDate = new Date(item.gameTime);
                const now = new Date();
                const diffMs = gameDate - now;
                const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                
                if (diffHours < 0) return null;
                
                return (
                  <View style={{ marginTop: 6, padding: 6, backgroundColor: '#fef3c7', borderRadius: 6 }}>
                    <Text style={{ color: '#92400e', fontSize: 12, fontWeight: '700', textAlign: 'center' }}>
                      ⏰ Picks lock in {diffHours}h {diffMins}m
                    </Text>
                  </View>
                );
              })()}
            </View>

            {/* Final Score */}
            {item.isFinal && (
              <View style={{ marginTop: 8, padding: 8, backgroundColor: theme?.colors?.background, borderRadius: 6 }}>
                <Text style={{ fontSize: 16, fontWeight: "800", textAlign: "center", color: theme?.colors?.text }}>
                  FINAL
                </Text>
              </View>
            )}

            {/* Your Pick Results */}
            {item.userPick && (
              <View style={{ marginTop: 8 }}>
                {(() => {
                  const results = calculatePickResult(item.userPick, item);
                  const hasResults = item.isFinal && (results?.spreadResult || results?.totalResult);
                  
                  return (
                    <View>
                      {/* Show picks */}
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginBottom: hasResults ? 8 : 0 }}>
                        {item.userPick.spread && (
                          <View style={{ 
                            backgroundColor: hasResults && results.spreadResult === 'win' ? '#22c55e' : 
                                           hasResults && results.spreadResult === 'loss' ? '#ef4444' :
                                           hasResults && results.spreadResult === 'push' ? '#f59e0b' :
                                           theme?.colors?.primary,
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 6
                          }}>
                            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
                              {hasResults && results.spreadResult === 'win' ? '✓ ' : 
                               hasResults && results.spreadResult === 'loss' ? '✗ ' :
                               hasResults && results.spreadResult === 'push' ? '↔ ' : ''}
                              Spread: {item.userPick.spread}
                            </Text>
                          </View>
                        )}
                        {item.userPick.total && (
                          <View style={{ 
                            backgroundColor: hasResults && results.totalResult === 'win' ? '#22c55e' : 
                                           hasResults && results.totalResult === 'loss' ? '#ef4444' :
                                           hasResults && results.totalResult === 'push' ? '#f59e0b' :
                                           theme?.colors?.primary,
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 6
                          }}>
                            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
                              {hasResults && results.totalResult === 'win' ? '✓ ' : 
                               hasResults && results.totalResult === 'loss' ? '✗ ' :
                               hasResults && results.totalResult === 'push' ? '↔ ' : ''}
                              {item.userPick.total.toUpperCase()}
                            </Text>
                          </View>
                        )}
                      </View>
                      
                      {/* Show result summary */}
                      {hasResults && (
                        <Text style={{ 
                          textAlign: 'center', 
                          fontSize: 11, 
                          color: theme?.colors?.muted,
                          fontStyle: 'italic'
                        }}>
                          {results.spreadResult === 'win' && results.totalResult === 'win' && '🎉 Both picks won!'}
                          {results.spreadResult === 'loss' && results.totalResult === 'loss' && '😔 Both picks lost'}
                          {results.spreadResult === 'win' && results.totalResult === 'loss' && 'Split: Spread won, Total lost'}
                          {results.spreadResult === 'loss' && results.totalResult === 'win' && 'Split: Total won, Spread lost'}
                          {(results.spreadResult === 'push' || results.totalResult === 'push') && 'Push - No action'}
                        </Text>
                      )}
                    </View>
                  );
                })()}
              </View>
            )}
          </View>
        )}
        ListEmptyComponent={<Text style={styles.muted}>No games scheduled.</Text>}
      />
    </View>
  );
};

/* ---------- UI Components ---------- */

const AnimatedPressable = React.memo(({ children, onPress, style }) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 0.95,
      useNativeDriver: true,
    }).start();
  }, [scaleAnim]);

  const handlePressOut = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 3,
      tension: 40,
      useNativeDriver: true,
    }).start();
  }, [scaleAnim]);

  return (
    <Pressable onPressIn={handlePressIn} onPressOut={handlePressOut} onPress={onPress}>
      <Animated.View style={[style, { transform: [{ scale: scaleAnim }] }]}>
        {children}
      </Animated.View>
    </Pressable>
  );
});

const SkeletonLoader = React.memo(({ theme, styles }) => (
  <View style={[styles.card, { backgroundColor: theme?.colors?.card || '#fff' }]}>
    <View style={{ flexDirection: "row", marginBottom: 8 }}>
      <View style={{ flex: 1 }} />
      <View style={{ flexDirection: "row", width: 140, justifyContent: "space-between" }}>
        <View style={{ width: 60, height: 12, backgroundColor: theme?.colors?.border || '#e5e7eb', borderRadius: 4 }} />
        <View style={{ width: 60, height: 12, backgroundColor: theme?.colors?.border || '#e5e7eb', borderRadius: 4 }} />
      </View>
    </View>
    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
      <View style={{ width: 24, height: 24, backgroundColor: theme?.colors?.border || '#e5e7eb', borderRadius: 12 }} />
      <View style={{ marginLeft: 8, width: 150, height: 16, backgroundColor: theme?.colors?.border || '#e5e7eb', borderRadius: 4 }} />
      <View style={{ flex: 1 }} />
      <View style={{ width: 50, height: 14, backgroundColor: theme?.colors?.border || '#e5e7eb', borderRadius: 4 }} />
    </View>
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <View style={{ width: 24, height: 24, backgroundColor: theme?.colors?.border || '#e5e7eb', borderRadius: 12 }} />
      <View style={{ marginLeft: 8, width: 150, height: 16, backgroundColor: theme?.colors?.border || '#e5e7eb', borderRadius: 4 }} />
      <View style={{ flex: 1 }} />
      <View style={{ width: 50, height: 14, backgroundColor: theme?.colors?.border || '#e5e7eb', borderRadius: 4 }} />
    </View>
    <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme?.colors?.border || "#e5e7eb" }}>
      <View style={{ width: 200, height: 14, backgroundColor: theme?.colors?.border || '#e5e7eb', borderRadius: 4, alignSelf: "center" }} />
    </View>
  </View>
));

const Tab = React.memo(({ label, active, onPress, theme, styles }) => (
  <Pressable onPress={onPress} style={[styles.tab, active && [styles.tabActive, { backgroundColor: theme.colors.navActive }]]}>
    <Text style={[styles.tabTxt, active && styles.tabTxtActive]}>{label}</Text>
  </Pressable>
));

/* ---------- Notification Settings Screen ---------- */

const NotificationSettingsScreen = ({ theme, styles, setTab }) => {
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPrefs();
  }, []);

  const loadPrefs = async () => {
    const current = await getNotificationPrefs();
    setPrefs(current);
    setLoading(false);
  };

  const updatePref = async (key, value) => {
    const updated = { ...prefs, [key]: value };
    setPrefs(updated);
    await setNotificationPrefs(updated);
  };

  const SettingRow = ({ label, description, value, onValueChange, disabled }) => (
    <View style={{ 
      flexDirection: 'row', 
      alignItems: 'center', 
      justifyContent: 'space-between', 
      paddingVertical: 16, 
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme?.colors?.border,
      opacity: disabled ? 0.5 : 1,
    }}>
      <View style={{ flex: 1, marginRight: 16 }}>
        <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text, marginBottom: 4 }}>
          {label}
        </Text>
        {description && (
          <Text style={{ fontSize: 13, color: theme?.colors?.muted, lineHeight: 18 }}>
            {description}
          </Text>
        )}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
      />
    </View>
  );

  const SliderRow = ({ label, description, value, onValueChange, min, max, step, unit, disabled }) => (
    <View style={{ 
      paddingVertical: 16, 
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme?.colors?.border,
      opacity: disabled ? 0.5 : 1,
    }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text, marginBottom: 4 }}>
            {label}
          </Text>
          {description && (
            <Text style={{ fontSize: 13, color: theme?.colors?.muted, lineHeight: 18 }}>
              {description}
            </Text>
          )}
        </View>
        <Text style={{ fontSize: 16, fontWeight: '700', color: theme?.colors?.primary, marginLeft: 12 }}>
          {value} {unit}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>{min}</Text>
        <View style={{ flex: 1, height: 40, justifyContent: 'center' }}>
          <View style={{ height: 4, backgroundColor: theme?.colors?.border, borderRadius: 2 }}>
            <View style={{ 
              height: 4, 
              backgroundColor: theme?.colors?.primary, 
              borderRadius: 2,
              width: `${((value - min) / (max - min)) * 100}%`
            }} />
          </View>
          <Pressable
            style={{
              position: 'absolute',
              left: `${((value - min) / (max - min)) * 100}%`,
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: theme?.colors?.primary,
              marginLeft: -12,
              elevation: 4,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.25,
              shadowRadius: 4,
            }}
            onPress={() => {
              // Simple increment/decrement on press
              const newValue = value + step;
              if (newValue <= max) {
                onValueChange(newValue);
              }
            }}
            disabled={disabled}
          />
        </View>
        <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>{max}</Text>
      </View>
      {/* Quick select buttons */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        {[15, 30, 60, 120].map(preset => (
          <Pressable
            key={preset}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 6,
              backgroundColor: value === preset ? theme?.colors?.primary : theme?.colors?.background,
              borderWidth: 1,
              borderColor: theme?.colors?.border,
            }}
            onPress={() => !disabled && onValueChange(preset)}
            disabled={disabled}
          >
            <Text style={{ 
              fontSize: 12, 
              fontWeight: '600',
              color: value === preset ? '#fff' : theme?.colors?.text 
            }}>
              {preset}{unit}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );

  const SectionHeader = ({ title, icon }) => (
    <View style={{ 
      paddingHorizontal: 16, 
      paddingVertical: 12, 
      backgroundColor: theme?.colors?.background,
      borderBottomWidth: 1,
      borderBottomColor: theme?.colors?.border,
    }}>
      <Text style={{ fontSize: 14, fontWeight: '700', color: theme?.colors?.text, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {icon} {title}
      </Text>
    </View>
  );

  if (loading || !prefs) {
    return (
      <View style={[styles.container, { backgroundColor: theme?.colors?.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={theme?.colors?.primary} />
        <Text style={{ color: theme?.colors?.text, marginTop: 16 }}>Loading settings...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
      <View style={styles.screenHeader}>
        <Text style={styles.h1}>Notification Settings</Text>
        <Text style={styles.muted}>Customize when and how you receive notifications</Text>
      </View>

      {/* Master Toggle */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 16 }]}>
        <SettingRow
          label="Enable Notifications"
          description="Turn all notifications on or off"
          value={prefs.enabled}
          onValueChange={(val) => updatePref('enabled', val)}
        />
      </View>

      {/* Game Notifications */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 16 }]}>
        <SectionHeader title="Game Notifications" icon="🏈" />
        
        <SettingRow
          label="Game Reminders"
          description="Remind me before games start (per league)"
          value={prefs.gameReminders}
          onValueChange={(val) => updatePref('gameReminders', val)}
          disabled={!prefs.enabled}
        />

        {prefs.gameReminders && (
          <>
            <View style={{ 
              paddingHorizontal: 16, 
              paddingVertical: 12,
              backgroundColor: theme?.colors?.background,
              borderBottomWidth: 1,
              borderBottomColor: theme?.colors?.border,
            }}>
              <Text style={{ fontSize: 13, color: theme?.colors?.muted, fontStyle: 'italic' }}>
                Choose which reminder intervals you want to receive:
              </Text>
            </View>
            
            <SettingRow
              label="📅 24 Hour Reminder"
              description="Notify me 24 hours before first game"
              value={prefs.gameReminder24h ?? true}
              onValueChange={(val) => updatePref('gameReminder24h', val)}
              disabled={!prefs.enabled}
            />
            
            <SettingRow
              label="⏰ 4 Hour Reminder"
              description="Notify me 4 hours before first game"
              value={prefs.gameReminder4h ?? true}
              onValueChange={(val) => updatePref('gameReminder4h', val)}
              disabled={!prefs.enabled}
            />
            
            <SettingRow
              label="🚨 1 Hour Reminder"
              description="Notify me 1 hour before first game"
              value={prefs.gameReminder1h ?? true}
              onValueChange={(val) => updatePref('gameReminder1h', val)}
              disabled={!prefs.enabled}
            />
          </>
        )}

        <SettingRow
          label="Pick Deadline Alerts"
          description="Alert me when picks are about to lock"
          value={prefs.lineLocks}
          onValueChange={(val) => updatePref('lineLocks', val)}
          disabled={!prefs.enabled}
        />

        {prefs.lineLocks && (
          <SliderRow
            label="Alert Time"
            description="How long before lock to alert me"
            value={prefs.lineLockTime}
            onValueChange={(val) => updatePref('lineLockTime', val)}
            min={15}
            max={120}
            step={15}
            unit="min"
            disabled={!prefs.enabled}
          />
        )}
      </View>

      {/* League Notifications */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 16 }]}>
        <SectionHeader title="League Notifications" icon="🏆" />
        
        <SettingRow
          label="Weekly Results"
          description="Notify me when weekly results are available"
          value={prefs.weeklyResults}
          onValueChange={(val) => updatePref('weeklyResults', val)}
          disabled={!prefs.enabled}
        />

        <SettingRow
          label="Week Start"
          description="Notify me when a new week begins"
          value={prefs.weekStart}
          onValueChange={(val) => updatePref('weekStart', val)}
          disabled={!prefs.enabled}
        />

        <SettingRow
          label="League Invites"
          description="Notify me when I'm invited to a league"
          value={prefs.leagueInvites}
          onValueChange={(val) => updatePref('leagueInvites', val)}
          disabled={!prefs.enabled}
        />
      </View>

      {/* Chat Notifications */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 16 }]}>
        <SectionHeader title="Chat Notifications" icon="💬" />
        
        <SettingRow
          label="Mentions & Replies"
          description="When someone mentions or replies to me"
          value={prefs.chatMentions}
          onValueChange={(val) => updatePref('chatMentions', val)}
          disabled={!prefs.enabled}
        />

        <SettingRow
          label="All Chat Messages"
          description="Every message in league chat (can be frequent)"
          value={prefs.chatMessages}
          onValueChange={(val) => updatePref('chatMessages', val)}
          disabled={!prefs.enabled}
        />
      </View>

      {/* Other Notifications */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 16 }]}>
        <SectionHeader title="Other Notifications" icon="🎯" />
        
        <SettingRow
          label="Achievements"
          description="When I unlock new achievements or badges"
          value={prefs.achievements}
          onValueChange={(val) => updatePref('achievements', val)}
          disabled={!prefs.enabled}
        />
      </View>

      {/* Sound & Vibration */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 32 }]}>
        <SectionHeader title="Sound & Haptics" icon="🔊" />
        
        <SettingRow
          label="Sound"
          description="Play sound with notifications"
          value={prefs.soundEnabled}
          onValueChange={(val) => updatePref('soundEnabled', val)}
          disabled={!prefs.enabled}
        />

        <SettingRow
          label="Vibration"
          description="Vibrate with notifications"
          value={prefs.vibrationEnabled}
          onValueChange={(val) => updatePref('vibrationEnabled', val)}
          disabled={!prefs.enabled}
        />
      </View>

      {/* Info Footer */}
      <View style={{ marginHorizontal: 16, marginBottom: 32, padding: 16, backgroundColor: theme?.colors?.background, borderRadius: 12 }}>
        <Text style={{ color: theme?.colors?.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' }}>
          💡 Notification settings are saved locally. You can change them anytime.
        </Text>
      </View>
    </ScrollView>
  );
};

/* ---------- Auto-Pick Settings Screen ---------- */

const AutoPickSettingsScreen = ({ theme, styles, setTab, leagues }) => {
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPrefs();
  }, []);

  const loadPrefs = async () => {
    const current = await getAutoPickPrefs();
    setPrefs(current);
    setLoading(false);
  };

  const updatePref = async (key, value) => {
    const updated = { ...prefs, [key]: value };
    setPrefs(updated);
    await setAutoPickPrefs(updated);
  };

  const SettingRow = ({ label, description, value, onValueChange, disabled }) => (
    <View style={{ 
      flexDirection: 'row', 
      alignItems: 'center', 
      justifyContent: 'space-between', 
      paddingVertical: 16, 
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme?.colors?.border,
      opacity: disabled ? 0.5 : 1,
    }}>
      <View style={{ flex: 1, marginRight: 16 }}>
        <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text, marginBottom: 4 }}>
          {label}
        </Text>
        {description && (
          <Text style={{ fontSize: 13, color: theme?.colors?.muted, lineHeight: 18 }}>
            {description}
          </Text>
        )}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
      />
    </View>
  );

  const StrategyPicker = ({ label, description, value, onValueChange, strategies, disabled }) => (
    <View style={{ 
      paddingVertical: 16, 
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme?.colors?.border,
      opacity: disabled ? 0.5 : 1,
    }}>
      <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text, marginBottom: 4 }}>
        {label}
      </Text>
      {description && (
        <Text style={{ fontSize: 13, color: theme?.colors?.muted, lineHeight: 18, marginBottom: 12 }}>
          {description}
        </Text>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {strategies.map(strategy => {
          const isSelected = value === strategy;
          return (
            <Pressable
              key={strategy}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: isSelected ? theme?.colors?.primary : theme?.colors?.border,
                backgroundColor: isSelected ? theme?.colors?.primary : theme?.colors?.card,
                minWidth: '48%',
              }}
              onPress={() => !disabled && onValueChange(strategy)}
              disabled={disabled}
            >
              <Text style={{ 
                fontSize: 14, 
                fontWeight: '600', 
                color: isSelected ? '#fff' : theme?.colors?.text,
                marginBottom: 2,
              }}>
                {getStrategyDisplayName(strategy)}
              </Text>
              <Text style={{ 
                fontSize: 12, 
                color: isSelected ? 'rgba(255,255,255,0.8)' : theme?.colors?.muted,
              }}>
                {getStrategyDescription(strategy)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const SectionHeader = ({ title, icon }) => (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12, backgroundColor: theme?.colors?.background }}>
      <Text style={{ fontSize: 14, fontWeight: '700', color: theme?.colors?.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {icon} {title}
      </Text>
    </View>
  );

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme?.colors?.background, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={theme?.colors?.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme?.colors?.background }}>
      {/* Header */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 20, backgroundColor: theme?.colors?.bannerBg }}>
        <Pressable onPress={() => setTab('Profile')} style={{ marginBottom: 12 }}>
          <Text style={{ color: theme?.colors?.heading, fontSize: 16 }}>← Back</Text>
        </Pressable>
        <Text style={{ fontSize: 28, fontWeight: '700', color: theme?.colors?.heading, marginBottom: 6 }}>
          Auto-Pick Settings
        </Text>
        <Text style={{ fontSize: 14, color: theme?.colors?.muted }}>
          Automatically make picks when lines lock
        </Text>
      </View>

      {/* Master Toggle */}
      <SectionHeader title="Master Control" icon="🤖" />
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 12, borderRadius: 12, overflow: 'hidden' }]}>
        <SettingRow
          label="Enable Auto-Picks"
          description="Automatically make picks for games when lines lock if you haven't picked yet"
          value={prefs.enabled}
          onValueChange={(val) => updatePref('enabled', val)}
        />
      </View>

      {/* Spread Strategy */}
      <SectionHeader title="Spread Pick Strategy" icon="📊" />
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 12, borderRadius: 12, overflow: 'hidden' }]}>
        <StrategyPicker
          label="How to pick spreads"
          description="Choose the strategy for automatic spread picks"
          value={prefs.spreadStrategy}
          onValueChange={(val) => updatePref('spreadStrategy', val)}
          strategies={[
            AUTO_PICK_STRATEGIES.FAVORITES,
            AUTO_PICK_STRATEGIES.HOME_TEAMS,
            AUTO_PICK_STRATEGIES.AWAY_TEAMS,
            AUTO_PICK_STRATEGIES.SPREAD_FAVORITE,
            AUTO_PICK_STRATEGIES.SPREAD_UNDERDOG,
            AUTO_PICK_STRATEGIES.RANDOM,
          ]}
          disabled={!prefs.enabled}
        />
      </View>

      {/* Total Strategy */}
      <SectionHeader title="Total Pick Strategy" icon="🎯" />
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 12, borderRadius: 12, overflow: 'hidden' }]}>
        <StrategyPicker
          label="How to pick totals"
          description="Choose the strategy for automatic over/under picks"
          value={prefs.totalStrategy}
          onValueChange={(val) => updatePref('totalStrategy', val)}
          strategies={[
            AUTO_PICK_STRATEGIES.OVER,
            AUTO_PICK_STRATEGIES.UNDER,
            AUTO_PICK_STRATEGIES.RANDOM,
          ]}
          disabled={!prefs.enabled}
        />
      </View>

      {/* Behavior Settings */}
      <SectionHeader title="Behavior" icon="⚙️" />
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 12, borderRadius: 12, overflow: 'hidden' }]}>
        <SettingRow
          label="Only When Missing"
          description="Only auto-pick if you haven't made picks for a game"
          value={prefs.onlyWhenMissing}
          onValueChange={(val) => updatePref('onlyWhenMissing', val)}
          disabled={!prefs.enabled}
        />
        
        <SettingRow
          label="Notify on Auto-Pick"
          description="Send a notification when auto-picks are made"
          value={prefs.notifyOnAutoPick}
          onValueChange={(val) => updatePref('notifyOnAutoPick', val)}
          disabled={!prefs.enabled}
        />
      </View>

      {/* League Settings */}
      {leagues && leagues.length > 0 && (
        <>
          <SectionHeader title="League Settings" icon="🏈" />
          <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 12, borderRadius: 12, overflow: 'hidden' }]}>
            <SettingRow
              label="Apply to All Leagues"
              description="Enable auto-picks for all your leagues"
              value={prefs.applyToAllLeagues}
              onValueChange={(val) => updatePref('applyToAllLeagues', val)}
              disabled={!prefs.enabled}
            />
          </View>

          {!prefs.applyToAllLeagues && (
            <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginBottom: 12, borderRadius: 12, padding: 16 }]}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text, marginBottom: 12 }}>
                Excluded Leagues
              </Text>
              <Text style={{ fontSize: 13, color: theme?.colors?.muted, marginBottom: 16 }}>
                Select leagues to exclude from auto-picks
              </Text>
              {leagues.map(league => {
                const isExcluded = prefs.excludedLeagues?.includes(league.code);
                return (
                  <Pressable
                    key={league.code}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingVertical: 12,
                      borderBottomWidth: 1,
                      borderBottomColor: theme?.colors?.border,
                    }}
                    onPress={() => {
                      const excluded = prefs.excludedLeagues || [];
                      const updated = isExcluded
                        ? excluded.filter(code => code !== league.code)
                        : [...excluded, league.code];
                      updatePref('excludedLeagues', updated);
                    }}
                    disabled={!prefs.enabled}
                  >
                    <Text style={{ fontSize: 16, color: theme?.colors?.text, flex: 1 }}>
                      {league.name}
                    </Text>
                    <View style={{
                      width: 24,
                      height: 24,
                      borderRadius: 4,
                      borderWidth: 2,
                      borderColor: isExcluded ? theme?.colors?.danger : theme?.colors?.primary,
                      backgroundColor: isExcluded ? theme?.colors?.danger : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      {isExcluded && <Text style={{ color: '#fff', fontSize: 16 }}>✓</Text>}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </>
      )}

      {/* Info Footer */}
      <View style={{ marginHorizontal: 16, marginBottom: 32, padding: 16, backgroundColor: theme?.colors?.background, borderRadius: 12 }}>
        <Text style={{ color: theme?.colors?.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' }}>
          💡 Auto-picks are made when lines lock. You can always manually override by making your own picks before the deadline.
        </Text>
      </View>
    </ScrollView>
  );
};

/* ---------- Hall of Fame Screen ---------- */

const HallOfFameScreen = ({ theme, styles, setTab, leagueCode, leagues }) => {
  const [hofData, setHofData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [profilesMap, setProfilesMap] = useState(new Map());

  const league = leagues?.find(l => l.code === leagueCode);

  useEffect(() => {
    loadHallOfFame();
  }, [leagueCode]);

  const loadHallOfFame = async () => {
    try {
      setLoading(true);
      
      // Load results for calculation
      const results = await loadResults();
      
      // Calculate Hall of Fame from league data
      const calculated = calculateHallOfFame(league, results);
      setHofData(calculated);

      // Load user profiles for display names
      if (league?.members) {
        try {
          const { data: profiles } = await getProfilesByIds(league.members);
          setProfilesMap(profiles || new Map());
        } catch (e) {
          console.warn('Failed to load profiles for Hall of Fame:', e);
        }
      }
      
      setLoading(false);
    } catch (error) {
      console.warn('Failed to load Hall of Fame:', error);
      setLoading(false);
    }
  };

  const getDisplayName = (userId) => {
    const profile = profilesMap.get(userId);
    return profile?.display_name || profile?.username || userId?.slice(0, 8) || 'Unknown';
  };

  const RecordCard = ({ icon, title, record }) => {
    if (!record || !record.userId) return null;

    return (
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 12, padding: 16 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
          <Text style={{ fontSize: 32, marginRight: 12 }}>{icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, color: theme?.colors?.muted, textTransform: 'uppercase', fontWeight: '600' }}>
              {title}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: theme?.colors?.text }}>
            {getDisplayName(record.userId)}
          </Text>
          <View style={{ alignItems: 'flex-end' }}>
            {record.percentage !== undefined && (
              <Text style={{ fontSize: 24, fontWeight: '800', color: theme?.colors?.primary }}>
                {record.percentage.toFixed(1)}%
              </Text>
            )}
            {record.wins !== undefined && (
              <Text style={{ fontSize: 20, fontWeight: '800', color: theme?.colors?.primary }}>
                {record.wins} {record.wins === 1 ? 'win' : 'wins'}
              </Text>
            )}
            {record.streak !== undefined && (
              <Text style={{ fontSize: 20, fontWeight: '800', color: theme?.colors?.primary }}>
                {record.streak} {record.streak === 1 ? 'game' : 'games'}
              </Text>
            )}
            {record.points !== undefined && (
              <Text style={{ fontSize: 20, fontWeight: '800', color: theme?.colors?.primary }}>
                {record.points} {record.points === 1 ? 'point' : 'points'}
              </Text>
            )}
            {record.picks !== undefined && (
              <Text style={{ fontSize: 20, fontWeight: '800', color: theme?.colors?.primary }}>
                {record.picks} {record.picks === 1 ? 'pick' : 'picks'}
              </Text>
            )}
            {record.total !== undefined && (
              <Text style={{ fontSize: 13, color: theme?.colors?.muted }}>
                {record.wins}/{record.total} picks
              </Text>
            )}
            {record.week !== undefined && (
              <Text style={{ fontSize: 13, color: theme?.colors?.muted }}>
                Week {record.week}
              </Text>
            )}
          </View>
        </View>
      </View>
    );
  };

  const ChampionCard = ({ champion, index }) => (
    <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginBottom: 12, padding: 16 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
          <Text style={{ fontSize: 40, marginRight: 12 }}>
            {index === 0 ? '🏆' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅'}
          </Text>
          <View>
            <Text style={{ fontSize: 18, fontWeight: '700', color: theme?.colors?.text }}>
              {getDisplayName(champion.userId)}
            </Text>
            <Text style={{ fontSize: 14, color: theme?.colors?.muted }}>
              {champion.season || 'Current Season'}
            </Text>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 20, fontWeight: '800', color: theme?.colors?.primary }}>
            {champion.winPercentage?.toFixed(1) || '0.0'}%
          </Text>
          <Text style={{ fontSize: 13, color: theme?.colors?.muted }}>
            {champion.wins}-{champion.losses}
          </Text>
        </View>
      </View>
    </View>
  );

  const PerfectWeekCard = ({ entry, index }) => (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme?.colors?.border,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
        <Text style={{ fontSize: 20, marginRight: 12 }}>✨</Text>
        <View>
          <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>
            {getDisplayName(entry.userId)}
          </Text>
          <Text style={{ fontSize: 13, color: theme?.colors?.muted }}>
            Week {entry.week}
          </Text>
        </View>
      </View>
      <Text style={{ fontSize: 16, fontWeight: '700', color: theme?.colors?.success }}>
        {entry.points} pts
      </Text>
    </View>
  );

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme?.colors?.background, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={theme?.colors?.primary} />
      </View>
    );
  }

  if (!league) {
    return (
      <View style={{ flex: 1, backgroundColor: theme?.colors?.background, padding: 16 }}>
        <Text style={{ color: theme?.colors?.text }}>League not found</Text>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme?.colors?.background }}>
      {/* Header */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 20, backgroundColor: theme?.colors?.bannerBg }}>
        <Pressable onPress={() => setTab(`LeagueDetails:${leagueCode}`)} style={{ marginBottom: 12 }}>
          <Text style={{ color: theme?.colors?.heading, fontSize: 16 }}>← Back to League</Text>
        </Pressable>
        <Text style={{ fontSize: 28, fontWeight: '700', color: theme?.colors?.heading, marginBottom: 6 }}>
          Hall of Fame
        </Text>
        <Text style={{ fontSize: 14, color: theme?.colors?.muted }}>
          {league.name}
        </Text>
      </View>

      {/* Champions Section */}
      {hofData?.champions && hofData.champions.length > 0 && (
        <View style={{ padding: 16 }}>
          <Text style={{ fontSize: 20, fontWeight: '700', color: theme?.colors?.text, marginBottom: 16 }}>
            🏆 Champions
          </Text>
          {hofData.champions.map((champion, index) => (
            <ChampionCard key={index} champion={champion} index={index} />
          ))}
        </View>
      )}

      {/* Records Section */}
      <View style={{ padding: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: '700', color: theme?.colors?.text, marginBottom: 16 }}>
          📊 League Records
        </Text>
        
        <RecordCard
          icon="🎯"
          title="Highest Win Percentage"
          record={hofData?.records?.highestWinPercentage}
        />
        
        <RecordCard
          icon="🔥"
          title="Most Wins"
          record={hofData?.records?.mostWinsInSeason}
        />
        
        <RecordCard
          icon="⚡"
          title="Longest Win Streak"
          record={hofData?.records?.longestWinStreak}
        />
        
        <RecordCard
          icon="💎"
          title="Most Points (Single Week)"
          record={hofData?.records?.mostPointsInWeek}
        />
        
        <RecordCard
          icon="⭐"
          title="Most Points (Season)"
          record={hofData?.records?.mostPointsInSeason}
        />
        
        <RecordCard
          icon="🦾"
          title="Iron Man Award"
          record={hofData?.records?.ironMan}
        />
      </View>

      {/* Perfect Weeks */}
      {hofData?.records?.perfectWeeks && hofData.records.perfectWeeks.length > 0 && (
        <View style={{ padding: 16 }}>
          <Text style={{ fontSize: 20, fontWeight: '700', color: theme?.colors?.text, marginBottom: 16 }}>
            ✨ Perfect Weeks
          </Text>
          <View style={[styles.card, { backgroundColor: theme?.colors?.card, overflow: 'hidden' }]}>
            {hofData.records.perfectWeeks.slice(0, 10).map((entry, index) => (
              <PerfectWeekCard key={index} entry={entry} index={index} />
            ))}
          </View>
          {hofData.records.perfectWeeks.length > 10 && (
            <Text style={{ color: theme?.colors?.muted, fontSize: 13, marginTop: 8, textAlign: 'center' }}>
              + {hofData.records.perfectWeeks.length - 10} more perfect weeks
            </Text>
          )}
        </View>
      )}

      {/* Achievements */}
      {hofData?.achievements?.centurion && hofData.achievements.centurion.length > 0 && (
        <View style={{ padding: 16 }}>
          <Text style={{ fontSize: 20, fontWeight: '700', color: theme?.colors?.text, marginBottom: 16 }}>
            🏅 Achievements
          </Text>
          <View style={[styles.card, { backgroundColor: theme?.colors?.card, padding: 16 }]}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text, marginBottom: 12 }}>
              💯 Centurion Club (100+ Wins)
            </Text>
            {hofData.achievements.centurion.map((achievement, index) => (
              <View key={index} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 }}>
                <Text style={{ color: theme?.colors?.text }}>
                  {getDisplayName(achievement.userId)}
                </Text>
                <Text style={{ color: theme?.colors?.primary, fontWeight: '600' }}>
                  {achievement.wins} wins
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Empty State */}
      {(!hofData?.records?.highestWinPercentage && !hofData?.champions?.length) && (
        <View style={{ padding: 16 }}>
          <View style={[styles.card, { backgroundColor: theme?.colors?.card, padding: 40, alignItems: 'center' }]}>
            <Text style={{ fontSize: 48, marginBottom: 12 }}>🏆</Text>
            <Text style={{ fontSize: 18, fontWeight: '600', color: theme?.colors?.text, marginBottom: 8 }}>
              No Records Yet
            </Text>
            <Text style={{ fontSize: 14, color: theme?.colors?.muted, textAlign: 'center' }}>
              Start making picks to build your league's Hall of Fame!
            </Text>
          </View>
        </View>
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
};

/* ---------- Help & FAQ Screen ---------- */

const HelpScreen = ({ theme, styles, setTab }) => {
  const [expandedSection, setExpandedSection] = useState(null);

  const toggleSection = (section) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  const Section = ({ title, section, children }) => (
    <View style={[styles.card, { backgroundColor: theme.colors.card, marginBottom: 12 }]}>
      <Pressable
        onPress={() => toggleSection(section)}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <Text style={{ fontSize: 18, fontWeight: '700', color: theme.colors.text, flex: 1 }}>
          {title}
        </Text>
        <Text style={{ fontSize: 20, color: theme.colors.text }}>
          {expandedSection === section ? '−' : '+'}
        </Text>
      </Pressable>
      {expandedSection === section && (
        <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          {children}
        </View>
      )}
    </View>
  );

  const InfoText = ({ children, style }) => (
    <Text style={[{ color: theme.colors.text, fontSize: 15, lineHeight: 22, marginBottom: 12 }, style]}>
      {children}
    </Text>
  );

  const BulletPoint = ({ children }) => (
    <View style={{ flexDirection: 'row', marginBottom: 8 }}>
      <Text style={{ color: theme.colors.text, marginRight: 8 }}>•</Text>
      <Text style={{ color: theme.colors.text, fontSize: 15, lineHeight: 22, flex: 1 }}>
        {children}
      </Text>
    </View>
  );

  const ExampleBox = ({ children }) => (
    <View style={{ backgroundColor: theme.colors.background, padding: 12, borderRadius: 8, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: theme.colors.primary }}>
      {children}
    </View>
  );

  return (
    <ScrollView style={styles.container}>
      <View style={styles.screenHeader}>
        <Text style={styles.h1}>Help & FAQ</Text>
        <Text style={styles.muted}>Everything you need to know about playing</Text>
      </View>

      {/* Quick Start */}
      <Section title="🚀 Quick Start Guide" section="quickstart">
        <InfoText>
          Welcome to the NFL Pick'em app! Here's how to get started:
        </InfoText>
        <BulletPoint><Text style={{ fontWeight: '700' }}>1. Join or Create a League:</Text> Start by creating your own league or joining one with a league code</BulletPoint>
        <BulletPoint><Text style={{ fontWeight: '700' }}>2. Make Your Picks:</Text> Each week, pick against the spread and over/under for NFL games</BulletPoint>
        <BulletPoint><Text style={{ fontWeight: '700' }}>3. Track Results:</Text> Check the scoreboard and leaderboard to see how you're doing</BulletPoint>
        <BulletPoint><Text style={{ fontWeight: '700' }}>4. Compete:</Text> Climb the leaderboard and prove you're the best picker!</BulletPoint>
      </Section>

      {/* Understanding Spreads */}
      <Section title="📊 What is a Spread?" section="spreads">
        <InfoText>
          A <Text style={{ fontWeight: '700' }}>spread</Text> (or point spread) is a handicap that evens out the competition between two teams. The favorite gives points, and the underdog receives points.
        </InfoText>
        
        <ExampleBox>
          <Text style={{ color: theme.colors.text, fontWeight: '700', marginBottom: 8 }}>Example:</Text>
          <Text style={{ color: theme.colors.text, marginBottom: 4 }}>Kansas City Chiefs -3.5</Text>
          <Text style={{ color: theme.colors.text, marginBottom: 8 }}>Las Vegas Raiders +3.5</Text>
          <Text style={{ color: theme.colors.muted, fontSize: 13 }}>
            The Chiefs are favored by 3.5 points. They must win by 4+ points to "cover the spread."
          </Text>
        </ExampleBox>

        <InfoText style={{ fontWeight: '700' }}>How to Pick:</InfoText>
        <BulletPoint>If you pick the <Text style={{ fontWeight: '700' }}>Chiefs -3.5</Text>, they must win by 4 or more points for you to win</BulletPoint>
        <BulletPoint>If you pick the <Text style={{ fontWeight: '700' }}>Raiders +3.5</Text>, they can lose by 3 or fewer points (or win) for you to win</BulletPoint>
        
        <InfoText style={{ marginTop: 8 }}>
          <Text style={{ fontWeight: '700' }}>Tip:</Text> The spread is designed to make the game 50/50, so there's no "safe" pick!
        </InfoText>
      </Section>

      {/* Understanding Totals */}
      <Section title="🎯 What is Over/Under?" section="totals">
        <InfoText>
          The <Text style={{ fontWeight: '700' }}>over/under</Text> (or total) is a prediction of the combined score of both teams.
        </InfoText>
        
        <ExampleBox>
          <Text style={{ color: theme.colors.text, fontWeight: '700', marginBottom: 8 }}>Example:</Text>
          <Text style={{ color: theme.colors.text, marginBottom: 4 }}>Total: 47.5 points</Text>
          <Text style={{ color: theme.colors.muted, fontSize: 13, marginTop: 8 }}>
            If final score is Chiefs 28, Raiders 24 = 52 total points → OVER wins
          </Text>
          <Text style={{ color: theme.colors.muted, fontSize: 13 }}>
            If final score is Chiefs 20, Raiders 17 = 37 total points → UNDER wins
          </Text>
        </ExampleBox>

        <InfoText style={{ fontWeight: '700' }}>How to Pick:</InfoText>
        <BulletPoint><Text style={{ fontWeight: '700' }}>Pick OVER</Text> if you think the combined score will be higher than the total</BulletPoint>
        <BulletPoint><Text style={{ fontWeight: '700' }}>Pick UNDER</Text> if you think the combined score will be lower than the total</BulletPoint>
        
        <InfoText style={{ marginTop: 8 }}>
          <Text style={{ fontWeight: '700' }}>Tip:</Text> Consider weather, pace of play, and defensive strength when picking totals!
        </InfoText>
      </Section>

      {/* Moneyline Mania */}
      <Section title="💰 Moneyline Mania Mode" section="moneyline">
        <InfoText>
          In <Text style={{ fontWeight: '700' }}>Moneyline Mania</Text> leagues, you simply pick which team will WIN the game - no spreads or totals!
        </InfoText>
        
        <ExampleBox>
          <Text style={{ color: theme.colors.text, fontWeight: '700', marginBottom: 8 }}>Example:</Text>
          <Text style={{ color: theme.colors.text, marginBottom: 4 }}>Chiefs vs. Raiders</Text>
          <Text style={{ color: theme.colors.muted, fontSize: 13, marginTop: 8 }}>
            Pick Chiefs → They just need to win (by any score)
          </Text>
          <Text style={{ color: theme.colors.muted, fontSize: 13 }}>
            Pick Raiders → They just need to win (by any score)
          </Text>
        </ExampleBox>

        <InfoText>
          This mode is perfect for beginners who want to focus on picking winners without worrying about point spreads!
        </InfoText>
      </Section>

      {/* Scoring */}
      <Section title="🏆 How Scoring Works" section="scoring">
        <InfoText style={{ fontWeight: '700' }}>Points per Game:</InfoText>
        <BulletPoint>Correct spread pick: <Text style={{ fontWeight: '700' }}>1 point</Text></BulletPoint>
        <BulletPoint>Correct over/under pick: <Text style={{ fontWeight: '700' }}>1 point</Text></BulletPoint>
        <BulletPoint>Maximum per game: <Text style={{ fontWeight: '700' }}>2 points</Text> (if you get both right)</BulletPoint>
        
        <InfoText style={{ marginTop: 12, fontWeight: '700' }}>Moneyline Mania:</InfoText>
        <BulletPoint>Correct winner pick: <Text style={{ fontWeight: '700' }}>1 point</Text></BulletPoint>
        
        <InfoText style={{ marginTop: 12 }}>
          Your weekly score is the sum of all your correct picks. The player with the most points wins the week!
        </InfoText>
      </Section>

      {/* Making Picks */}
      <Section title="✍️ Making & Editing Picks" section="picks">
        <InfoText style={{ fontWeight: '700' }}>Pick Deadlines:</InfoText>
        <InfoText>
          By default, picks lock 1 hour before each game starts. Your league commissioner can adjust this in league settings.
        </InfoText>
        
        <InfoText style={{ marginTop: 12, fontWeight: '700' }}>Editing Picks:</InfoText>
        <BulletPoint>You can change your picks anytime before the lock time</BulletPoint>
        <BulletPoint>Pick changes happen instantly with no confirmation needed</BulletPoint>
        <BulletPoint>Your pick history will show when picks were edited</BulletPoint>
        
        <InfoText style={{ marginTop: 12, fontWeight: '700' }}>Missing Picks:</InfoText>
        <InfoText>
          If you don't make a pick before the lock time, you'll receive 0 points for that game. Make sure to get all your picks in on time!
        </InfoText>
      </Section>

      {/* League Types */}
      <Section title="🏅 League Types" section="leagues">
        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontWeight: '700', fontSize: 16, color: theme.colors.text, marginBottom: 6 }}>Individual</Text>
          <InfoText>Play solo and track your own performance over the season</InfoText>
        </View>

        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontWeight: '700', fontSize: 16, color: theme.colors.text, marginBottom: 6 }}>Free for All</Text>
          <InfoText>Everyone competes against each other. Highest score wins each week!</InfoText>
        </View>

        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontWeight: '700', fontSize: 16, color: theme.colors.text, marginBottom: 6 }}>Survivor</Text>
          <InfoText>The lowest-scoring player each week is eliminated. Last one standing wins!</InfoText>
        </View>

        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontWeight: '700', fontSize: 16, color: theme.colors.text, marginBottom: 6 }}>Head to Head</Text>
          <InfoText>Weekly matchups against other players, with playoffs at the end of the season</InfoText>
        </View>

        <View>
          <Text style={{ fontWeight: '700', fontSize: 16, color: theme.colors.text, marginBottom: 6 }}>Moneyline Mania</Text>
          <InfoText>Pick straight-up winners only - no spreads or totals to worry about!</InfoText>
        </View>
      </Section>

      {/* FAQ */}
      <Section title="❓ Frequently Asked Questions" section="faq">
        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontWeight: '700', fontSize: 15, color: theme.colors.text, marginBottom: 6 }}>
            Q: What happens if a game is postponed?
          </Text>
          <InfoText>
            If a game is postponed, your picks will remain locked. Points will be awarded once the game is played.
          </InfoText>
        </View>

        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontWeight: '700', fontSize: 15, color: theme.colors.text, marginBottom: 6 }}>
            Q: Can I join multiple leagues?
          </Text>
          <InfoText>
            Yes! You can join as many leagues as you want and make different picks for each one.
          </InfoText>
        </View>

        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontWeight: '700', fontSize: 15, color: theme.colors.text, marginBottom: 6 }}>
            Q: How do I invite friends to my league?
          </Text>
          <InfoText>
            Go to your league details and tap the "Invite" button. You can share via text, email, QR code, or just share the league code!
          </InfoText>
        </View>

        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontWeight: '700', fontSize: 15, color: theme.colors.text, marginBottom: 6 }}>
            Q: Can I change league settings after creating it?
          </Text>
          <InfoText>
            Yes, if you're the commissioner. Go to league settings and tap "Edit League Settings."
          </InfoText>
        </View>

        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontWeight: '700', fontSize: 15, color: theme.colors.text, marginBottom: 6 }}>
            Q: What if there's a tie in the weekly standings?
          </Text>
          <InfoText>
            Ties are broken by whoever submitted their picks first (based on timestamp).
          </InfoText>
        </View>

        <View>
          <Text style={{ fontWeight: '700', fontSize: 15, color: theme.colors.text, marginBottom: 6 }}>
            Q: Where do the spreads and odds come from?
          </Text>
          <InfoText>
            We pull live data from ESPN and The Odds API to ensure you have the most up-to-date lines.
          </InfoText>
        </View>
      </Section>

      {/* Contact/Support */}
      <View style={[styles.card, { backgroundColor: theme.colors.primary, marginBottom: 32 }]}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 8 }}>
          Still Have Questions?
        </Text>
        <Text style={{ color: '#fff', fontSize: 15, lineHeight: 22, marginBottom: 12 }}>
          We're here to help! Contact our support team or check out the tutorial in your profile settings.
        </Text>
        <Pressable
          style={{ backgroundColor: '#fff', padding: 12, borderRadius: 8, alignItems: 'center' }}
          onPress={() => setTab('Profile')}
        >
          <Text style={{ color: theme.colors.primary, fontWeight: '700', fontSize: 15 }}>
            Go to Profile
          </Text>
        </Pressable>
      </View>
      
      <AppFooter theme={theme} styles={styles} />
    </ScrollView>
  );
};

const ProfileScreen = ({ currentUser, profile, setProfile, setCurrentUser, theme, setThemeName, styles, leagues, setTab, syncPicksAcrossLeagues, setSyncPicksAcrossLeagues, onReplayOnboarding, onLogout }) => {
  const [editMode, setEditMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);

  // Initial values from profile/auth
  const initialUsername = profile?.username || currentUser?.user_metadata?.username || "";
  const initialDisplayName = profile?.display_name || currentUser?.user_metadata?.display_name || "";
  const initialEmail = currentUser?.email || profile?.email || "";
  const initialPhone = currentUser?.phone || currentUser?.user_metadata?.phone || profile?.phone || "";

  const [username, setUsername] = useState(initialUsername);
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState(initialPhone);

  // Calculate user stats from leagues
  const [userStats, setUserStats] = useState({
    totalPicks: 0,
    totalLeagues: 0,
    winRate: 0,
  });

  useEffect(() => {
    // Keep inputs in sync if profile/auth changes
    setUsername(profile?.username || currentUser?.user_metadata?.username || "");
    setDisplayName(profile?.display_name || currentUser?.user_metadata?.display_name || "");
    setEmail(currentUser?.email || profile?.email || "");
    setPhone(currentUser?.phone || currentUser?.user_metadata?.phone || profile?.phone || "");
  }, [profile, currentUser]);

  useEffect(() => {
    // Calculate stats from leagues
    if (!leagues || !currentUser?.id) return;

    let totalPicks = 0;
    let totalLeaguesCount = 0;

    leagues.forEach(league => {
      totalLeaguesCount++;
      const member = league.members?.find(m => m.userId === currentUser.id);
      if (member) {
        if (member.spreadPicks) totalPicks += Object.keys(member.spreadPicks).length;
        if (member.totalPicks) totalPicks += Object.keys(member.totalPicks).length;
      }
    });

    setUserStats({
      totalPicks,
      totalLeagues: totalLeaguesCount,
      winRate: 0, // TODO: Calculate based on game results
    });
  }, [leagues, currentUser]);

  const onCancel = () => {
    setError("");
    setSuccess("");
    setUsername(initialUsername);
    setDisplayName(initialDisplayName);
    setEmail(initialEmail);
    setPhone(initialPhone);
    setEditMode(false);
  };

  const onSave = async () => {
    try {
      setLoading(true);
      setError("");
      setSuccess("");

      if (!currentUser?.id) {
        setError("Not signed in");
        return;
      }

      const updatesProfile = {};
      const updatesMeta = {};

      if (username && username !== initialUsername) {
        updatesProfile.username = username;
        updatesMeta.username = username;
      }

      if (displayName && displayName !== initialDisplayName) {
        updatesProfile.display_name = displayName;
        updatesMeta.display_name = displayName;
      }

      // Only push phone to profile if the column exists (avoid schema errors)
      const profileHasPhone = profile && Object.prototype.hasOwnProperty.call(profile, 'phone');
      if (phone && phone !== initialPhone) {
        if (profileHasPhone) updatesProfile.phone = phone;
        updatesMeta.phone = phone;
      }

      // Email change (Supabase will send confirmation if required)
      const emailChanged = email && email !== initialEmail;
      if (emailChanged) {
        updatesProfile.email = email;
      }

      // Execute updates
      let updatedProfile = profile;
      if (Object.keys(updatesProfile).length) {
        const { data, error } = await updateUserProfile(currentUser.id, updatesProfile);
        if (error) throw new Error(error.message || 'Failed to update profile');
        updatedProfile = data || updatedProfile;
        setProfile(updatedProfile);
      }

      if (Object.keys(updatesMeta).length) {
        const { error } = await supabaseUpdateUserMetadata(updatesMeta);
        if (error) throw new Error(error.message || 'Failed to update account');
      }

      if (emailChanged) {
        const { error } = await supabaseUpdateUserEmail(email);
        if (error) throw new Error(error.message || 'Failed to update email');
        setSuccess("Email update requested. Check your inbox to confirm the change.");
      }

      // Refresh current user to reflect metadata/email changes
      const { user: refreshedUser } = await supabaseGetCurrentUser();
      if (refreshedUser) setCurrentUser(refreshedUser);

      if (!emailChanged) setSuccess("Profile updated successfully");
      setEditMode(false);
    } catch (e) {
      setError(e.message || "Update failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
      <View style={[styles.screenHeader, { backgroundColor: theme?.colors?.bannerBg }]}>
        <Text style={styles.h1}>Profile</Text>
      </View>

      {error ? <Text style={[styles.error, { marginHorizontal: 16 }]}>{error}</Text> : null}
      {success ? <Text style={[styles.success, { marginHorizontal: 16 }]}>{success}</Text> : null}

      {/* User Info Header */}
      <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginTop: 16, alignItems: 'center', paddingVertical: 24 }]}>
        {/* Avatar Placeholder */}
        <View style={{
          width: 80,
          height: 80,
          borderRadius: 40,
          backgroundColor: theme?.colors?.primary || '#2563eb',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 12
        }}>
          <Text style={{ fontSize: 32, fontWeight: '700', color: '#fff' }}>
            {(displayName || username || email)?.[0]?.toUpperCase() || '?'}
          </Text>
        </View>
        <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 4 }]}>
          {displayName || username || 'No Display Name'}
        </Text>
        <Text style={[styles.muted, { fontSize: 14 }]}>
          @{username || 'No Username'}
        </Text>
      </View>

      {/* Quick Stats */}
      <View style={{ marginHorizontal: 16, marginTop: 16 }}>
        <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 12 }]}>Quick Stats</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={[styles.card, { flex: 1, backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 16 }]}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: theme?.colors?.primary || '#2563eb', marginBottom: 4 }}>
              {userStats.totalPicks}
            </Text>
            <Text style={[styles.muted, { fontSize: 12 }]}>Total Picks</Text>
          </View>
          <View style={[styles.card, { flex: 1, backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 16 }]}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: theme?.colors?.success || '#16a34a', marginBottom: 4 }}>
              {userStats.winRate}%
            </Text>
            <Text style={[styles.muted, { fontSize: 12 }]}>Win Rate</Text>
          </View>
          <View style={[styles.card, { flex: 1, backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 16 }]}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: theme?.colors?.text, marginBottom: 4 }}>
              {userStats.totalLeagues}
            </Text>
            <Text style={[styles.muted, { fontSize: 12 }]}>Leagues</Text>
          </View>
        </View>
      </View>

      {/* Quick Actions */}
      <View style={{ marginHorizontal: 16, marginTop: 16 }}>
        <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 12 }]}>Quick Actions</Text>
        <Pressable 
          style={[styles.card, { backgroundColor: theme?.colors?.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }]}
          onPress={() => setTab('Friends')}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ fontSize: 32, marginRight: 12 }}>👥</Text>
            <View>
              <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>Friends</Text>
              <Text style={{ fontSize: 13, color: theme?.colors?.muted }}>Manage friends and compare stats</Text>
            </View>
          </View>
          <Text style={{ fontSize: 20, color: theme?.colors?.muted }}>›</Text>
        </Pressable>
        <Pressable 
          style={[styles.card, { backgroundColor: theme?.colors?.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
          onPress={() => setTab('Achievements')}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ fontSize: 32, marginRight: 12 }}>🏆</Text>
            <View>
              <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>Achievements</Text>
              <Text style={{ fontSize: 13, color: theme?.colors?.muted }}>View your unlocked badges</Text>
            </View>
          </View>
          <Text style={{ fontSize: 20, color: theme?.colors?.muted }}>›</Text>
        </Pressable>
      </View>

      {/* Settings Section */}
      <View style={{ marginHorizontal: 16, marginTop: 24 }}>
        <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 12 }]}>Settings</Text>
        
        <View style={[styles.card, { backgroundColor: theme?.colors?.card }]}>
          {/* Notifications */}
          <Pressable 
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: theme?.colors?.border }}
            onPress={() => setTab('NotificationSettings')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ fontSize: 28, marginRight: 10 }}>🔔</Text>
              <View>
                <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>Notifications</Text>
                <Text style={{ fontSize: 12, color: theme?.colors?.muted }}>Manage notification preferences</Text>
              </View>
            </View>
            <Text style={{ fontSize: 20, color: theme?.colors?.muted }}>›</Text>
          </Pressable>

          {/* Auto-Pick Settings */}
          <Pressable 
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: theme?.colors?.border }}
            onPress={() => setTab('AutoPickSettings')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ fontSize: 28, marginRight: 10 }}>🤖</Text>
              <View>
                <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>Auto-Picks</Text>
                <Text style={{ fontSize: 12, color: theme?.colors?.muted }}>Configure automatic pick settings</Text>
              </View>
            </View>
            <Text style={{ fontSize: 20, color: theme?.colors?.muted }}>›</Text>
          </Pressable>
          
          {/* Theme toggle */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 16, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: theme?.colors?.border, paddingBottom: 16 }}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.label, { color: theme?.colors?.text, fontSize: 16, fontWeight: '600' }]}>Dark Mode</Text>
              <Text style={[styles.muted, { fontSize: 12 }]}>Toggle between light and dark themes</Text>
            </View>
            <Switch
              value={theme?.name === 'dark'}
              onValueChange={async (val) => {
                const name = val ? 'dark' : 'light';
                setThemeName(name);
                try { await AsyncStorage.setItem('THEME_PREF', name); } catch {}
              }}
            />
          </View>

          {/* Master Picks Settings */}
          <View style={{ paddingVertical: 16, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: theme?.colors?.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={[styles.label, { color: theme?.colors?.text, fontSize: 16, fontWeight: '600' }]}>Master Picks</Text>
                <Text style={[styles.muted, { fontSize: 12 }]}>Make picks once and sync to multiple leagues</Text>
              </View>
              <Switch
                value={profile?.master_picks_enabled || false}
                onValueChange={async (val) => {
                  if (!currentUser?.id) return;
                  try {
                    const { data, error } = await updateUserProfile(currentUser.id, {
                      master_picks_enabled: val,
                      master_picks_leagues: val ? (profile?.master_picks_leagues || []) : []
                    });
                    if (error) throw error;
                    // Defensive: if Supabase doesn't return updated row, merge locally
                    if (data) {
                      setProfile(data);
                    } else {
                      setProfile({ ...(profile || {}), master_picks_enabled: val, master_picks_leagues: val ? (profile?.master_picks_leagues || []) : [] });
                    }
                  } catch (e) {
                    console.warn('Master picks toggle update failed:', e?.message || e);
                    Alert.alert('Error', `Failed to update master picks setting: ${e?.message || 'Unknown error'}`);
                    // Hint for missing columns
                    if (e?.message?.includes('column') && e?.message?.includes('master_picks')) {
                      Alert.alert('Migration Needed', 'Add master_picks_enabled (boolean) and master_picks_leagues (uuid[]) columns to public.profiles. See MASTER_PICKS_PROFILE_MIGRATION.sql');
                    }
                  }
                }}
              />
            </View>
            
            {profile?.master_picks_enabled && (
              <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme?.colors?.border }}>
                <Text style={[styles.label, { color: theme?.colors?.text, fontSize: 14, fontWeight: '600', marginBottom: 8 }]}>
                  Select Leagues to Sync
                </Text>
                
                {(() => {
                  // Normalize league.type to lowercase for matching (legacy casing differences)
                  const normalizeType = (t) => (t || '').toString().trim().toLowerCase();
                  // Support both camelCase and lowercase stored variants
                  const SPREAD_TYPES = ['individual','freeforall','free_for_all','freeforall','survivor','headtohead','head_to_head'];
                  const MONEYLINE_TYPES = ['moneylinemania','moneyline_mania','moneylinemania'];
                  const spreadLeagues = leagues.filter(l => SPREAD_TYPES.includes(normalizeType(l.type)));
                  const moneylineLeagues = leagues.filter(l => MONEYLINE_TYPES.includes(normalizeType(l.type)));
                  // Collect leagues not matched by either for visibility (optional)
                  const otherLeagues = leagues.filter(l => !spreadLeagues.includes(l) && !moneylineLeagues.includes(l));
                  const masterPicksLeagues = profile?.master_picks_leagues || [];
                  
                  const toggleLeague = async (leagueId) => {
                    if (!currentUser?.id) return;
                    try {
                      const newLeagues = masterPicksLeagues.includes(leagueId)
                        ? masterPicksLeagues.filter(id => id !== leagueId)
                        : [...masterPicksLeagues, leagueId];
                      const { data, error } = await updateUserProfile(currentUser.id, { master_picks_leagues: newLeagues });
                      if (error) throw error;
                      setProfile(data);
                    } catch (e) {
                      Alert.alert('Error', 'Failed to update league selection');
                    }
                  };
                  
                  return (
                    <>
                      {spreadLeagues.length > 0 && (
                        <View style={{ marginBottom: 12 }}>
                          <Text style={[styles.muted, { fontSize: 12, marginBottom: 8 }]}>Spread/Over-Under Leagues:</Text>
                          {spreadLeagues.map(league => (
                            <Pressable
                              key={league.id}
                              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 }}
                              onPress={() => toggleLeague(league.id)}
                            >
                              <View style={{ flex: 1 }}>
                                <Text style={{ color: theme?.colors?.text, fontSize: 14 }}>{league.name}</Text>
                                <Text style={{ color: theme?.colors?.muted, fontSize: 11 }}>
                                  Line lock: {league.settings?.lineLockTime || 1}hr before kickoff
                                </Text>
                              </View>
                              <View style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                borderWidth: 2,
                                borderColor: masterPicksLeagues.includes(league.id) ? (theme?.colors?.primary || '#2563eb') : theme?.colors?.border,
                                backgroundColor: masterPicksLeagues.includes(league.id) ? (theme?.colors?.primary || '#2563eb') : 'transparent',
                                alignItems: 'center',
                                justifyContent: 'center'
                              }}>
                                {masterPicksLeagues.includes(league.id) && (
                                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>✓</Text>
                                )}
                              </View>
                            </Pressable>
                          ))}
                        </View>
                      )}
                      
                      {moneylineLeagues.length > 0 && (
                        <View>
                          <Text style={[styles.muted, { fontSize: 12, marginBottom: 8 }]}>Moneyline Leagues:</Text>
                          {moneylineLeagues.map(league => (
                            <Pressable
                              key={league.id}
                              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 }}
                              onPress={() => toggleLeague(league.id)}
                            >
                              <View style={{ flex: 1 }}>
                                <Text style={{ color: theme?.colors?.text, fontSize: 14 }}>{league.name}</Text>
                                <Text style={{ color: theme?.colors?.muted, fontSize: 11 }}>
                                  Line lock: {league.settings?.lineLockTime || 1}hr before kickoff
                                </Text>
                              </View>
                              <View style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                borderWidth: 2,
                                borderColor: masterPicksLeagues.includes(league.id) ? (theme?.colors?.primary || '#2563eb') : theme?.colors?.border,
                                backgroundColor: masterPicksLeagues.includes(league.id) ? (theme?.colors?.primary || '#2563eb') : 'transparent',
                                alignItems: 'center',
                                justifyContent: 'center'
                              }}>
                                {masterPicksLeagues.includes(league.id) && (
                                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>✓</Text>
                                )}
                              </View>
                            </Pressable>
                          ))}
                        </View>
                      )}
                      
                      {spreadLeagues.length === 0 && moneylineLeagues.length === 0 && otherLeagues.length === 0 && (
                        <Text style={[styles.muted, { fontSize: 12, fontStyle: 'italic' }]}>
                          Join a league to enable master picks syncing
                        </Text>
                      )}
                      {otherLeagues.length > 0 && (
                        <View style={{ marginTop: 4 }}>
                          <Text style={[styles.muted, { fontSize: 11, marginBottom: 4 }]}>Other league types (not synced yet):</Text>
                          {otherLeagues.map(league => (
                            <View key={league.id} style={{ paddingVertical: 4 }}>
                              <Text style={{ color: theme?.colors?.muted, fontSize: 11 }}>{league.name} ({league.type})</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </>
                  );
                })()}
              </View>
            )}
          </View>
        </View>
      </View>

      {/* Help Section */}
      <View style={{ marginHorizontal: 16, marginTop: 24 }}>
        <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 12 }]}>Help</Text>
        <View style={[styles.card, { backgroundColor: theme?.colors?.card }]}>
          <Pressable 
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: theme?.colors?.border }}
            onPress={() => setTab('Help')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ fontSize: 28, marginRight: 10 }}>❓</Text>
              <View>
                <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>Help & FAQ</Text>
                <Text style={{ fontSize: 12, color: theme?.colors?.muted }}>Rules, scoring, and common questions</Text>
              </View>
            </View>
            <Text style={{ fontSize: 20, color: theme?.colors?.muted }}>›</Text>
          </Pressable>
          <Pressable 
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 12 }}
            onPress={onReplayOnboarding}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ fontSize: 28, marginRight: 10 }}>🎓</Text>
              <View>
                <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>Replay Onboarding</Text>
                <Text style={{ fontSize: 12, color: theme?.colors?.muted }}>View the intro tutorial again</Text>
              </View>
            </View>
            <Text style={{ fontSize: 20, color: theme?.colors?.muted }}>›</Text>
          </Pressable>
        </View>
      </View>

      {/* Legal Section */}
      <View style={{ marginHorizontal: 16, marginTop: 24 }}>
        <Text style={[styles.h2, { color: theme?.colors?.text, marginBottom: 12 }]}>Legal</Text>
        <View style={[styles.card, { backgroundColor: theme?.colors?.card }] }>
          <Pressable 
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: theme?.colors?.border }}
            onPress={() => setShowTerms(true)}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ fontSize: 28, marginRight: 10 }}>📄</Text>
              <View>
                <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>Terms of Service</Text>
                <Text style={{ fontSize: 12, color: theme?.colors?.muted }}>Version {LEGAL_VERSION}</Text>
              </View>
            </View>
            <Text style={{ fontSize: 20, color: theme?.colors?.muted }}>›</Text>
          </Pressable>
          <Pressable 
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 12 }}
            onPress={() => setShowPrivacy(true)}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ fontSize: 28, marginRight: 10 }}>🔒</Text>
              <View>
                <Text style={{ fontSize: 16, fontWeight: '600', color: theme?.colors?.text }}>Privacy Policy</Text>
                <Text style={{ fontSize: 12, color: theme?.colors?.muted }}>Version {LEGAL_VERSION}</Text>
              </View>
            </View>
            <Text style={{ fontSize: 20, color: theme?.colors?.muted }}>›</Text>
          </Pressable>
        </View>
      </View>

      {/* Account Information */}
      <View style={{ marginHorizontal: 16, marginTop: 24, marginBottom: 24 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Text style={[styles.h2, { color: theme?.colors?.text }]}>Account Information</Text>
          {!editMode && (
            <Pressable style={[styles.btnBlue, { paddingHorizontal: 16, paddingVertical: 8 }]} onPress={() => setEditMode(true)}>
              <Text style={styles.btnTxt}>Edit</Text>
            </Pressable>
          )}
        </View>

        <View style={[styles.card, { backgroundColor: theme?.colors?.card }]}>
          {/* Display Name */}
          <View style={{ marginBottom: 16 }}>
            <Text style={[styles.label, { color: theme?.colors?.muted, fontSize: 12, marginBottom: 4 }]}>DISPLAY NAME</Text>
            {editMode ? (
              <TextInput
                style={[styles.input, { backgroundColor: theme?.colors?.background, color: theme?.colors?.text }]}
                value={displayName}
                onChangeText={setDisplayName}
                autoCorrect={false}
                placeholder="Your public display name"
                placeholderTextColor={theme?.colors?.muted}
              />
            ) : (
              <Text style={[styles.valueText, { color: theme?.colors?.text, fontSize: 16 }]}>{displayName || 'Not set'}</Text>
            )}
          </View>

          {/* Username */}
          <View style={{ marginBottom: 16 }}>
            <Text style={[styles.label, { color: theme?.colors?.muted, fontSize: 12, marginBottom: 4 }]}>USERNAME</Text>
            {editMode ? (
              <TextInput
                style={[styles.input, { backgroundColor: theme?.colors?.background, color: theme?.colors?.text }]}
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                placeholderTextColor={theme?.colors?.muted}
              />
            ) : (
              <Text style={[styles.valueText, { color: theme?.colors?.text, fontSize: 16 }]}>@{username || 'Not set'}</Text>
            )}
          </View>

          {/* Email */}
          <View style={{ marginBottom: 16 }}>
            <Text style={[styles.label, { color: theme?.colors?.muted, fontSize: 12, marginBottom: 4 }]}>EMAIL</Text>
            {editMode ? (
              <TextInput
                style={[styles.input, { backgroundColor: theme?.colors?.background, color: theme?.colors?.text }]}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholderTextColor={theme?.colors?.muted}
              />
            ) : (
              <Text style={[styles.valueText, { color: theme?.colors?.text, fontSize: 16 }]}>{email || 'Not set'}</Text>
            )}
          </View>

          {/* Phone */}
          <View style={{ marginBottom: editMode ? 16 : 0 }}>
            <Text style={[styles.label, { color: theme?.colors?.muted, fontSize: 12, marginBottom: 4 }]}>PHONE NUMBER</Text>
            {editMode ? (
              <TextInput
                style={[styles.input, { backgroundColor: theme?.colors?.background, color: theme?.colors?.text }]}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                placeholderTextColor={theme?.colors?.muted}
              />
            ) : (
              <Text style={[styles.valueText, { color: theme?.colors?.text, fontSize: 16 }]}>{phone || 'Not set'}</Text>
            )}
          </View>

          {/* Edit Mode Actions */}
          {editMode && (
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <Pressable 
                style={[styles.btnBlue, { flex: 1, paddingVertical: 12 }]} 
                disabled={loading} 
                onPress={onCancel}
              >
                <Text style={styles.btnTxt}>Cancel</Text>
              </Pressable>
              <Pressable 
                style={[styles.btnGreen, { flex: 1, paddingVertical: 12 }, loading && styles.btnDisabled]} 
                disabled={loading} 
                onPress={onSave}
              >
                <Text style={styles.btnTxt}>{loading ? 'Saving...' : 'Save Changes'}</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
      
      {/* Logout Button */}
      <View style={{ marginHorizontal: 16, marginTop: 24, marginBottom: 80 }}>
        <Pressable
          style={[styles.card, { backgroundColor: theme?.colors?.danger, padding: 16 }]}
          onPress={async () => {
            Alert.alert(
              'Logout',
              'Are you sure you want to log out?',
              [
                { text: 'Cancel', style: 'cancel' },
                { 
                  text: 'Logout', 
                  style: 'destructive',
                  onPress: onLogout
                }
              ]
            );
          }}
        >
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', textAlign: 'center' }}>
            Logout
          </Text>
        </Pressable>
      </View>
      
      {/* Legal overlays */}
      {showTerms && (
        <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.modal, { backgroundColor: 'white', maxHeight: '80%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.h2}>Terms of Service</Text>
              <Pressable onPress={() => setShowTerms(false)}><Text style={{ fontSize: 20, color: '#666' }}>×</Text></Pressable>
            </View>
            <ScrollView style={{ paddingHorizontal: 8 }}>
              <Text style={{ color: '#333', lineHeight: 20, marginBottom: 16 }}>{TERMS_TEXT}</Text>
                </ScrollView>
                <Pressable 
                  style={[styles.btnGreen, { alignSelf: 'center', marginTop: 8, paddingHorizontal: 20, paddingVertical: 10 }]}
                  onPress={async () => {
                    setShowTutorial(false);
                    try { await AsyncStorage.setItem('TUTORIAL_COMPLETE', '1'); } catch {}
                  }}
                >
                  <Text style={styles.btnTxt}>Got it</Text>
                </Pressable>
          </View>
        </View>
      )}
      {showPrivacy && (
        <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.modal, { backgroundColor: 'white', maxHeight: '80%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.h2}>Privacy Policy</Text>
              <Pressable onPress={() => setShowPrivacy(false)}><Text style={{ fontSize: 20, color: '#666' }}>×</Text></Pressable>
            </View>
            <ScrollView style={{ paddingHorizontal: 8 }}>
              <Text style={{ color: '#333', lineHeight: 20, marginBottom: 16 }}>{PRIVACY_TEXT}</Text>
            </ScrollView>
          </View>
        </View>
      )}

      <AppFooter theme={theme} styles={styles} />
    </ScrollView>
  );
};

const Label = ({ text, styles }) => <Text style={styles.label}>{text}:</Text>;

// Wrap App with ErrorBoundary
const AppWithErrorBoundary = () => (
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

export default AppWithErrorBoundary;