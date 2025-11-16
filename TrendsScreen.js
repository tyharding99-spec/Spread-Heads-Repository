import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { loadResults } from './storage';
import { evaluatePick } from './stats';

export const TrendsScreen = ({ currentUser, leagues, theme }) => {
  const [loading, setLoading] = useState(true);
  const [trends, setTrends] = useState(null);
  const [filter, setFilter] = useState('all'); // 'all' | 'spread' | 'total'
  const userId = currentUser?.id;

  useEffect(() => {
    loadTrends();
  }, [leagues, userId, filter]);

  const loadTrends = async () => {
    setLoading(true);
    const results = await loadResults();
    const analytics = computeAdvancedAnalytics(leagues, userId, results, filter);
    setTrends(analytics);
    setLoading(false);
  };

  const computeAdvancedAnalytics = (leagues, userId, results, pickType) => {
    if (!userId) return null;

    // Collect all resolved picks
    const resolvedPicks = [];
    leagues.forEach(league => {
      const userPicks = league.picks?.[userId] || {};
      Object.entries(userPicks).forEach(([gameId, pick]) => {
        const result = results?.[gameId];
        if (!result?.isFinal) return;
        
        const outcome = evaluatePick(pick, result);
        if (!outcome) return;

        // Filter by pick type
        if (pickType === 'spread' && pick.spread && outcome.spreadResult) {
          resolvedPicks.push({
            gameId,
            pick,
            result,
            outcome: outcome.spreadResult,
            type: 'spread',
            team: pick.spread,
          });
        } else if (pickType === 'total' && pick.total && outcome.totalResult) {
          resolvedPicks.push({
            gameId,
            pick,
            result,
            outcome: outcome.totalResult,
            type: 'total',
            team: null,
          });
        } else if (pickType === 'all') {
          if (pick.spread && outcome.spreadResult) {
            resolvedPicks.push({
              gameId,
              pick,
              result,
              outcome: outcome.spreadResult,
              type: 'spread',
              team: pick.spread,
            });
          }
          if (pick.total && outcome.totalResult) {
            resolvedPicks.push({
              gameId,
              pick,
              result,
              outcome: outcome.totalResult,
              type: 'total',
              team: null,
            });
          }
        }
      });
    });

    // Performance by team
    const teamPerformance = {};
    resolvedPicks.forEach(p => {
      if (!p.team) return;
      if (!teamPerformance[p.team]) {
        teamPerformance[p.team] = { wins: 0, losses: 0, pushes: 0 };
      }
      if (p.outcome === 'win') teamPerformance[p.team].wins++;
      else if (p.outcome === 'loss') teamPerformance[p.team].losses++;
      else if (p.outcome === 'push') teamPerformance[p.team].pushes++;
    });

    // Home vs Away
    const homeAway = { home: { wins: 0, losses: 0 }, away: { wins: 0, losses: 0 } };
    resolvedPicks.forEach(p => {
      if (p.type !== 'spread') return;
      const isHome = p.team === p.result.homeTeam;
      const loc = isHome ? 'home' : 'away';
      if (p.outcome === 'win') homeAway[loc].wins++;
      else if (p.outcome === 'loss') homeAway[loc].losses++;
    });

    // Favorite vs Underdog
    const favUnderdog = { favorite: { wins: 0, losses: 0 }, underdog: { wins: 0, losses: 0 } };
    resolvedPicks.forEach(p => {
      if (p.type !== 'spread') return;
      const isAway = p.team === p.result.awayTeam;
      const spread = isAway ? p.result.awaySpread : p.result.homeSpread;
      if (spread === null) return;
      const isFavorite = spread < 0;
      const cat = isFavorite ? 'favorite' : 'underdog';
      if (p.outcome === 'win') favUnderdog[cat].wins++;
      else if (p.outcome === 'loss') favUnderdog[cat].losses++;
    });

    // Recent form (last 10 picks)
    const recent = resolvedPicks
      .sort((a, b) => new Date(b.pick.timestamp || b.result.finalizedAt) - new Date(a.pick.timestamp || a.result.finalizedAt))
      .slice(0, 10);

    return {
      totalPicks: resolvedPicks.length,
      teamPerformance,
      homeAway,
      favUnderdog,
      recentForm: recent,
    };
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: theme?.colors?.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={theme?.colors?.primary} />
      </View>
    );
  }

  if (!trends || trends.totalPicks === 0) {
    return (
      <View style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
        <View style={[styles.header, { backgroundColor: theme?.colors?.bannerBg }]}>
          <Text style={[styles.h1, { color: theme?.colors?.heading }]}>Advanced Analytics</Text>
        </View>
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Text style={{ color: theme?.colors?.muted, fontSize: 16, textAlign: 'center' }}>
            No completed picks yet. Make some picks and come back to see your analytics!
          </Text>
        </View>
      </View>
    );
  }

  const renderWinRate = (wins, losses) => {
    const total = wins + losses;
    if (total === 0) return '—';
    const rate = Math.round((wins / total) * 1000) / 10;
    return `${rate}%`;
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
      <View style={[styles.header, { backgroundColor: theme?.colors?.bannerBg }]}>
        <Text style={[styles.h1, { color: theme?.colors?.heading }]}>Advanced Analytics</Text>
        <Text style={[styles.subtitle, { color: theme?.colors?.muted }]}>
          {trends.totalPicks} completed picks analyzed
        </Text>
      </View>

      {/* Filter Buttons */}
      <View style={styles.filterSection}>
        <Text style={[styles.filterTitle, { color: theme?.colors?.text }]}>PICK TYPE</Text>
        <View style={styles.filterRow}>
          {[{ key: 'all', label: 'All' }, { key: 'spread', label: 'Spread' }, { key: 'total', label: 'Over/Under' }].map(item => (
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

      {/* Team Performance */}
      {Object.keys(trends.teamPerformance).length > 0 && (
        <View style={[styles.section, { backgroundColor: theme?.colors?.card }]}>
          <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>📊 Performance by Team</Text>
          {Object.entries(trends.teamPerformance)
            .sort((a, b) => {
              const aTotal = a[1].wins + a[1].losses;
              const bTotal = b[1].wins + b[1].losses;
              const aRate = aTotal > 0 ? a[1].wins / aTotal : 0;
              const bRate = bTotal > 0 ? b[1].wins / bTotal : 0;
              return bRate - aRate;
            })
            .slice(0, 10)
            .map(([team, stats]) => (
              <View key={team} style={styles.teamRow}>
                <Text style={[styles.teamName, { color: theme?.colors?.text }]} numberOfLines={1}>{team}</Text>
                <View style={styles.teamStats}>
                  <Text style={[styles.teamRecord, { color: theme?.colors?.text }]}>
                    {stats.wins}-{stats.losses}
                  </Text>
                  <Text style={[styles.teamWinRate, { color: theme?.colors?.success }]}>
                    {renderWinRate(stats.wins, stats.losses)}
                  </Text>
                </View>
              </View>
            ))}
        </View>
      )}

      {/* Home vs Away */}
      <View style={[styles.section, { backgroundColor: theme?.colors?.card }]}>
        <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>🏟️ Home vs Away</Text>
        <View style={styles.comparisonRow}>
          <View style={styles.comparisonCard}>
            <Text style={[styles.comparisonLabel, { color: theme?.colors?.muted }]}>Home Teams</Text>
            <Text style={[styles.comparisonValue, { color: theme?.colors?.text }]}>
              {trends.homeAway.home.wins}-{trends.homeAway.home.losses}
            </Text>
            <Text style={[styles.comparisonRate, { color: theme?.colors?.success }]}>
              {renderWinRate(trends.homeAway.home.wins, trends.homeAway.home.losses)}
            </Text>
          </View>
          <View style={styles.comparisonCard}>
            <Text style={[styles.comparisonLabel, { color: theme?.colors?.muted }]}>Away Teams</Text>
            <Text style={[styles.comparisonValue, { color: theme?.colors?.text }]}>
              {trends.homeAway.away.wins}-{trends.homeAway.away.losses}
            </Text>
            <Text style={[styles.comparisonRate, { color: theme?.colors?.success }]}>
              {renderWinRate(trends.homeAway.away.wins, trends.homeAway.away.losses)}
            </Text>
          </View>
        </View>
      </View>

      {/* Favorite vs Underdog */}
      <View style={[styles.section, { backgroundColor: theme?.colors?.card }]}>
        <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>⚖️ Favorite vs Underdog</Text>
        <View style={styles.comparisonRow}>
          <View style={styles.comparisonCard}>
            <Text style={[styles.comparisonLabel, { color: theme?.colors?.muted }]}>Favorites</Text>
            <Text style={[styles.comparisonValue, { color: theme?.colors?.text }]}>
              {trends.favUnderdog.favorite.wins}-{trends.favUnderdog.favorite.losses}
            </Text>
            <Text style={[styles.comparisonRate, { color: theme?.colors?.success }]}>
              {renderWinRate(trends.favUnderdog.favorite.wins, trends.favUnderdog.favorite.losses)}
            </Text>
          </View>
          <View style={styles.comparisonCard}>
            <Text style={[styles.comparisonLabel, { color: theme?.colors?.muted }]}>Underdogs</Text>
            <Text style={[styles.comparisonValue, { color: theme?.colors?.text }]}>
              {trends.favUnderdog.underdog.wins}-{trends.favUnderdog.underdog.losses}
            </Text>
            <Text style={[styles.comparisonRate, { color: theme?.colors?.success }]}>
              {renderWinRate(trends.favUnderdog.underdog.wins, trends.favUnderdog.underdog.losses)}
            </Text>
          </View>
        </View>
      </View>

      {/* Confidence Correlation section removed */}

      {/* Recent Form */}
      {trends.recentForm.length > 0 && (
        <View style={[styles.section, { backgroundColor: theme?.colors?.card }]}>
          <Text style={[styles.sectionTitle, { color: theme?.colors?.text }]}>📈 Recent Form (Last 10)</Text>
          <View style={styles.formRow}>
            {trends.recentForm.map((pick, idx) => (
              <View
                key={idx}
                style={[
                  styles.formIndicator,
                  {
                    backgroundColor:
                      pick.outcome === 'win'
                        ? theme?.colors?.success
                        : pick.outcome === 'loss'
                        ? theme?.colors?.error
                        : theme?.colors?.border,
                  },
                ]}
              >
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
                  {pick.outcome === 'win' ? 'W' : pick.outcome === 'loss' ? 'L' : 'P'}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
};

const StatBox = ({ title, value }) => (
  <View style={styles.statBox}>
    <Text style={styles.statTitle}>{title}</Text>
    <Text style={styles.statValue}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 20, paddingTop: 60, paddingBottom: 24 },
  h1: { fontSize: 28, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 14 },
  filterSection: { paddingHorizontal: 16, marginBottom: 20 },
  filterTitle: { fontSize: 14, fontWeight: '600', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterButton: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  filterButtonText: { fontSize: 14, fontWeight: '600' },
  section: { marginHorizontal: 16, marginBottom: 20, borderRadius: 12, padding: 16 },
  sectionTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  sectionSubtext: { fontSize: 13, marginBottom: 12 },
  teamRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  teamName: { flex: 1, fontSize: 14, fontWeight: '500' },
  teamStats: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  teamRecord: { fontSize: 14, fontWeight: '600', minWidth: 40, textAlign: 'right' },
  teamWinRate: { fontSize: 14, fontWeight: '700', minWidth: 50, textAlign: 'right' },
  comparisonRow: { flexDirection: 'row', gap: 12 },
  comparisonCard: { flex: 1, backgroundColor: '#f9fafb', borderRadius: 8, padding: 16, alignItems: 'center' },
  comparisonLabel: { fontSize: 12, fontWeight: '600', marginBottom: 8 },
  comparisonValue: { fontSize: 20, fontWeight: '700', marginBottom: 4 },
  comparisonRate: { fontSize: 14, fontWeight: '600' },
  // removed confidence styles
  formRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  formIndicator: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});