import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, Switch, Alert, Image } from 'react-native';
import { getNotificationPrefs, setNotificationPrefs, defaultNotificationPrefs } from './notificationPrefs';
import { cancelAllNotifications, scheduleWeeklyResultsReminderIfNeeded } from './notifications';
import { loadResults } from './storage';
import { computeUserStats, evaluatePick } from './stats';
import { createFriendRequest, listFriends } from './supabaseFriends';
import { getUserProfile, updateUserProfile } from './supabaseProfile';
import { updateUserAvatar } from './avatarUtils';

export const UserProfileScreen = ({ userId, username, displayName, leagues, currentUser, theme, onBack }) => {
  const [stats, setStats] = useState(null);
  const [pickHistory, setPickHistory] = useState([]);
  const [results, setResults] = useState({});
  const [showHistory, setShowHistory] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState(defaultNotificationPrefs);
  const [mutualLeagues, setMutualLeagues] = useState([]);
  const [isFriend, setIsFriend] = useState(false);
  const [addingFriend, setAddingFriend] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const isOwnProfile = userId === currentUser?.id;
  const displayLabel = displayName || username || (userId ? `User ${userId.slice(0, 8)}` : 'User');

  useEffect(() => {
    loadUserData();
    loadProfileData();
    if (isOwnProfile) {
      (async () => {
        const prefs = await getNotificationPrefs();
        setNotifPrefs(prefs);
      })();
    }
    if (!isOwnProfile) {
      checkFriendStatus();
      findMutualLeagues();
    }
  }, [userId, leagues]);

  const loadProfileData = async () => {
    try {
      const { data, error } = await getUserProfile(userId);
      if (!error && data) {
        setAvatarUrl(data.avatar_url);
      }
    } catch (e) {
      console.warn('Failed to load profile data:', e);
    }
  };

  const checkFriendStatus = async () => {
    try {
      const { data, error } = await listFriends();
      if (!error && data) {
        const exists = data.some(f => f.friend_id === userId);
        setIsFriend(exists);
      }
    } catch (e) {
      console.warn('Failed to check friend status:', e);
    }
  };

  const findMutualLeagues = () => {
    if (!leagues || !userId || !currentUser?.id) return;
    
    const mutual = leagues.filter(league => {
      const members = league.members || [];
      const hasCurrentUser = members.includes(currentUser.id);
      const hasOtherUser = members.includes(userId);
      return hasCurrentUser && hasOtherUser;
    });
    
    setMutualLeagues(mutual);
  };

  const handleAddFriend = async () => {
    if (!userId || !currentUser?.id) return;
    
    setAddingFriend(true);
    try {
      const { error } = await createFriendRequest(userId);
      if (error) {
        Alert.alert('Error', 'Failed to send friend request: ' + error.message);
      } else {
        Alert.alert('Success', 'Friend request sent!');
        // Optionally navigate back or update UI
      }
    } catch (e) {
      Alert.alert('Error', 'Failed to send friend request');
      console.error(e);
    } finally {
      setAddingFriend(false);
    }
  };

  const handleAvatarPress = async () => {
    if (!isOwnProfile) return; // Only allow own avatar editing
    
    setUploadingAvatar(true);
    const success = await updateUserAvatar(
      userId,
      avatarUrl,
      (newUrl) => {
        setAvatarUrl(newUrl);
      }
    );
    setUploadingAvatar(false);
  };

  const loadUserData = async () => {
    const res = await loadResults();
    setResults(res);

    const s = computeUserStats({
      leagues: leagues || [],
      userId,
      results: res,
      pickType: 'all',
      timePeriod: 'allTime',
    });
    setStats(s);

    // Build pick history
    const history = [];
    leagues.forEach(league => {
      const userPicks = league.picks?.[userId] || {};
      Object.entries(userPicks).forEach(([gameId, pick]) => {
        const result = res[gameId];
        if (result?.isFinal) {
          const outcome = evaluatePick(pick, result);
          if (pick.spread && outcome?.spreadResult) {
            history.push({
              gameId,
              leagueName: league.name,
              type: 'spread',
              pick: pick.spread,
              outcome: outcome.spreadResult,
              confidence: pick.confidence || 3,
              timestamp: pick.timestamp || result.finalizedAt,
              game: `${result.awayTeam} @ ${result.homeTeam}`,
              score: `${result.awayScore}-${result.homeScore}`,
            });
          }
          if (pick.total && outcome?.totalResult) {
            history.push({
              gameId,
              leagueName: league.name,
              type: 'total',
              pick: pick.total,
              outcome: outcome.totalResult,
              confidence: pick.confidence || 3,
              timestamp: pick.timestamp || result.finalizedAt,
              game: `${result.awayTeam} @ ${result.homeTeam}`,
              score: `${result.awayScore}-${result.homeScore}`,
              overUnder: result.overUnder,
            });
          }
        }
      });
    });
    history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    setPickHistory(history);
  };

  if (!stats) {
    return (
      <View style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
        <Text style={{ color: theme?.colors?.text, textAlign: 'center', marginTop: 40 }}>Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme?.colors?.bannerBg }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Pressable onPress={onBack} style={{ marginRight: 12 }}>
            <Text style={{ fontSize: 24, color: theme?.colors?.heading }}>←</Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={[styles.h1, { color: theme?.colors?.heading }]}>
              {displayLabel}
            </Text>
            <Text style={{ color: theme?.colors?.muted, fontSize: 14 }}>
              {isOwnProfile ? 'Your Profile' : 'Player Profile'}
            </Text>
          </View>
        </View>
      </View>

      {/* Avatar */}
      <View style={{ alignItems: 'center', marginTop: 24, marginBottom: 16 }}>
        <Pressable
          onPress={isOwnProfile ? handleAvatarPress : null}
          disabled={uploadingAvatar}
          style={{ opacity: uploadingAvatar ? 0.6 : 1 }}
        >
          <View style={{
            width: 100,
            height: 100,
            borderRadius: 50,
            backgroundColor: theme?.colors?.primary,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}>
            {avatarUrl ? (
              <Image
                source={{ uri: avatarUrl }}
                style={{ width: 100, height: 100 }}
                resizeMode="cover"
              />
            ) : (
              <Text style={{ fontSize: 40, fontWeight: '700', color: '#fff' }}>
                {(displayLabel || userId)?.[0]?.toUpperCase() || '?'}
              </Text>
            )}
          </View>
          
          {/* Edit Icon (only show on own profile) */}
          {isOwnProfile && (
            <View style={{
              position: 'absolute',
              bottom: 0,
              right: 0,
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: theme?.colors?.primary,
              borderWidth: 2,
              borderColor: theme?.colors?.background,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Text style={{ color: '#fff', fontSize: 16 }}>
                {uploadingAvatar ? '⏳' : '📷'}
              </Text>
            </View>
          )}
        </Pressable>
        
        {/* Quick Add Friend Button (only show if not own profile and not already friends) */}
        {!isOwnProfile && !isFriend && (
          <Pressable
            onPress={handleAddFriend}
            disabled={addingFriend}
            style={{
              marginTop: 12,
              paddingHorizontal: 20,
              paddingVertical: 8,
              backgroundColor: theme?.colors?.primary,
              borderRadius: 20,
              opacity: addingFriend ? 0.6 : 1,
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>
              {addingFriend ? 'Sending...' : '+ Add Friend'}
            </Text>
          </Pressable>
        )}
        
        {/* Friend Badge */}
        {!isOwnProfile && isFriend && (
          <View style={{
            marginTop: 12,
            paddingHorizontal: 16,
            paddingVertical: 6,
            backgroundColor: theme?.colors?.success + '20',
            borderRadius: 16,
            borderWidth: 1,
            borderColor: theme?.colors?.success,
          }}>
            <Text style={{ color: theme?.colors?.success, fontWeight: '600', fontSize: 13 }}>
              ✓ Friends
            </Text>
          </View>
        )}
      </View>

      {/* Mutual Leagues Section */}
      {!isOwnProfile && mutualLeagues.length > 0 && (
        <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
          <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>
            Mutual Leagues ({mutualLeagues.length})
          </Text>
          <View style={[styles.card, { backgroundColor: theme?.colors?.card }]}>
            {mutualLeagues.map((league, index) => (
              <View 
                key={league.code} 
                style={[
                  styles.row, 
                  { borderBottomWidth: index === mutualLeagues.length - 1 ? 0 : 1 }
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowLabel, { color: theme?.colors?.text, fontWeight: '600' }]}>
                    {league.name}
                  </Text>
                  <Text style={[styles.rowValue, { color: theme?.colors?.muted, fontSize: 12 }]}>
                    {league.type === 'nfl-spread' ? 'NFL Spread' : 
                     league.type === 'nfl-total' ? 'NFL Over/Under' : 
                     league.type === 'nfl-winner' ? 'NFL Winner' : 
                     league.type}
                  </Text>
                </View>
                <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>
                  {league.members?.length || 0} members
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Overall Stats */}
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Overall Performance</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={[styles.statCard, { flex: 1, backgroundColor: theme?.colors?.card }]}>
            <Text style={[styles.statValue, { color: theme?.colors?.text }]}>{stats.winPercentage}%</Text>
            <Text style={[styles.statLabel, { color: theme?.colors?.muted }]}>Win Rate</Text>
            <Text style={[styles.statSubtext, { color: theme?.colors?.muted }]}>
              {stats.overallWins}-{stats.overallLosses}
            </Text>
          </View>
          <View style={[styles.statCard, { flex: 1, backgroundColor: theme?.colors?.card }]}>
            <Text style={[styles.statValue, { color: theme?.colors?.text }]}>{stats.totalPicks}</Text>
            <Text style={[styles.statLabel, { color: theme?.colors?.muted }]}>Total Picks</Text>
          </View>
        </View>
      </View>

      {/* Streaks */}
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Streaks</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={[styles.statCard, { flex: 1, backgroundColor: theme?.colors?.card }]}>
            <Text style={[styles.statValue, { color: theme?.colors?.text }]}>{stats.currentStreak?.count || 0}</Text>
            <Text style={[styles.statLabel, { color: theme?.colors?.muted }]}>Current Streak</Text>
            <Text style={[styles.statSubtext, { color: theme?.colors?.muted }]}>
              {stats.currentStreak?.type || 'none'}
            </Text>
          </View>
          <View style={[styles.statCard, { flex: 1, backgroundColor: theme?.colors?.card }]}>
            <Text style={[styles.statValue, { color: theme?.colors?.text }]}>{stats.longestWinStreak}</Text>
            <Text style={[styles.statLabel, { color: theme?.colors?.muted }]}>Longest Win Streak</Text>
          </View>
        </View>
      </View>

      {/* Breakdown */}
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Breakdown</Text>
        <View style={[styles.card, { backgroundColor: theme?.colors?.card }]}>
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme?.colors?.text }]}>Spread Record</Text>
            <Text style={[styles.rowValue, { color: theme?.colors?.text }]}>
              {stats.spreadWins}-{stats.spreadLosses}-{stats.spreadPushes}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme?.colors?.text }]}>Spread Win %</Text>
            <Text style={[styles.rowValue, { color: theme?.colors?.success }]}>
              {stats.spreadWinPercentage}%
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme?.colors?.text }]}>Total Record</Text>
            <Text style={[styles.rowValue, { color: theme?.colors?.text }]}>
              {stats.totalWins}-{stats.totalLosses}-{stats.totalPushes}
            </Text>
          </View>
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <Text style={[styles.rowLabel, { color: theme?.colors?.text }]}>Total Win %</Text>
            <Text style={[styles.rowValue, { color: theme?.colors?.success }]}>
              {stats.totalWinPercentage}%
            </Text>
          </View>
        </View>
      </View>

      {/* Pick History */}
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <Pressable 
          onPress={() => setShowHistory(!showHistory)}
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}
        >
          <Text style={[styles.sectionTitle, { color: theme?.colors?.text, marginBottom: 0 }]}>
            Pick History ({pickHistory.length})
          </Text>
          <Text style={{ fontSize: 20, color: theme?.colors?.text }}>
            {showHistory ? '▼' : '▶'}
          </Text>
        </Pressable>

        {showHistory && (
          <View>
            {pickHistory.length === 0 ? (
              <View style={[styles.card, { backgroundColor: theme?.colors?.card, paddingVertical: 40, alignItems: 'center' }]}>
                <Text style={{ color: theme?.colors?.muted }}>No completed picks yet</Text>
              </View>
            ) : (
              pickHistory.slice(0, 20).map((pick, idx) => (
                <View
                  key={`${pick.gameId}-${pick.type}`}
                  style={[
                    styles.card,
                    {
                      backgroundColor: theme?.colors?.card,
                      marginBottom: 8,
                      borderLeftWidth: 4,
                      borderLeftColor:
                        pick.outcome === 'win'
                          ? theme?.colors?.success
                          : pick.outcome === 'loss'
                          ? theme?.colors?.error
                          : theme?.colors?.border,
                    }
                  ]}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: theme?.colors?.text }}>
                      {pick.game}
                    </Text>
                    <Text style={{
                      fontSize: 12,
                      fontWeight: '700',
                      color:
                        pick.outcome === 'win'
                          ? theme?.colors?.success
                          : pick.outcome === 'loss'
                          ? theme?.colors?.error
                          : theme?.colors?.muted
                    }}>
                      {pick.outcome.toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View>
                      <Text style={{ fontSize: 12, color: theme?.colors?.muted }}>
                        {pick.type === 'spread' ? `Picked ${pick.pick}` : `Picked ${pick.pick.toUpperCase()}`}
                      </Text>
                      <Text style={{ fontSize: 11, color: theme?.colors?.muted, marginTop: 2 }}>
                        {pick.leagueName} • {new Date(pick.timestamp).toLocaleDateString()}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontSize: 12, color: theme?.colors?.muted }}>
                        Final: {pick.score}
                      </Text>
                      <Text style={{ fontSize: 11, color: theme?.colors?.muted, marginTop: 2 }}>
                        {'⭐'.repeat(pick.confidence)}
                      </Text>
                    </View>
                  </View>
                </View>
              ))
            )}
          </View>
        )}
      </View>

      {/* Notification Preferences (only for own profile) */}
      {isOwnProfile && (
        <View style={{ paddingHorizontal: 16, marginBottom: 40 }}>
          <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Notifications</Text>

          <View style={[styles.card, { backgroundColor: theme?.colors?.card }]}>
            {/* Master Enable */}
            <View style={styles.row}>
              <Text style={[styles.rowLabel, { color: theme?.colors?.text }]}>Enable Notifications</Text>
              <Switch
                value={notifPrefs.enabled}
                onValueChange={async (val) => {
                  const updated = await setNotificationPrefs({ ...notifPrefs, enabled: val });
                  setNotifPrefs(updated);
                  if (!val) {
                    try { await cancelAllNotifications(); } catch {}
                  } else if (updated.weeklyResults) {
                    try { await scheduleWeeklyResultsReminderIfNeeded(); } catch {}
                  }
                }}
              />
            </View>

            {/* Game Reminders */}
            <View style={styles.row}>
              <Text style={[styles.rowLabel, { color: theme?.colors?.text }]}>Game Start Reminders</Text>
              <Switch
                value={notifPrefs.gameReminders && notifPrefs.enabled}
                onValueChange={async (val) => {
                  const updated = await setNotificationPrefs({ ...notifPrefs, gameReminders: val });
                  setNotifPrefs(updated);
                }}
                disabled={!notifPrefs.enabled}
              />
            </View>

            {/* Weekly Results */}
            <View style={[styles.row, { borderBottomWidth: 0 }]}>
              <Text style={[styles.rowLabel, { color: theme?.colors?.text }]}>Weekly Results</Text>
              <Switch
                value={notifPrefs.weeklyResults && notifPrefs.enabled}
                onValueChange={async (val) => {
                  const updated = await setNotificationPrefs({ ...notifPrefs, weeklyResults: val });
                  setNotifPrefs(updated);
                  if (val && updated.enabled) {
                    try { await scheduleWeeklyResultsReminderIfNeeded(); } catch {}
                  }
                }}
                disabled={!notifPrefs.enabled}
              />
            </View>
          </View>
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 20, paddingTop: 60, paddingBottom: 24 },
  h1: { fontSize: 28, fontWeight: '700', marginBottom: 0 },
  sectionTitle: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
  statCard: { padding: 16, borderRadius: 12, alignItems: 'center' },
  statValue: { fontSize: 32, fontWeight: '700', marginBottom: 4 },
  statLabel: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  statSubtext: { fontSize: 12, marginTop: 4 },
  card: { borderRadius: 12, padding: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  rowLabel: { fontSize: 14, fontWeight: '500' },
  rowValue: { fontSize: 14, fontWeight: '700' },
});
