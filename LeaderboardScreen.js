import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, Image } from 'react-native';
import { loadResults } from './storage';
import { getProfilesByIds } from './supabaseProfile';
import { computeUserStats } from './stats';
import { applyTiebreaker, getTiebreakerDescription } from './tiebreakers';
import { fetchWeeklyLeaderboard, hasWeeklyPointsCache } from './supabaseResults';

export const LeaderboardScreen = ({ leagues, currentUser, theme }) => {
  const [timePeriod, setTimePeriod] = useState('allTime'); // allTime, thisWeek, thisMonth
  const [scope, setScope] = useState('worldwide'); // worldwide, friends, byLeague
  const [selectedLeague, setSelectedLeague] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [leaguePicks, setLeaguePicks] = useState({});
  const [friends, setFriends] = useState([]); // List of friend user IDs

  // Load friends list
  useEffect(() => {
    const loadFriendsList = async () => {
      try {
        const { loadFriends } = await import('./storage');
        const data = await loadFriends(currentUser?.id);
        const friendIds = (data.friends || []).map(f => f.userId);
        setFriends(friendIds);
      } catch (e) {
        console.warn('Failed to load friends:', e);
      }
    };
    loadFriendsList();
  }, [currentUser?.id]);

  useEffect(() => {
    calculateLeaderboard();
  }, [leagues, timePeriod, scope, selectedLeague]);

  const calculateLeaderboard = async () => {
    const userId = currentUser?.id;
    if (!userId) return;

    const results = await loadResults();

    let allPlayers = new Map();

    // Aggregate data from all leagues
    const leaguesToProcess = scope === 'byLeague' && selectedLeague 
      ? [leagues.find(l => l.code === selectedLeague)] 
      : leagues;

    for (const league of leaguesToProcess.filter(Boolean)) {
      // Load picks for this league and week from Supabase
      const { data: picksArr } = await import('./supabasePicks').then(mod => mod.getPicksForLeagueWeek(league.code, 1));
      league.members.forEach(memberId => {
        if (!allPlayers.has(memberId)) {
          allPlayers.set(memberId, {
            userId: memberId,
            username: memberId.slice(0, 8), // TODO: Get actual username
            totalPicks: 0,
            wins: 0,
            losses: 0,
            pushes: 0,
            points: 0,
            leagues: 0,
          });
        }

        const player = allPlayers.get(memberId);
        player.leagues++;

        // Compute stats for this player within this league
        const s = computeUserStats({
          leagues: [league],
          userId: memberId,
          results,
          pickType: 'all',
          timePeriod,
          picks: picksArr,
        });
        player.totalPicks += s.totalPicks;
        player.wins += s.overallWins;
        player.losses += s.overallLosses;
        player.pushes += (s.spreadPushes + s.totalPushes);

        // Aggregate confidence points if present
        picksArr?.filter(p => p.user_id === memberId).forEach(p => {
          if (typeof p.confidence === 'number') player.points += p.confidence;
        });
      });
    }

    // Fetch display names/usernames from profiles for nicer labels
    try {
      const memberIds = Array.from(allPlayers.keys());
      const { data: profilesMap } = await getProfilesByIds(memberIds);
      // Enrich with names
      memberIds.forEach(id => {
        const p = profilesMap?.get(id);
        if (p) {
          const entry = allPlayers.get(id);
          if (entry) {
            // Store the display label in username field to avoid UI changes
            entry.username = p.display_name || p.username || id.slice(0, 8);
          }
        }
      });
    } catch (e) {
      // Non-fatal: keep fallbacks
      console.warn('Failed to load profile names for leaderboard:', e);
    }

    // Convert to array and calculate percentages
    let leaderboardData = Array.from(allPlayers.values()).map(player => ({
      ...player,
      winPercentage: player.totalPicks > 0 ? ((player.wins / player.totalPicks) * 100).toFixed(1) : '0.0',
      avgPoints: player.totalPicks > 0 ? (player.points / player.totalPicks).toFixed(1) : '0.0',
    }));

    // Filter by friends if in friends scope
    if (scope === 'friends') {
      leaderboardData = leaderboardData.filter(player => 
        friends.includes(player.userId) || player.userId === userId
      );
    }

    // Get tiebreaker rule from league settings (if viewing by league)
    let tiebreakerRule = 'totalPoints'; // default
    if (scope === 'byLeague' && selectedLeague) {
      const league = leagues.find(l => l.code === selectedLeague);
      if (league?.settings?.tiebreaker) {
        tiebreakerRule = league.settings.tiebreaker;
      }
    }

    // Apply tiebreaker sorting
    const sortedData = applyTiebreaker(
      leaderboardData, 
      tiebreakerRule, 
      scope === 'byLeague' && selectedLeague ? leagues.find(l => l.code === selectedLeague) : null,
      results
    );

    setLeaderboard(sortedData);
  };

  const getMedal = (index) => {
    if (index === 0) return '🥇';
    if (index === 1) return '🥈';
    if (index === 2) return '🥉';
    return `#${index + 1}`;
  };

  const getTrophy = (player) => {
    if (player.wins >= 100) return '🏆';
    if (player.wins >= 50) return '⭐';
    if (player.wins >= 25) return '🌟';
    return null;
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
      <View style={[styles.header, { backgroundColor: theme?.colors?.bannerBg }]}>
        <Text style={[styles.h1, { color: theme?.colors?.heading }]}>Leaderboard</Text>
      </View>

      {/* Time Period Filter */}
      <View style={styles.filterSection}>
        <Text style={[styles.filterTitle, { color: theme?.colors?.text }]}>TIME PERIOD</Text>
        <View style={styles.filterRow}>
          {[
            { key: 'allTime', label: 'All Time' },
            { key: 'thisWeek', label: 'This Week' },
            { key: 'thisMonth', label: 'This Month' }
          ].map(period => (
            <Pressable
              key={period.key}
              style={[
                styles.filterButton,
                { backgroundColor: timePeriod === period.key ? theme?.colors?.primary : theme?.colors?.card }
              ]}
              onPress={() => setTimePeriod(period.key)}
            >
              <Text style={[
                styles.filterButtonText,
                { color: timePeriod === period.key ? '#fff' : theme?.colors?.text }
              ]}>
                {period.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Scope Filter */}
      <View style={styles.filterSection}>
        <Text style={[styles.filterTitle, { color: theme?.colors?.text }]}>SCOPE</Text>
        <View style={styles.filterRow}>
          <Pressable
            style={[
              styles.filterButton,
              { flex: 1, backgroundColor: scope === 'worldwide' ? theme?.colors?.primary : theme?.colors?.card }
            ]}
            onPress={() => setScope('worldwide')}
          >
            <Text style={[
              styles.filterButtonText,
              { color: scope === 'worldwide' ? '#fff' : theme?.colors?.text }
            ]}>
              Worldwide
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.filterButton,
              { flex: 1, backgroundColor: scope === 'friends' ? theme?.colors?.primary : theme?.colors?.card }
            ]}
            onPress={() => setScope('friends')}
          >
            <Text style={[
              styles.filterButtonText,
              { color: scope === 'friends' ? '#fff' : theme?.colors?.text }
            ]}>
              Friends
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.filterButton,
              { flex: 1, backgroundColor: scope === 'byLeague' ? theme?.colors?.primary : theme?.colors?.card }
            ]}
            onPress={() => setScope('byLeague')}
          >
            <Text style={[
              styles.filterButtonText,
              { color: scope === 'byLeague' ? '#fff' : theme?.colors?.text }
            ]}>
              By League
            </Text>
          </Pressable>
        </View>
      </View>

      {/* League Selector */}
      {scope === 'byLeague' && (
        <View style={styles.filterSection}>
          <Text style={[styles.filterTitle, { color: theme?.colors?.text }]}>SELECT LEAGUE</Text>
          <View style={{ gap: 8 }}>
            {leagues.map(league => (
              <Pressable
                key={league.code}
                style={[
                  styles.card,
                  { 
                    backgroundColor: selectedLeague === league.code ? theme?.colors?.primary : theme?.colors?.card,
                    padding: 12
                  }
                ]}
                onPress={() => setSelectedLeague(league.code)}
              >
                <Text style={{
                  color: selectedLeague === league.code ? '#fff' : theme?.colors?.text,
                  fontWeight: '600'
                }}>
                  {league.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* Tiebreaker Info (if viewing by league) */}
      {scope === 'byLeague' && selectedLeague && (() => {
        const league = leagues.find(l => l.code === selectedLeague);
        const tiebreakerRule = league?.settings?.tiebreaker || 'totalPoints';
        return (
          <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
            <View style={[styles.card, { backgroundColor: theme?.colors?.card, paddingVertical: 10, paddingHorizontal: 12 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{ fontSize: 16, marginRight: 6 }}>⚖️</Text>
                <Text style={{ fontSize: 12, color: theme?.colors?.muted }}>
                  {getTiebreakerDescription(tiebreakerRule)}
                </Text>
              </View>
            </View>
          </View>
        );
      })()}

      {/* Leaderboard */}
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <Text style={[styles.sectionTitle, { color: theme?.colors?.text, marginBottom: 16 }]}>
          Rankings
        </Text>

        {leaderboard.length === 0 ? (
          <View style={[styles.card, { backgroundColor: theme?.colors?.card, alignItems: 'center', paddingVertical: 40 }]}>
            <Text style={{ fontSize: 48, marginBottom: 12 }}>
              {scope === 'friends' ? '👥' : '🏆'}
            </Text>
            <Text style={{ color: theme?.colors?.text, fontSize: 16, fontWeight: '600', marginBottom: 4 }}>
              {scope === 'friends' ? 'No Friends Found' : 'No Data Available'}
            </Text>
            <Text style={{ color: theme?.colors?.muted, textAlign: 'center', paddingHorizontal: 20 }}>
              {scope === 'friends' 
                ? 'Add friends to see how you compare!' 
                : 'Join leagues and make picks to appear on the leaderboard'}
            </Text>
          </View>
        ) : (
          leaderboard.map((player, index) => (
            <View
              key={player.userId}
              style={[
                styles.card,
                {
                  backgroundColor: theme?.colors?.card,
                  marginBottom: 12,
                  borderLeftWidth: 4,
                  borderLeftColor: player.userId === currentUser?.id ? theme?.colors?.success : 
                                   index === 0 ? '#fbbf24' : 
                                   index === 1 ? '#d1d5db' : 
                                   index === 2 ? '#f97316' : 'transparent',
                }
              ]}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                {/* Rank and Player Info */}
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                  <Text style={{
                    fontSize: 24,
                    fontWeight: '800',
                    color: index < 3 ? (index === 0 ? '#fbbf24' : index === 1 ? '#9ca3af' : '#f97316') : theme?.colors?.muted,
                    width: 50,
                  }}>
                    {getMedal(index)}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Text style={{ fontSize: 16, fontWeight: '700', color: theme?.colors?.text }}>
                        {player.username}
                      </Text>
                      {getTrophy(player) && (
                        <Text style={{ fontSize: 16, marginLeft: 6 }}>{getTrophy(player)}</Text>
                      )}
                      {player.userId === currentUser?.id && (
                        <Text style={{ fontSize: 12, color: theme?.colors?.primary, marginLeft: 6, fontWeight: '600' }}>
                          (You)
                        </Text>
                      )}
                    </View>
                    <Text style={{ color: theme?.colors?.muted, fontSize: 13, marginTop: 2 }}>
                      {player.totalPicks} picks • {player.leagues} league{player.leagues !== 1 ? 's' : ''}
                    </Text>
                  </View>
                </View>

                {/* Stats */}
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: theme?.colors?.text }}>
                    {player.winPercentage}%
                  </Text>
                  <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>
                    {player.wins}-{player.losses}
                  </Text>
                  {player.points > 0 && (
                    <Text style={{ color: '#f59e0b', fontSize: 11, fontWeight: '600', marginTop: 2 }}>
                      ⭐ {player.points} pts
                    </Text>
                  )}
                </View>
              </View>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 20, paddingTop: 60, paddingBottom: 24 },
  h1: { fontSize: 28, fontWeight: '700' },
  filterSection: { paddingHorizontal: 16, marginBottom: 20 },
  filterTitle: { fontSize: 14, fontWeight: '600', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterButton: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  filterButtonText: { fontSize: 14, fontWeight: '600' },
  sectionTitle: { fontSize: 18, fontWeight: '600' },
  card: { borderRadius: 12, padding: 16 },
});
