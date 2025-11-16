import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import { loadResults } from './storage';
import { computeUserStats } from './stats';
import { fetchWeeklyPoints, fetchGameResults, computeWeeklyPointsClientSide, computeWeeklyPointsClientSideDetailed } from './supabaseResults';

export const WeeklyResultsScreen = ({ leagues, currentUser, theme, onNavigate }) => {
  const [filter, setFilter] = useState('all'); // 'all' | 'spread' | 'total'
  const [timePeriod, setTimePeriod] = useState('allTime'); // 'allTime' | 'thisWeek' | 'thisMonth'
  const [stats, setStats] = useState(null);
  const [selectedWeek, setSelectedWeek] = useState(null); // For weekly recap
  const [weeklyRecap, setWeeklyRecap] = useState(null);
  const [leaguePicks, setLeaguePicks] = useState({});
  const [useServerScoring, setUseServerScoring] = useState(false); // Track if server cache available

  useEffect(() => {
    let isMounted = true;
    const run = async () => {
      const results = await loadResults();
      // Load picks for all leagues for current user
      let picksByLeague = {};
      if (leagues && currentUser?.id) {
        for (const league of leagues) {
          const { data: picksData } = await import('./supabasePicks').then(mod => mod.getPicksForLeagueWeek(league.code, selectedWeek || 1));
          picksByLeague[league.code] = picksData || [];
        }
      }
      if (!isMounted) return;
      setLeaguePicks(picksByLeague);
      const s = computeUserStats({
        leagues: leagues || [],
        userId: currentUser?.id,
        results,
        pickType: filter,
        timePeriod,
        picks: picksByLeague,
      });
      setStats(s);
    };
    run();
    return () => { isMounted = false; };
  }, [leagues, currentUser?.id, filter, timePeriod]);

  // Calculate weekly recap when a week is selected
  useEffect(() => {
    if (!selectedWeek || !leagues || !currentUser?.id) {
      setWeeklyRecap(null);
      return;
    }

    const calculateWeeklyRecap = async () => {
      console.log(`[WeeklyResults] Computing recap for week ${selectedWeek}`);
      
      // Try to use server-side scoring first
      let serverScoringAvailable = false;
      const recap = {
        week: selectedWeek,
        totalGames: 0,
        correctPicks: 0,
        incorrectPicks: 0,
        missedPicks: 0,
        totalPoints: 0,
        spreadCorrect: 0,
        spreadIncorrect: 0,
        totalCorrect: 0,
        totalIncorrect: 0,
        gameDetails: [],
        leagueRankings: [],
      };

      // Aggregate picks from all leagues for this week
      for (const league of leagues) {
        // Check if server-side scoring is available for this league/week
        const { data: weeklyPointsData, error } = await fetchWeeklyPoints(league.code, selectedWeek);
        
        if (!error && weeklyPointsData && weeklyPointsData.length > 0) {
          // Server scoring available! Use it
          console.log(`[WeeklyResults] Using server-side scores for ${league.code}`);
          serverScoringAvailable = true;
          
          const userPoints = weeklyPointsData.find(wp => wp.user_id === currentUser.id);
          if (userPoints) {
            recap.totalPoints += parseFloat(userPoints.total_points || 0);
            recap.correctPicks += (userPoints.winner_correct || 0) + (userPoints.spread_correct || 0) + (userPoints.total_correct || 0);
            recap.incorrectPicks += (userPoints.winner_incorrect || 0) + (userPoints.spread_incorrect || 0) + (userPoints.total_incorrect || 0);
            recap.spreadCorrect += userPoints.spread_correct || 0;
            recap.spreadIncorrect += userPoints.spread_incorrect || 0;
            recap.totalCorrect += userPoints.total_correct || 0;
            recap.totalIncorrect += userPoints.total_incorrect || 0;
            recap.totalGames += userPoints.games_picked || 0;
          }
          
          // Build leaderboard from server data
          const sorted = weeklyPointsData.sort((a, b) => b.total_points - a.total_points);
          const userRank = sorted.findIndex(wp => wp.user_id === currentUser.id) + 1;
          recap.leagueRankings.push({
            leagueName: league.name,
            rank: userRank,
            totalPlayers: sorted.length,
            points: userPoints?.total_points || 0,
          });
        } else {
          // Modern fallback: compute using locked_lines + final scores client-side
          console.log(`[WeeklyResults] Server scores unavailable for ${league.code}, using enhanced client fallback`);
          const { data: picksData } = await import('./supabasePicks').then(mod => mod.getPicksForLeagueWeek(league.code, selectedWeek));
          const picksArr = picksData || [];
          // Fetch final game scores for week (instead of legacy local storage)
          const { data: finalResults } = await fetchGameResults(selectedWeek);
          const gameResults = finalResults || [];

          // Build member scoring via computeWeeklyPointsClientSide
          const leagueMembers = league.members || [];
          const memberScores = leagueMembers.map(member => {
            const id = member.userId || member;
            const scoreObj = computeWeeklyPointsClientSide(league, picksArr, gameResults, id);
            return {
              userId: id,
              username: member.username || member.displayName || 'User',
              points: scoreObj.total_points || 0,
              breakdown: scoreObj
            };
          }).sort((a, b) => b.points - a.points);

          const userScoreObj = memberScores.find(m => m.userId === currentUser.id);
          if (userScoreObj) {
            recap.spreadCorrect += userScoreObj.breakdown.spread_correct || 0;
            recap.spreadIncorrect += userScoreObj.breakdown.spread_incorrect || 0;
            recap.totalCorrect += userScoreObj.breakdown.total_correct || 0;
            recap.totalIncorrect += userScoreObj.breakdown.total_incorrect || 0;
            recap.correctPicks += (userScoreObj.breakdown.winner_correct || 0) + (userScoreObj.breakdown.spread_correct || 0) + (userScoreObj.breakdown.total_correct || 0);
            recap.incorrectPicks += (userScoreObj.breakdown.winner_incorrect || 0) + (userScoreObj.breakdown.spread_incorrect || 0) + (userScoreObj.breakdown.total_incorrect || 0);
            recap.totalPoints += userScoreObj.points;
            recap.totalGames += userScoreObj.breakdown.games_picked || 0;
            // Debug: Detailed per-pick grading output for this user
            try {
              const debugDetails = computeWeeklyPointsClientSideDetailed(league, picksArr, gameResults, currentUser.id);
              console.log('[WeeklyResults][Debug Picks]', debugDetails);
            } catch (e) {
              console.log('[WeeklyResults][Debug Error]', e);
            }
          }

          const userRank = memberScores.findIndex(m => m.userId === currentUser.id) + 1;
            recap.leagueRankings.push({
              leagueName: league.name,
              rank: userRank,
              totalPlayers: memberScores.length,
              points: userScoreObj?.points || 0,
            });
        }
      }

      setUseServerScoring(serverScoringAvailable);
      setWeeklyRecap(recap);
    };

    calculateWeeklyRecap();
  }, [selectedWeek, leagues, currentUser?.id]);

  const StatCard = ({ label, value, subtext }) => (
    <View style={[styles.statCard, { backgroundColor: theme?.colors?.card }]}>
      <Text style={[styles.statValue, { color: theme?.colors?.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: theme?.colors?.muted }]}>{label}</Text>
      {subtext && <Text style={[styles.statSubtext, { color: theme?.colors?.muted }]}>{subtext}</Text>}
    </View>
  );

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
      <View style={[styles.header, { backgroundColor: theme?.colors?.bannerBg }]}>
        <Text style={[styles.h1, { color: theme?.colors?.heading }]}>Your Stats</Text>
      </View>

      {/* Weekly Recap Selector */}
      {!selectedWeek ? (
        <View style={{ marginHorizontal: 16, marginTop: 12 }}>
          <Text style={[styles.sectionTitle, { color: theme?.colors?.text, marginBottom: 12 }]}>
            📊 Weekly Recaps
          </Text>
          <Text style={{ color: theme?.colors?.muted, fontSize: 14, marginBottom: 12 }}>
            View detailed breakdown of any week
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            {[...Array(18)].map((_, i) => {
              const week = i + 1;
              return (
                <Pressable
                  key={week}
                  style={[
                    styles.weekButton,
                    { backgroundColor: theme?.colors?.card, marginRight: 8 }
                  ]}
                  onPress={() => setSelectedWeek(week)}
                >
                  <Text style={{ color: theme?.colors?.text, fontWeight: '600' }}>
                    Week {week}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : (
        /* Weekly Recap View */
        <View>
          <Pressable
            style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}
            onPress={() => setSelectedWeek(null)}
          >
            <Text style={{ fontSize: 20, color: theme?.colors?.primary, marginRight: 8 }}>←</Text>
            <Text style={{ color: theme?.colors?.primary, fontSize: 16, fontWeight: '600' }}>
              Back to All Stats
            </Text>
          </Pressable>

          <View style={[styles.recapHeader, { backgroundColor: theme?.colors?.primary, marginHorizontal: 16, marginBottom: 16 }]}>
            <Text style={{ fontSize: 32, fontWeight: '800', color: '#fff', marginBottom: 4 }}>
              Week {selectedWeek} Recap
            </Text>
            <Text style={{ fontSize: 18, color: '#fff', opacity: 0.9 }}>
              {weeklyRecap?.totalPoints || 0} Points Earned
            </Text>
            {useServerScoring && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                <Text style={{ fontSize: 12, color: '#fff', opacity: 0.8 }}>
                  ⚡ Server-computed scores
                </Text>
              </View>
            )}
          </View>

          {weeklyRecap && (
            <>
              {/* Performance Summary */}
              <View style={[styles.section]}>
                <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Performance Summary</Text>
                <View style={styles.statsGrid}>
                  <View style={[styles.recapCard, { backgroundColor: theme?.colors?.success || '#22c55e' }]}>
                    <Text style={styles.recapCardValue}>{weeklyRecap.correctPicks}</Text>
                    <Text style={styles.recapCardLabel}>Correct</Text>
                  </View>
                  <View style={[styles.recapCard, { backgroundColor: theme?.colors?.danger || '#ef4444' }]}>
                    <Text style={styles.recapCardValue}>{weeklyRecap.incorrectPicks}</Text>
                    <Text style={styles.recapCardLabel}>Incorrect</Text>
                  </View>
                  <View style={[styles.recapCard, { backgroundColor: theme?.colors?.muted || '#6b7280' }]}>
                    <Text style={styles.recapCardValue}>{weeklyRecap.missedPicks}</Text>
                    <Text style={styles.recapCardLabel}>Missed</Text>
                  </View>
                  <View style={[styles.recapCard, { backgroundColor: theme?.colors?.primary }]}>
                    <Text style={styles.recapCardValue}>
                      {weeklyRecap.totalGames > 0 
                        ? Math.round((weeklyRecap.correctPicks / (weeklyRecap.correctPicks + weeklyRecap.incorrectPicks)) * 100) 
                        : 0}%
                    </Text>
                    <Text style={styles.recapCardLabel}>Accuracy</Text>
                  </View>
                </View>
              </View>

              {/* Breakdown by Pick Type */}
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Pick Type Breakdown</Text>
                <View style={[styles.breakdownCard, { backgroundColor: theme?.colors?.card }]}>
                  <View style={styles.breakdownRow}>
                    <Text style={{ color: theme?.colors?.text, fontSize: 16 }}>Spread Picks</Text>
                    <Text style={{ color: theme?.colors?.text, fontSize: 16, fontWeight: '700' }}>
                      {weeklyRecap.spreadCorrect}-{weeklyRecap.spreadIncorrect}
                    </Text>
                  </View>
                  <View style={styles.breakdownRow}>
                    <Text style={{ color: theme?.colors?.text, fontSize: 16 }}>Over/Under Picks</Text>
                    <Text style={{ color: theme?.colors?.text, fontSize: 16, fontWeight: '700' }}>
                      {weeklyRecap.totalCorrect}-{weeklyRecap.totalIncorrect}
                    </Text>
                  </View>
                </View>
              </View>

              {/* League Rankings */}
              {weeklyRecap.leagueRankings.length > 0 && (
                <View style={styles.section}>
                  <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>League Rankings</Text>
                  {weeklyRecap.leagueRankings.map((ranking, idx) => (
                    <View key={idx} style={[styles.rankingCard, { backgroundColor: theme?.colors?.card, marginBottom: 12 }]}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <Text style={{ color: theme?.colors?.text, fontSize: 16, fontWeight: '600', flex: 1 }}>
                          {ranking.leagueName}
                        </Text>
                        <View style={[
                          styles.rankBadge,
                          { backgroundColor: ranking.rank === 1 ? '#fbbf24' : ranking.rank <= 3 ? theme?.colors?.primary : theme?.colors?.muted }
                        ]}>
                          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
                            #{ranking.rank}
                          </Text>
                        </View>
                      </View>
                      <Text style={{ color: theme?.colors?.muted, fontSize: 14 }}>
                        {ranking.points} points • {ranking.rank} of {ranking.totalPlayers} players
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Game-by-Game Results */}
              {weeklyRecap.gameDetails.length > 0 && (
                <View style={styles.section}>
                  <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Game-by-Game Results</Text>
                  {weeklyRecap.gameDetails.map((game, idx) => (
                    <View key={idx} style={[styles.gameCard, { backgroundColor: theme?.colors?.card, marginBottom: 12 }]}>
                      <Text style={{ color: theme?.colors?.text, fontSize: 15, fontWeight: '600', marginBottom: 6 }}>
                        Game {idx + 1}
                      </Text>
                      <Text style={{ color: theme?.colors?.muted, fontSize: 14, marginBottom: 4 }}>
                        Your Picks: {game.picks.join(', ')}
                      </Text>
                      <Text style={{ color: theme?.colors?.text, fontSize: 14 }}>
                        Results: {game.results.join(', ')}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {weeklyRecap.totalGames === 0 && (
                <View style={[styles.emptyCard, { backgroundColor: theme?.colors?.card }]}>
                  <Text style={{ fontSize: 48, marginBottom: 12 }}>🏈</Text>
                  <Text style={{ color: theme?.colors?.text, fontSize: 18, fontWeight: '600', marginBottom: 8 }}>
                    No Data for Week {selectedWeek}
                  </Text>
                  <Text style={{ color: theme?.colors?.muted, fontSize: 14, textAlign: 'center' }}>
                    You haven't made any picks this week yet, or results aren't available.
                  </Text>
                </View>
              )}
            </>
          )}
        </View>
      )}

      {/* Regular Stats View - Only show when not viewing weekly recap */}
      {!selectedWeek && (
        <>
          {/* Quick Access to Trends */}
          <Pressable
            style={[styles.trendButton, { backgroundColor: theme?.colors?.card, marginHorizontal: 16, marginTop: 12 }]}
            onPress={() => onNavigate?.('Trends')}
          >
            <Text style={{ fontSize: 28, marginRight: 12 }}>📈</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.trendButtonText, { color: theme?.colors?.text }]}>
                View Trends & Analytics
              </Text>
              <Text style={{ color: theme?.colors?.muted, fontSize: 12 }}>
                See your performance over time
              </Text>
            </View>
            <Text style={{ color: theme?.colors?.primary, fontSize: 18 }}>→</Text>
          </Pressable>

          <View style={styles.filterSection}>
            <Text style={[styles.filterTitle, { color: theme?.colors?.text }]}>TIME PERIOD</Text>
            <View style={styles.filterRow}>
              {['allTime', 'thisWeek', 'thisMonth'].map(period => (
                <Pressable
                  key={period}
                  style={[styles.filterButton, { backgroundColor: timePeriod === period ? theme?.colors?.primary : theme?.colors?.card }]}
                  onPress={() => setTimePeriod(period)}
                >
                  <Text style={[styles.filterButtonText, { color: timePeriod === period ? '#fff' : theme?.colors?.text }]}>
                    {period === 'allTime' ? 'All Time' : period === 'thisWeek' ? 'This Week' : 'This Month'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.filterSection}>
            <Text style={[styles.filterTitle, { color: theme?.colors?.text }]}>PICK TYPE</Text>
            <View style={styles.filterRow}>
              {[{ key: 'all', label: 'All Picks' }, { key: 'spread', label: 'Spread' }, { key: 'total', label: 'Over/Under' }].map(item => (
                <Pressable
                  key={item.key}
                  style={[styles.filterButton, { backgroundColor: filter === item.key ? theme?.colors?.primary : theme?.colors?.card }]}
                  onPress={() => setFilter(item.key)}
                >
                  <Text style={[styles.filterButtonText, { color: filter === item.key ? '#fff' : theme?.colors?.text }]}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Overall Performance</Text>
            <View style={styles.statsGrid}>
              <StatCard label="Win Rate" value={`${stats?.winPercentage ?? 0}%`} subtext={`${stats?.overallWins ?? 0}-${stats?.overallLosses ?? 0}`} />
              <StatCard label="Total Picks" value={stats?.totalPicks ?? 0} />
            </View>
          </View>

          {(filter === 'all' || filter === 'spread') && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Spread Picks</Text>
              <View style={styles.statsGrid}>
                <StatCard label="Spread Win Rate" value={`${stats?.spreadWinPercentage ?? 0}%`} />
                <StatCard label="Wins" value={stats?.spreadWins ?? 0} />
                <StatCard label="Losses" value={stats?.spreadLosses ?? 0} />
                <StatCard label="Pushes" value={stats?.spreadPushes ?? 0} />
              </View>
            </View>
          )}

          {(filter === 'all' || filter === 'total') && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Over/Under Picks</Text>
              <View style={styles.statsGrid}>
                <StatCard label="Total Win Rate" value={`${stats?.totalWinPercentage ?? 0}%`} />
                <StatCard label="Wins" value={stats?.totalWins ?? 0} />
                <StatCard label="Losses" value={stats?.totalLosses ?? 0} />
                <StatCard label="Pushes" value={stats?.totalPushes ?? 0} />
              </View>
            </View>
          )}

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>Achievements</Text>
            <View style={[styles.achievementCard, { backgroundColor: theme?.colors?.card }]}>
              <Text style={[styles.achievementLabel, { color: theme?.colors?.muted }]}> Current Streak</Text>
              <Text style={[styles.achievementValue, { color: theme?.colors?.text }]}>
                {(stats?.currentStreak?.count ?? 0)} {(stats?.currentStreak?.type ?? 'none')}
              </Text>
            </View>
            <View style={[styles.achievementCard, { backgroundColor: theme?.colors?.card }]}>
              <Text style={[styles.achievementLabel, { color: theme?.colors?.muted }]}> Longest Win Streak</Text>
              <Text style={[styles.achievementValue, { color: theme?.colors?.text }]}>{stats?.longestWinStreak ?? 0} wins</Text>
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 20, paddingTop: 60, paddingBottom: 24 },
  h1: { fontSize: 28, fontWeight: '700' },
  trendButton: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 12, marginBottom: 8 },
  trendButtonText: { fontSize: 16, fontWeight: '600', marginBottom: 2 },
  filterSection: { paddingHorizontal: 16, marginBottom: 20 },
  filterTitle: { fontSize: 14, fontWeight: '600', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterButton: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  filterButtonText: { fontSize: 14, fontWeight: '600' },
  section: { paddingHorizontal: 16, marginBottom: 24 },
  sectionTitle: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  statCard: { flex: 1, minWidth: '45%', padding: 16, borderRadius: 12, alignItems: 'center' },
  statValue: { fontSize: 32, fontWeight: '700', marginBottom: 8 },
  statLabel: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  statSubtext: { fontSize: 12, marginTop: 4 },
  achievementCard: { borderRadius: 12, padding: 16, marginBottom: 12 },
  achievementLabel: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  achievementValue: { fontSize: 24, fontWeight: '700' },
  // Weekly Recap Styles
  weekButton: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8 },
  recapHeader: { padding: 20, borderRadius: 12, alignItems: 'center' },
  recapCard: { flex: 1, minWidth: '45%', padding: 16, borderRadius: 12, alignItems: 'center' },
  recapCardValue: { fontSize: 28, fontWeight: '800', color: '#fff', marginBottom: 4 },
  recapCardLabel: { fontSize: 13, fontWeight: '600', color: '#fff', opacity: 0.9 },
  breakdownCard: { padding: 16, borderRadius: 12 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.05)' },
  rankingCard: { padding: 16, borderRadius: 12 },
  rankBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  gameCard: { padding: 14, borderRadius: 12 },
  emptyCard: { padding: 32, borderRadius: 12, alignItems: 'center', marginHorizontal: 16, marginTop: 24 },
});
