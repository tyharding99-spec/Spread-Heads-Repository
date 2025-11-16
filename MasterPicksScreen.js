import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { snapshotLockedLines } from './supabaseLeague';
import { savePick } from './supabasePicks';
import { queueOfflinePick, isOnline } from './offlineQueue';

export const MasterPicksScreen = ({ 
  currentUser, 
  profile, 
  leagues, 
  setLeagues,
  theme, 
  styles,
  setTab 
}) => {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [currentWeek, setCurrentWeek] = useState(null);
  
  // Master picks grouped by lock time: { lockTimeHours: { gameId: { spread, total, winner } } }
  const [masterPicksByLockTime, setMasterPicksByLockTime] = useState({});

  // Get leagues that are selected for master picks sync
  const masterPicksLeagues = (profile?.master_picks_leagues || [])
    .map(id => {
      // Try matching by id first, then by code as fallback
      const league = leagues.find(l => l.id === id || l.code === id);
      if (!league) {
        console.warn(`Master Picks: Could not find league with id/code: ${id}`);
      }
      return league;
    })
    .filter(Boolean);
  
  // Debug log
  console.log('Master Picks - Selected league IDs:', profile?.master_picks_leagues);
  console.log('Master Picks - Found leagues:', masterPicksLeagues.map(l => ({ id: l.id, code: l.code, name: l.name })));

  // Group leagues by line lock time
  const leaguesByLockTime = masterPicksLeagues.reduce((acc, league) => {
    const lockTime = league?.settings?.lineLockTime || 1;
    if (!acc[lockTime]) acc[lockTime] = [];
    acc[lockTime].push(league);
    return acc;
  }, {});

  const lockTimeGroups = Object.keys(leaguesByLockTime).sort((a, b) => b - a); // Sort descending (longest lock time first)

  // Calculate current NFL week
  const getCurrentNFLWeek = () => {
    const now = new Date();
    const seasonStart = new Date('2025-09-02T00:00:00-04:00'); // Tuesday, Sept 2, 2025
    const diffMs = now - seasonStart;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const week = Math.floor(diffDays / 7) + 1;
    return Math.max(1, Math.min(week, 18));
  };

  // Fetch NFL games from ESPN API and snapshot locked lines
  const fetchNFLGames = async () => {
    try {
      setError(null);
      const week = getCurrentNFLWeek();
      setCurrentWeek(week);
      
      const response = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}`
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch games');
      }
      
      const data = await response.json();
      const events = data.events || [];
      
      const parsed = events.map((event) => {
        const competition = event.competitions?.[0];
        const odds = competition?.odds?.[0];
        const home = competition?.competitors?.find((c) => c.homeAway === 'home');
        const away = competition?.competitors?.find((c) => c.homeAway === 'away');

        return {
          id: event.id,
          date: event.date,
          name: event.name,
          shortName: event.shortName,
          homeTeam: home?.team?.displayName || 'Home',
          awayTeam: away?.team?.displayName || 'Away',
          homeAbbr: home?.team?.abbreviation || '',
          awayAbbr: away?.team?.abbreviation || '',
          homeScore: parseInt(home?.score || '0', 10),
          awayScore: parseInt(away?.score || '0', 10),
          status: competition?.status?.type?.name || 'STATUS_SCHEDULED',
          detailedStatus: competition?.status?.type?.detail || '',
          spread: odds?.details || 'N/A',
          overUnder: odds?.overUnder ? `O/U ${odds.overUnder}` : 'N/A',
        };
      });

      setGames(parsed);

      // Snapshot locked lines for all leagues
      const updatedLeagues = await Promise.all(
        leagues.map(async (league) => {
          const snapshotted = await snapshotLockedLines(league, parsed);
          return snapshotted;
        })
      );
      setLeagues(updatedLeagues);

    } catch (err) {
      console.error('Error fetching NFL games:', err);
      setError(err.message || 'Failed to load games');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Load existing picks from leagues when screen loads
  useEffect(() => {
    if (masterPicksLeagues.length > 0 && currentWeek && games.length > 0) {
      loadExistingPicks();
    }
  }, [masterPicksLeagues.length, currentWeek, games.length]);

  const loadExistingPicks = () => {
    try {
      const picksByLockTime = {};

      // Check each league for existing picks
      masterPicksLeagues.forEach(league => {
        const lockTimeHours = league?.settings?.lineLockTime || 1;
        const userPicks = league.picks?.[currentUser.id] || {};

        // Initialize this lock time group if needed
        if (!picksByLockTime[lockTimeHours]) {
          picksByLockTime[lockTimeHours] = {};
        }

        // For each game with a pick, store it
        Object.entries(userPicks).forEach(([gameId, pick]) => {
          if (!picksByLockTime[lockTimeHours][gameId]) {
            picksByLockTime[lockTimeHours][gameId] = {};
          }

          // Store spread, total, winner from this league's picks
          if (pick.spread) picksByLockTime[lockTimeHours][gameId].spread = pick.spread;
          if (pick.total) picksByLockTime[lockTimeHours][gameId].total = pick.total;
          if (pick.winner) picksByLockTime[lockTimeHours][gameId].winner = pick.winner;
        });
      });

      setMasterPicksByLockTime(picksByLockTime);
    } catch (err) {
      console.error('Error loading existing picks:', err);
    }
  };

  useEffect(() => {
    fetchNFLGames();
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    fetchNFLGames();
  };

  // Check if a game's picks are locked for a given lock time
  const isLockTimePassed = (game, lockTimeHours) => {
    const now = new Date();
    const gameTime = new Date(game.date);
    const lockTime = new Date(gameTime.getTime() - lockTimeHours * 60 * 60 * 1000);
    return now >= lockTime;
  };

  // Compute team spreads from a details string and team abbreviations
  const computeTeamSpreads = (spreadStr, homeAbbr, awayAbbr) => {
    if (!spreadStr || spreadStr === 'N/A') return { homeLine: null, awayLine: null };
    const n = parseSpreadNumber(spreadStr);
    if (n == null) return { homeLine: null, awayLine: null };
    const amount = Math.abs(Number(n));
    const s = String(spreadStr).toUpperCase();
    const h = (homeAbbr || '').toUpperCase();
    const a = (awayAbbr || '').toUpperCase();
    // Determine which team is favorite based on abbreviation presence
    if (h && s.includes(h)) {
      return { homeLine: -amount, awayLine: amount };
    }
    if (a && s.includes(a)) {
      return { homeLine: amount, awayLine: -amount };
    }
    // Fallback: assume home is favorite if unknown
    return { homeLine: -amount, awayLine: amount };
  };

  const formatSigned = (n) => {
    if (n == null || Number.isNaN(n)) return '';
    return n > 0 ? `+${n}` : `${n}`;
  };

  // Get the appropriate lines for a game based on lock time
  const getGameLines = (game, lockTimeHours) => {
    const locked = isLockTimePassed(game, lockTimeHours);
    if (locked) {
      // Use locked lines from one of the leagues in this lock time group
      const leaguesInGroup = leaguesByLockTime[lockTimeHours] || [];
      for (const league of leaguesInGroup) {
        const lockedLine = league.locked_lines?.[game.id];
        if (lockedLine) {
          return {
            spread: lockedLine.spread,
            overUnder: lockedLine.overUnder,
            ouNumber: getOverUnderNumber(lockedLine.overUnder),
            ...computeTeamSpreads(lockedLine.spread, game.homeAbbr, game.awayAbbr),
            locked: true,
          };
        }
      }
    }
    // Use current ESPN lines
    // Use current ESPN lines
    return {
      spread: game.spread,
      overUnder: game.overUnder,
      ouNumber: getOverUnderNumber(game.overUnder),
      ...computeTeamSpreads(game.spread, game.homeAbbr, game.awayAbbr),
      locked: false
    };
  };

  // Helpers to format choices consistently across rows
  const parseSpreadNumber = (spreadStr) => {
    if (!spreadStr || spreadStr === 'N/A') return null;
    const m = String(spreadStr).match(/(-?\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  };

  const getOverUnderNumber = (ouStr) => {
    if (!ouStr || ouStr === 'N/A') return null;
    const m = String(ouStr).match(/(\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  };

  // Toggle spread pick for a specific lock time group
  const toggleSpread = (lockTimeHours, gameId, spread) => {
    setMasterPicksByLockTime(prev => ({
      ...prev,
      [lockTimeHours]: {
        ...prev[lockTimeHours],
        [gameId]: {
          ...(prev[lockTimeHours]?.[gameId] || {}),
          spread: prev[lockTimeHours]?.[gameId]?.spread === spread ? null : spread
        }
      }
    }));
  };

  // Toggle total pick for a specific lock time group
  const toggleTotal = (lockTimeHours, gameId, total) => {
    setMasterPicksByLockTime(prev => ({
      ...prev,
      [lockTimeHours]: {
        ...prev[lockTimeHours],
        [gameId]: {
          ...(prev[lockTimeHours]?.[gameId] || {}),
          total: prev[lockTimeHours]?.[gameId]?.total === total ? null : total
        }
      }
    }));
  };

  // Toggle moneyline winner for a specific lock time group
  const toggleWinner = (lockTimeHours, gameId, winner) => {
    setMasterPicksByLockTime(prev => ({
      ...prev,
      [lockTimeHours]: {
        ...prev[lockTimeHours],
        [gameId]: {
          ...(prev[lockTimeHours]?.[gameId] || {}),
          winner: prev[lockTimeHours]?.[gameId]?.winner === winner ? null : winner
        }
      }
    }));
  };

  // Submit master picks and sync to leagues
  const handleSubmitPicks = async () => {
    try {
      // Count total picks across all lock time groups
      let totalPicksCount = 0;
      Object.values(masterPicksByLockTime).forEach(groupPicks => {
        totalPicksCount += Object.values(groupPicks).filter(p => p.spread || p.total || p.winner).length;
      });

      if (totalPicksCount === 0) {
        Alert.alert('No Picks', 'Please make at least one pick before submitting.');
        return;
      }

      // Sync logic: distribute picks to leagues in matching lock time groups
      const syncResults = {
        total: 0,
        synced: 0,
        locked: 0,
        leagueResults: []
      };

      // Collect server saves to perform after local state update
      const pendingSaves = [];

      // Debug: Log master picks structure
      console.log('Master picks by lock time:', JSON.stringify(
        Object.keys(masterPicksByLockTime).map(lt => ({
          lockTime: lt,
          picks: Object.keys(masterPicksByLockTime[lt] || {}).map(gameId => ({
            gameId,
            spread: masterPicksByLockTime[lt][gameId]?.spread,
            total: masterPicksByLockTime[lt][gameId]?.total,
            winner: masterPicksByLockTime[lt][gameId]?.winner,
          }))
        })),
        null,
        2
      ));

      const updatedLeagues = leagues.map(league => {
        const isSelected = masterPicksLeagues.some(l => l.id === league.id || l.code === league.code);
        if (!isSelected) {
          console.log(`Skipping league ${league.name} (not selected)`);
          return league;
        }
        
        console.log(`Processing league: ${league.name} (${league.type})`);

        const lockTimeHours = league?.settings?.lineLockTime || 1;
        
        const isSpreadLeague = ['individual', 'freeForAll', 'survivor', 'headToHead'].includes(league.type);
        const isMoneylineLeague = league.type === 'moneylineMania';

        let picksUpdated = 0;
        let picksLocked = 0;

        const newPicks = { ...league.picks };
        if (!newPicks[currentUser.id]) {
          newPicks[currentUser.id] = {};
        }

        // Iterate all games and check all lock time groups for picks
        games.forEach(game => {
          const locked = isLockTimePassed(game, lockTimeHours);

          if (locked) {
            picksLocked++;
            return;
          }

          // Check all lock time groups for this game's picks
          let foundSpreadOrTotal = false;
          let foundWinner = false;

          // Debug: Log what we're looking for
          if (games.indexOf(game) === 0) {
            console.log(`League ${league.name}: Looking for picks in game ID ${game.id}`);
          }

          for (const [groupLockTime, groupPicks] of Object.entries(masterPicksByLockTime)) {
            const masterPick = groupPicks[game.id];
            if (!masterPick) continue;

            // Debug: Log what we found
            if (games.indexOf(game) === 0) {
              console.log(`League ${league.name}: Found master pick for game ${game.id}:`, {
                spread: masterPick.spread,
                total: masterPick.total,
                winner: masterPick.winner,
                isSpreadLeague,
                isMoneylineLeague
              });
            }

            // Sync spread/total picks to spread leagues (from any lock time group)
            if (isSpreadLeague && (masterPick.spread || masterPick.total) && !foundSpreadOrTotal) {
              newPicks[currentUser.id][game.id] = {
                ...newPicks[currentUser.id][game.id],
                spread: masterPick.spread || newPicks[currentUser.id][game.id]?.spread,
                total: masterPick.total || newPicks[currentUser.id][game.id]?.total,
              };
              foundSpreadOrTotal = true;
              picksUpdated++;
            }

            // Sync moneyline picks to moneyline leagues (from any lock time group)
            if (isMoneylineLeague && masterPick.winner && !foundWinner) {
              newPicks[currentUser.id][game.id] = {
                ...newPicks[currentUser.id][game.id],
                winner: masterPick.winner,
              };
              foundWinner = true;
              picksUpdated++;
            }
          }

          // Queue server saves if picks were updated
          if (foundSpreadOrTotal || foundWinner) {
            // Normalize total for server scoring: 'O'/'U' -> 'over'/'under'
            const rawTotal = newPicks[currentUser.id][game.id]?.total;
            const normalizedTotal = rawTotal === 'O' ? 'over' : rawTotal === 'U' ? 'under' : rawTotal || null;

            pendingSaves.push({
              league_code: league.code,
              user_id: currentUser.id,
              game_id: game.id,
              week: currentWeek,
              spread: newPicks[currentUser.id][game.id]?.spread || null,
              total: normalizedTotal,
              winner: newPicks[currentUser.id][game.id]?.winner || null,
            });
          }
        });

        syncResults.total++;
        if (picksUpdated > 0) {
          syncResults.synced++;
        }
        syncResults.locked += picksLocked;
        syncResults.leagueResults.push({
          name: league.name,
          updated: picksUpdated,
          locked: picksLocked
        });
        
        console.log(`League ${league.name}: ${picksUpdated} picks updated, ${picksLocked} locked`);

        return { ...league, picks: newPicks };
      });
      
      console.log('Sync results:', syncResults);

      setLeagues(updatedLeagues);

      // Attempt to persist picks to Supabase (or queue offline)
      try {
        const online = await isOnline();
        if (pendingSaves.length > 0) {
          if (online) {
            // Save sequentially to handle potential rate limits / errors gracefully
            for (const p of pendingSaves) {
              try {
                const { error } = await savePick(p);
                if (error) {
                  // Fallback to queue on error
                  await queueOfflinePick({
                    leagueCode: p.league_code,
                    userId: p.user_id,
                    gameId: p.game_id,
                    week: p.week,
                    spread: p.spread || null,
                    total: p.total || null,
                    winner: p.winner || null,
                  });
                }
              } catch (e) {
                await queueOfflinePick({
                  leagueCode: p.league_code,
                  userId: p.user_id,
                  gameId: p.game_id,
                  week: p.week,
                  spread: p.spread || null,
                  total: p.total || null,
                  winner: p.winner || null,
                });
              }
            }
          } else {
            // Offline: queue all
            for (const p of pendingSaves) {
              await queueOfflinePick({
                leagueCode: p.league_code,
                userId: p.user_id,
                gameId: p.game_id,
                week: p.week,
                spread: p.spread || null,
                total: p.total || null,
                winner: p.winner || null,
              });
            }
          }
        }
      } catch (persistErr) {
        console.warn('Master picks persistence encountered an error:', persistErr);
      }

      // Show confirmation
      const lockedMsg = syncResults.locked > 0 
        ? `\n\n${syncResults.locked} game(s) were locked and not updated.`
        : '';
      
      Alert.alert(
        'Picks Synced!',
        `Your picks have been synced to ${syncResults.synced}/${syncResults.total} leagues.${lockedMsg}`,
        [{ text: 'OK', onPress: () => setTab('Home') }]
      );

    } catch (err) {
      console.error('Error syncing picks:', err);
      Alert.alert('Error', 'Failed to sync picks. Please try again.');
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: theme?.colors?.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={theme?.colors?.primary || '#2563eb'} />
        <Text style={{ color: theme?.colors?.muted, marginTop: 16 }}>Loading games...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
        <View style={[styles.screenHeader, { backgroundColor: theme?.colors?.bannerBg }]}>
          <Text style={styles.h1}>Master Picks</Text>
        </View>
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginTop: 16, padding: 24, alignItems: 'center' }]}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>⚠️</Text>
          <Text style={{ fontSize: 18, fontWeight: '700', color: theme?.colors?.text, marginBottom: 8, textAlign: 'center' }}>
            Unable to Load Games
          </Text>
          <Text style={{ color: theme?.colors?.muted, marginBottom: 24, textAlign: 'center' }}>
            {error}
          </Text>
          <Pressable 
            style={[styles.btnBlue, { width: '100%' }]} 
            onPress={fetchNFLGames}
          >
            <Text style={styles.btnTxt}>Try Again</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  if (games.length === 0) {
    return (
      <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
        <View style={[styles.screenHeader, { backgroundColor: theme?.colors?.bannerBg }]}>
          <Text style={styles.h1}>Master Picks</Text>
        </View>
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginTop: 16, padding: 24, alignItems: 'center' }]}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>🏈</Text>
          <Text style={{ fontSize: 18, fontWeight: '700', color: theme?.colors?.text, marginBottom: 8, textAlign: 'center' }}>
            No Games This Week
          </Text>
          <Text style={{ color: theme?.colors?.muted, marginBottom: 24, textAlign: 'center' }}>
            Check back later for upcoming NFL games.
          </Text>
          <Pressable 
            style={[styles.btnBlue, { width: '100%' }]} 
            onPress={fetchNFLGames}
          >
            <Text style={styles.btnTxt}>Refresh</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView 
      style={[styles.container, { backgroundColor: theme?.colors?.background }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          colors={[theme?.colors?.primary || '#2563eb']}
          tintColor={theme?.colors?.primary || '#2563eb'}
        />
      }
    >
      <View style={[styles.screenHeader, { backgroundColor: theme?.colors?.bannerBg }]}>
        <Text style={styles.h1}>Master Picks</Text>
        <Text style={{ color: theme?.colors?.muted, fontSize: 14, marginTop: 4 }}>
          Week {currentWeek} • Grouped by line lock times
        </Text>
      </View>

      {/* Info about grouping */}
      {lockTimeGroups.length > 1 && (
        <View style={[styles.card, { backgroundColor: theme?.colors?.warning + '20', borderLeftWidth: 4, borderLeftColor: theme?.colors?.warning, marginHorizontal: 16, marginTop: 16 }]}>
          <Text style={{ color: theme?.colors?.text, fontSize: 14, fontWeight: '600', marginBottom: 4 }}>
            ℹ️ Multiple Line Lock Times Detected
          </Text>
          <Text style={{ color: theme?.colors?.text, fontSize: 12 }}>
            Your leagues have different line lock times. Games are grouped below so you pick using the correct lines for each group.
          </Text>
        </View>
      )}

      {masterPicksLeagues.length === 0 && (
        <View style={[styles.card, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginTop: 16, padding: 24, alignItems: 'center' }]}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>⚙️</Text>
          <Text style={{ fontSize: 16, fontWeight: '700', color: theme?.colors?.text, marginBottom: 8, textAlign: 'center' }}>
            No Leagues Selected
          </Text>
          <Text style={{ color: theme?.colors?.muted, marginBottom: 16, textAlign: 'center' }}>
            Go to Profile → Master Picks settings to select leagues.
          </Text>
          <Pressable 
            style={[styles.btnBlue]} 
            onPress={() => setTab('Profile')}
          >
            <Text style={styles.btnTxt}>Go to Settings</Text>
          </Pressable>
        </View>
      )}

      {/* Render games grouped by lock time */}
      {lockTimeGroups.map((lockTimeHours) => {
        const leaguesInGroup = leaguesByLockTime[lockTimeHours];
        const spreadLeaguesInGroup = leaguesInGroup.filter(l => 
          ['individual', 'freeforall', 'survivor', 'headtohead'].includes(l.type)
        );
        const moneylineLeaguesInGroup = leaguesInGroup.filter(l => l.type === 'moneylinemania');
        
        return (
          <View key={lockTimeHours} style={{ marginHorizontal: 16, marginTop: 24 }}>
            {/* Lock Time Group Header */}
            <View style={[styles.card, { backgroundColor: theme?.colors?.primary, marginBottom: 12 }]}>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 4 }}>
                📌 {lockTimeHours} Hour{lockTimeHours != 1 ? 's' : ''} Before Kickoff
              </Text>
              <Text style={{ color: '#fff', opacity: 0.9, fontSize: 12, marginBottom: 8 }}>
                Applies to {leaguesInGroup.length} league{leaguesInGroup.length !== 1 ? 's' : ''}:
              </Text>
              {leaguesInGroup.map(league => (
                <Text key={league.id} style={{ color: '#fff', fontSize: 11, marginLeft: 8 }}>
                  • {league.name}
                </Text>
              ))}
            </View>

            {/* Games for this lock time group */}
            {games.map((game) => {
              const gameLines = getGameLines(game, lockTimeHours);
              const pick = masterPicksByLockTime[lockTimeHours]?.[game.id] || {};
              const gameTime = new Date(game.date);
              const isLocked = isLockTimePassed(game, lockTimeHours);
              const isStarted = game.status !== 'STATUS_SCHEDULED';
              const awayAbbr = game.awayAbbr || game.awayTeam;
              const homeAbbr = game.homeAbbr || game.homeTeam;
              
              return (
                <View 
                  key={`${lockTimeHours}-${game.id}`}
                  style={[
                    styles.card, 
                    { 
                      backgroundColor: theme?.colors?.card, 
                      marginBottom: 12,
                      opacity: isStarted ? 0.6 : 1,
                      borderLeftWidth: gameLines.locked ? 3 : 0,
                      borderLeftColor: theme?.colors?.warning
                    }
                  ]}
                >
                  {/* Game Header */}
                  <View style={{ marginBottom: 12 }}>
                    <Text style={{ color: theme?.colors?.text, fontSize: 16, fontWeight: '700' }}>
                      {game.awayTeam} @ {game.homeTeam}
                    </Text>
                    <Text style={{ color: theme?.colors?.muted, fontSize: 12, marginTop: 2 }}>
                      {gameTime.toLocaleDateString('en-US', { 
                        weekday: 'short', 
                        month: 'short', 
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit'
                      })}
                    </Text>
                    {gameLines.locked && (
                      <Text style={{ color: theme?.colors?.warning, fontSize: 11, marginTop: 2, fontWeight: '600' }}>
                        🔒 Lines locked for this group
                      </Text>
                    )}
                    {isStarted && (
                      <Text style={{ color: theme?.colors?.danger, fontSize: 11, marginTop: 2 }}>
                        Game started
                      </Text>
                    )}
                  </View>
                  {/* Three-column selection: Moneyline | Spread | Over/Under */}
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {/* Moneyline Column */}
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme?.colors?.muted, fontSize: 12, marginBottom: 6, textAlign: 'center' }}>Moneyline</Text>
                      <View style={{ gap: 8 }}>
                        <Pressable
                          disabled={isStarted || isLocked}
                          style={{
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 2,
                            borderColor: pick.winner === awayAbbr ? (theme?.colors?.warning || '#f59e0b') : theme?.colors?.border,
                            backgroundColor: pick.winner === awayAbbr ? (theme?.colors?.warning || '#f59e0b') : 'transparent',
                            opacity: (isStarted || isLocked) ? 0.5 : 1
                          }}
                          onPress={() => toggleWinner(lockTimeHours, game.id, awayAbbr)}
                        >
                          <Text style={{ color: pick.winner === awayAbbr ? '#fff' : theme?.colors?.text, fontWeight: '600', textAlign: 'center', fontSize: 13 }}>
                            {awayAbbr}
                          </Text>
                        </Pressable>
                        <Pressable
                          disabled={isStarted || isLocked}
                          style={{
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 2,
                            borderColor: pick.winner === homeAbbr ? (theme?.colors?.warning || '#f59e0b') : theme?.colors?.border,
                            backgroundColor: pick.winner === homeAbbr ? (theme?.colors?.warning || '#f59e0b') : 'transparent',
                            opacity: (isStarted || isLocked) ? 0.5 : 1
                          }}
                          onPress={() => toggleWinner(lockTimeHours, game.id, homeAbbr)}
                        >
                          <Text style={{ color: pick.winner === homeAbbr ? '#fff' : theme?.colors?.text, fontWeight: '600', textAlign: 'center', fontSize: 13 }}>
                            {homeAbbr}
                          </Text>
                        </Pressable>
                      </View>
                    </View>

                    {/* Spread Column */}
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme?.colors?.muted, fontSize: 12, marginBottom: 6, textAlign: 'center' }}>Spread</Text>
                      <View style={{ gap: 8 }}>
                        <Pressable
                          disabled={isStarted || isLocked || gameLines.homeLine == null || gameLines.awayLine == null}
                          style={{
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 2,
                            borderColor: pick.spread === awayAbbr ? (theme?.colors?.primary || '#2563eb') : theme?.colors?.border,
                            backgroundColor: pick.spread === awayAbbr ? (theme?.colors?.primary || '#2563eb') : 'transparent',
                            opacity: (isStarted || isLocked) ? 0.5 : 1
                          }}
                          onPress={() => toggleSpread(lockTimeHours, game.id, awayAbbr)}
                        >
                          <Text style={{ color: pick.spread === awayAbbr ? '#fff' : theme?.colors?.text, fontWeight: '600', textAlign: 'center', fontSize: 13 }}>
                            {formatSigned(gameLines.awayLine)}
                          </Text>
                        </Pressable>
                        <Pressable
                          disabled={isStarted || isLocked || gameLines.homeLine == null || gameLines.awayLine == null}
                          style={{
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 2,
                            borderColor: pick.spread === homeAbbr ? (theme?.colors?.primary || '#2563eb') : theme?.colors?.border,
                            backgroundColor: pick.spread === homeAbbr ? (theme?.colors?.primary || '#2563eb') : 'transparent',
                            opacity: (isStarted || isLocked) ? 0.5 : 1
                          }}
                          onPress={() => toggleSpread(lockTimeHours, game.id, homeAbbr)}
                        >
                          <Text style={{ color: pick.spread === homeAbbr ? '#fff' : theme?.colors?.text, fontWeight: '600', textAlign: 'center', fontSize: 13 }}>
                            {formatSigned(gameLines.homeLine)}
                          </Text>
                        </Pressable>
                      </View>
                    </View>

                    {/* Over/Under Column */}
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme?.colors?.muted, fontSize: 12, marginBottom: 6, textAlign: 'center' }}>Over / Under</Text>
                      <View style={{ gap: 8 }}>
                        <Pressable
                          disabled={isStarted || isLocked || !gameLines.ouNumber}
                          style={{
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 2,
                            borderColor: pick.total === 'O' ? (theme?.colors?.success || '#16a34a') : theme?.colors?.border,
                            backgroundColor: pick.total === 'O' ? (theme?.colors?.success || '#16a34a') : 'transparent',
                            opacity: (isStarted || isLocked) ? 0.5 : 1
                          }}
                          onPress={() => toggleTotal(lockTimeHours, game.id, 'O')}
                        >
                          <Text style={{ color: pick.total === 'O' ? '#fff' : theme?.colors?.text, fontWeight: '600', textAlign: 'center', fontSize: 13 }}>
                            O {gameLines.ouNumber}
                          </Text>
                        </Pressable>
                        <Pressable
                          disabled={isStarted || isLocked || !gameLines.ouNumber}
                          style={{
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 2,
                            borderColor: pick.total === 'U' ? (theme?.colors?.success || '#16a34a') : theme?.colors?.border,
                            backgroundColor: pick.total === 'U' ? (theme?.colors?.success || '#16a34a') : 'transparent',
                            opacity: (isStarted || isLocked) ? 0.5 : 1
                          }}
                          onPress={() => toggleTotal(lockTimeHours, game.id, 'U')}
                        >
                          <Text style={{ color: pick.total === 'U' ? '#fff' : theme?.colors?.text, fontWeight: '600', textAlign: 'center', fontSize: 13 }}>
                            U {gameLines.ouNumber}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        );
      })}

      {/* Submit Button */}
      {masterPicksLeagues.length > 0 && (
        <View style={{ marginHorizontal: 16, marginTop: 16, marginBottom: 32 }}>
          <Pressable 
            style={[styles.btnBlue, { width: '100%', padding: 16 }]} 
            onPress={handleSubmitPicks}
          >
            <Text style={[styles.btnTxt, { fontSize: 16 }]}>Sync Picks to All Leagues</Text>
          </Pressable>
          <Pressable 
            style={[styles.card, { marginTop: 12, padding: 12, backgroundColor: theme?.colors?.surface }]} 
            onPress={() => setTab('Home')}
          >
            <Text style={{ color: theme?.colors?.text, fontWeight: '600', textAlign: 'center' }}>Cancel</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
};
