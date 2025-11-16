import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadResults } from './storage';
import { computeUserStats } from './stats';

export const AchievementsScreen = ({ leagues, currentUser, theme }) => {
  const [achievements, setAchievements] = useState([]);
  const [stats, setStats] = useState({});
  const [loadedPersisted, setLoadedPersisted] = useState(false);
  const [newUnlocks, setNewUnlocks] = useState([]); // array of achievement objects just unlocked
  const dismissTimer = useRef(null);

  useEffect(() => {
    calculateAchievements();
  }, [leagues, currentUser]);

  const calculateAchievements = async () => {
    const userId = currentUser?.id;
    if (!userId) return;

    // Load real results and compute stats
    const results = await loadResults();
    const userStats = computeUserStats({
      leagues: leagues || [],
      userId,
      results,
      pickType: 'all',
      timePeriod: 'allTime',
    });

    let totalPicks = userStats.totalPicks;
    let totalWins = userStats.overallWins;
    let totalLeagues = 0;
    let highestConfidence = 0;
    let highConfidenceWins = 0;

    // Calculate additional metrics
    leagues.forEach(league => {
      if (league.members.includes(userId)) {
        totalLeagues++;
      }

      const picks = league.picks[userId] || {};
      Object.entries(picks).forEach(([gameId, pick]) => {
        if (pick.confidence && pick.confidence > highestConfidence) {
          highestConfidence = pick.confidence;
        }
        // Count high-confidence wins
        if (pick.confidence >= 4) {
          const result = results[gameId];
          if (result?.isFinal) {
            const { evaluatePick } = require('./stats');
            const outcome = evaluatePick(pick, result);
            if (outcome?.spreadResult === 'win' || outcome?.totalResult === 'win') {
              highConfidenceWins++;
            }
          }
        }
      });
    });

    // Calculate perfect weeks (7+ picks with 100% win rate in last 7 days)
    const perfectWeeks = calculatePerfectWeeks(leagues, userId, results);

    const currentStreak = userStats.currentStreak?.count || 0;
    const longestWinStreak = userStats.longestWinStreak || 0;

    // Win percentage milestones
    const winPercentage = userStats.winPercentage || 0;

    // Define achievements organized by category
  const allAchievements = [
      // === GETTING STARTED ===
      {
        id: 'first_pick',
        name: 'First Pick',
        description: 'Make your first pick',
        icon: '🏈',
        category: 'Getting Started',
        unlocked: totalPicks >= 1,
        progress: Math.min(totalPicks, 1),
        target: 1,
        tier: 'bronze',
      },
      {
        id: 'first_win',
        name: 'First Victory',
        description: 'Win your first pick',
        icon: '🎉',
        category: 'Getting Started',
        unlocked: totalWins >= 1,
        progress: Math.min(totalWins, 1),
        target: 1,
        tier: 'bronze',
      },
      {
        id: 'join_league',
        name: 'League Member',
        description: 'Join your first league',
        icon: '👥',
        category: 'Getting Started',
        unlocked: totalLeagues >= 1,
        progress: Math.min(totalLeagues, 1),
        target: 1,
        tier: 'bronze',
      },
      {
        id: 'ten_picks',
        name: 'Getting Started',
        description: 'Make 10 picks',
        icon: '📊',
        category: 'Getting Started',
        unlocked: totalPicks >= 10,
        progress: Math.min(totalPicks, 10),
        target: 10,
        tier: 'bronze',
      },
      
      // === MILESTONES (WINS) ===
      {
        id: 'five_wins',
        name: 'Winning Ways',
        description: 'Win 5 picks',
        icon: '🏅',
        category: 'Milestones',
        unlocked: totalWins >= 5,
        progress: Math.min(totalWins, 5),
        target: 5,
        tier: 'silver',
      },
      {
        id: 'ten_wins',
        name: 'Double Digits',
        description: 'Win 10 picks',
        icon: '🔟',
        category: 'Milestones',
        unlocked: totalWins >= 10,
        progress: Math.min(totalWins, 10),
        target: 10,
        tier: 'silver',
      },
      {
        id: 'twenty_five_wins',
        name: 'Quarter Century',
        description: 'Win 25 picks',
        icon: '🎯',
        category: 'Milestones',
        unlocked: totalWins >= 25,
        progress: Math.min(totalWins, 25),
        target: 25,
        tier: 'silver',
      },
      {
        id: 'fifty_wins',
        name: 'Half Century',
        description: 'Win 50 picks',
        icon: '⚡',
        category: 'Milestones',
        unlocked: totalWins >= 50,
        progress: Math.min(totalWins, 50),
        target: 50,
        tier: 'gold',
      },
      {
        id: 'hundred_wins',
        name: 'Centurion',
        description: 'Win 100 picks',
        icon: '💯',
        category: 'Milestones',
        unlocked: totalWins >= 100,
        progress: Math.min(totalWins, 100),
        target: 100,
        tier: 'gold',
      },
      {
        id: 'two_fifty_wins',
        name: 'Elite Performer',
        description: 'Win 250 picks',
        icon: '🌟',
        category: 'Milestones',
        unlocked: totalWins >= 250,
        progress: Math.min(totalWins, 250),
        target: 250,
        tier: 'platinum',
      },
      {
        id: 'five_hundred_wins',
        name: 'Legend',
        description: 'Win 500 picks',
        icon: '👑',
        category: 'Milestones',
        unlocked: totalWins >= 500,
        progress: Math.min(totalWins, 500),
        target: 500,
        tier: 'platinum',
      },
      
      // === STREAKS ===
      {
        id: 'win_streak_3',
        name: 'Hot Hand',
        description: 'Win 3 picks in a row',
        icon: '🔥',
        category: 'Streaks',
        unlocked: longestWinStreak >= 3,
        progress: Math.min(longestWinStreak, 3),
        target: 3,
        tier: 'silver',
      },
      {
        id: 'win_streak_5',
        name: 'On Fire',
        description: 'Win 5 picks in a row',
        icon: '🔥🔥',
        category: 'Streaks',
        unlocked: longestWinStreak >= 5,
        progress: Math.min(longestWinStreak, 5),
        target: 5,
        tier: 'gold',
      },
      {
        id: 'win_streak_10',
        name: 'Unstoppable',
        description: 'Win 10 picks in a row',
        icon: '🔥🔥🔥',
        category: 'Streaks',
        unlocked: longestWinStreak >= 10,
        progress: Math.min(longestWinStreak, 10),
        target: 10,
        tier: 'platinum',
      },
      {
        id: 'win_streak_15',
        name: 'Legendary Streak',
        description: 'Win 15 picks in a row',
        icon: '🌟🔥',
        category: 'Streaks',
        unlocked: longestWinStreak >= 15,
        progress: Math.min(longestWinStreak, 15),
        target: 15,
        tier: 'platinum',
      },
      
      // === ACCURACY ===
      {
        id: 'accuracy_60',
        name: 'Above Average',
        description: 'Achieve 60% win rate (min. 10 picks)',
        icon: '📈',
        category: 'Accuracy',
        unlocked: winPercentage >= 60 && totalPicks >= 10,
        progress: totalPicks >= 10 ? Math.min(winPercentage, 60) : 0,
        target: 60,
        tier: 'silver',
      },
      {
        id: 'accuracy_70',
        name: 'Sharp Shooter',
        description: 'Achieve 70% win rate (min. 20 picks)',
        icon: '🎯',
        category: 'Accuracy',
        unlocked: winPercentage >= 70 && totalPicks >= 20,
        progress: totalPicks >= 20 ? Math.min(winPercentage, 70) : 0,
        target: 70,
        tier: 'gold',
      },
      {
        id: 'accuracy_75',
        name: 'Elite Handicapper',
        description: 'Achieve 75% win rate (min. 30 picks)',
        icon: '💎',
        category: 'Accuracy',
        unlocked: winPercentage >= 75 && totalPicks >= 30,
        progress: totalPicks >= 30 ? Math.min(winPercentage, 75) : 0,
        target: 75,
        tier: 'platinum',
      },
      {
        id: 'perfect_week',
        name: 'Perfect Week',
        description: 'Go undefeated in a week (min. 5 picks)',
        icon: '✨',
        category: 'Accuracy',
        unlocked: perfectWeeks >= 1,
        progress: Math.min(perfectWeeks, 1),
        target: 1,
        tier: 'platinum',
      },
      
      // === VOLUME ===
      {
        id: 'fifty_picks',
        name: 'Seasoned Picker',
        description: 'Make 50 picks',
        icon: '⭐',
        category: 'Volume',
        unlocked: totalPicks >= 50,
        progress: Math.min(totalPicks, 50),
        target: 50,
        tier: 'silver',
      },
      {
        id: 'hundred_picks',
        name: 'Century Club',
        description: 'Make 100 picks',
        icon: '💯',
        category: 'Volume',
        unlocked: totalPicks >= 100,
        progress: Math.min(totalPicks, 100),
        target: 100,
        tier: 'gold',
      },
      {
        id: 'two_fifty_picks',
        name: 'Dedicated',
        description: 'Make 250 picks',
        icon: '🎖️',
        category: 'Volume',
        unlocked: totalPicks >= 250,
        progress: Math.min(totalPicks, 250),
        target: 250,
        tier: 'gold',
      },
      {
        id: 'five_hundred_picks',
        name: 'Iron Man',
        description: 'Make 500 picks',
        icon: '🏆',
        category: 'Volume',
        unlocked: totalPicks >= 500,
        progress: Math.min(totalPicks, 500),
        target: 500,
        tier: 'platinum',
      },
      {
        id: 'thousand_picks',
        name: 'True Grinder',
        description: 'Make 1,000 picks',
        icon: '👑',
        category: 'Volume',
        unlocked: totalPicks >= 1000,
        progress: Math.min(totalPicks, 1000),
        target: 1000,
        tier: 'platinum',
      },
      
      // === CONFIDENCE ===
      {
        id: 'confident',
        name: 'High Confidence',
        description: 'Set a 5-star confidence pick',
        icon: '🌟',
        category: 'Confidence',
        unlocked: highestConfidence >= 5,
        progress: Math.min(highestConfidence, 5),
        target: 5,
        tier: 'bronze',
      },
      {
        id: 'confident_wins',
        name: 'Confident Winner',
        description: 'Win 5 high-confidence picks (4-5 stars)',
        icon: '⭐⭐',
        category: 'Confidence',
        unlocked: highConfidenceWins >= 5,
        progress: Math.min(highConfidenceWins, 5),
        target: 5,
        tier: 'gold',
      },
      {
        id: 'confident_wins_10',
        name: 'Conviction',
        description: 'Win 10 high-confidence picks (4-5 stars)',
        icon: '⭐⭐⭐',
        category: 'Confidence',
        unlocked: highConfidenceWins >= 10,
        progress: Math.min(highConfidenceWins, 10),
        target: 10,
        tier: 'gold',
      },
      
      // === LOYALTY ===
      {
        id: 'multiple_leagues',
        name: 'League Hopper',
        description: 'Join 3 leagues',
        icon: '🎯',
        category: 'Loyalty',
        unlocked: totalLeagues >= 3,
        progress: Math.min(totalLeagues, 3),
        target: 3,
        tier: 'silver',
      },
      {
        id: 'five_leagues',
        name: 'League Master',
        description: 'Join 5 leagues',
        icon: '👥',
        category: 'Loyalty',
        unlocked: totalLeagues >= 5,
        progress: Math.min(totalLeagues, 5),
        target: 5,
        tier: 'gold',
      },
    ];

    // Merge with persisted unlocked achievements (once unlocked, always unlocked)
    const storageKey = `achievements:unlocked:${userId}`;
    let persisted = [];
    try {
      const raw = await AsyncStorage.getItem(storageKey);
      if (raw) persisted = JSON.parse(raw);
    } catch (e) {
      // ignore parse errors
    }

    const persistedSet = new Set(Array.isArray(persisted) ? persisted : []);
    const merged = allAchievements.map(a => ({
      ...a,
      unlocked: a.unlocked || persistedSet.has(a.id),
    }));

    // Determine if any new achievements were just unlocked
    const newlyUnlocked = merged
      .filter(a => a.unlocked && !persistedSet.has(a.id))
      .map(a => a.id);

    if (newlyUnlocked.length > 0) {
      const updated = Array.from(new Set([...persistedSet, ...newlyUnlocked]));
      try {
        await AsyncStorage.setItem(storageKey, JSON.stringify(updated));
      } catch (e) {
        // best-effort persistence
      }

      // Prepare toast state for newly unlocked achievements
      const unlockedObjects = newlyUnlocked
        .map(id => allAchievements.find(a => a.id === id))
        .filter(Boolean);
      setNewUnlocks(unlockedObjects);

      // Auto-dismiss after a few seconds
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      dismissTimer.current = setTimeout(() => setNewUnlocks([]), 4000);
    }

    setAchievements(merged);
    setStats({
      totalPicks,
      totalWins,
      totalLeagues,
      perfectWeeks,
      currentStreak,
      longestWinStreak,
      unlockedCount: merged.filter(a => a.unlocked).length,
      totalCount: merged.length,
    });
  };

  const unlockedAchievements = achievements.filter(a => a.unlocked);
  const lockedAchievements = achievements.filter(a => !a.unlocked);

  // Group achievements by category
  const categories = [
    'Getting Started',
    'Milestones',
    'Streaks',
    'Accuracy',
    'Volume',
    'Confidence',
    'Loyalty',
  ];

  const getCategoryIcon = (category) => {
    const icons = {
      'Getting Started': '🚀',
      'Milestones': '🏅',
      'Streaks': '🔥',
      'Accuracy': '🎯',
      'Volume': '📊',
      'Confidence': '⭐',
      'Loyalty': '👑',
    };
    return icons[category] || '📌';
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
      {/* New Achievement Toast */}
      {newUnlocks.length > 0 && (
        <View style={{
          marginHorizontal: 16,
          marginTop: 16,
          marginBottom: 0,
          backgroundColor: theme?.colors?.success,
          borderRadius: 12,
          padding: 12,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>
              🎉 New achievement unlocked!
            </Text>
            <Pressable onPress={() => setNewUnlocks([])}>
              <Text style={{ color: '#fff', fontWeight: '700' }}>Dismiss</Text>
            </Pressable>
          </View>
          {newUnlocks.slice(0, 2).map(a => (
            <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
              <Text style={{ fontSize: 20, marginRight: 8 }}> {a.icon} </Text>
              <Text style={{ color: '#fff', fontWeight: '700' }}>{a.name}</Text>
            </View>
          ))}
          {newUnlocks.length > 2 && (
            <Text style={{ color: '#fff', opacity: 0.9, marginTop: 6 }}>
              +{newUnlocks.length - 2} more
            </Text>
          )}
        </View>
      )}
      <View style={[styles.header, { backgroundColor: theme?.colors?.bannerBg }]}>
        <Text style={[styles.h1, { color: theme?.colors?.heading }]}>Achievements</Text>
        <Text style={[styles.subtitle, { color: theme?.colors?.muted }]}>
          {stats.unlockedCount} of {stats.totalCount} unlocked
        </Text>
      </View>

      {/* Progress Bar */}
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <View style={{
          height: 8,
          backgroundColor: theme?.colors?.border,
          borderRadius: 4,
          overflow: 'hidden'
        }}>
          <View style={{
            height: '100%',
            width: `${(stats.unlockedCount / stats.totalCount) * 100}%`,
            backgroundColor: theme?.colors?.success,
          }} />
        </View>
        <Text style={{
          color: theme?.colors?.muted,
          fontSize: 12,
          textAlign: 'center',
          marginTop: 6
        }}>
          {Math.round((stats.unlockedCount / stats.totalCount) * 100)}% Complete
        </Text>
      </View>

      {/* Categories */}
      {categories.map(category => {
        const categoryAchievements = achievements.filter(a => a.category === category);
        const unlockedInCategory = categoryAchievements.filter(a => a.unlocked).length;
        
        if (categoryAchievements.length === 0) return null;

        return (
          <View key={category} style={{ paddingHorizontal: 16, marginBottom: 24 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Text style={{ fontSize: 24, marginRight: 8 }}>{getCategoryIcon(category)}</Text>
              <Text style={[styles.sectionTitle, { color: theme?.colors?.text, marginBottom: 0, flex: 1 }]}>
                {category}
              </Text>
              <Text style={{ color: theme?.colors?.muted, fontSize: 13 }}>
                {unlockedInCategory}/{categoryAchievements.length}
              </Text>
            </View>
            
            {categoryAchievements.map(achievement => (
              <View
                key={achievement.id}
                style={[
                  styles.card,
                  {
                    backgroundColor: theme?.colors?.card,
                    marginBottom: 12,
                    borderLeftWidth: 4,
                    borderLeftColor: achievement.unlocked ? theme?.colors?.success : 'transparent',
                    opacity: achievement.unlocked ? 1 : 0.6,
                  }
                ]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={{ fontSize: 40, marginRight: 16, opacity: achievement.unlocked ? 1 : 0.5 }}>
                    {achievement.icon}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: '700', color: theme?.colors?.text, marginBottom: 4 }}>
                      {achievement.name}
                    </Text>
                    <Text style={{ color: theme?.colors?.muted, fontSize: 13, marginBottom: 6 }}>
                      {achievement.description}
                    </Text>
                    
                    {achievement.unlocked ? (
                      <View style={{ marginTop: 2, flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={{ color: theme?.colors?.success, fontSize: 12, fontWeight: '600' }}>
                          ✓ Unlocked
                        </Text>
                      </View>
                    ) : (
                      <>
                        {/* Progress Bar */}
                        <View style={{
                          height: 6,
                          backgroundColor: theme?.colors?.border,
                          borderRadius: 3,
                          overflow: 'hidden',
                          marginBottom: 4
                        }}>
                          <View style={{
                            height: '100%',
                            width: `${(achievement.progress / achievement.target) * 100}%`,
                            backgroundColor: theme?.colors?.primary,
                          }} />
                        </View>
                        <Text style={{ color: theme?.colors?.muted, fontSize: 11 }}>
                          {achievement.progress} / {achievement.target}
                        </Text>
                      </>
                    )}
                  </View>
                </View>
              </View>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
};

// Helper function to calculate perfect weeks
function calculatePerfectWeeks(leagues, userId, results) {
  const { evaluatePick } = require('./stats');
  const weekResults = {}; // key: week start date, value: { wins, losses, total }
  
  leagues.forEach(league => {
    const picks = league.picks[userId] || {};
    Object.entries(picks).forEach(([gameId, pick]) => {
      const result = results[gameId];
      if (!result?.isFinal || !result.finalizedAt) return;
      
      // Get week start (Sunday of that week)
      const finalDate = new Date(result.finalizedAt);
      const dayOfWeek = finalDate.getDay();
      const weekStart = new Date(finalDate);
      weekStart.setDate(finalDate.getDate() - dayOfWeek);
      weekStart.setHours(0, 0, 0, 0);
      const weekKey = weekStart.toISOString().split('T')[0];
      
      if (!weekResults[weekKey]) {
        weekResults[weekKey] = { wins: 0, losses: 0, total: 0 };
      }
      
      const outcome = evaluatePick(pick, result);
      if (outcome?.spreadResult === 'win' || outcome?.totalResult === 'win') {
        weekResults[weekKey].wins++;
        weekResults[weekKey].total++;
      } else if (outcome?.spreadResult === 'loss' || outcome?.totalResult === 'loss') {
        weekResults[weekKey].losses++;
        weekResults[weekKey].total++;
      }
    });
  });
  
  // Count weeks with 100% win rate and at least 5 picks
  let perfectWeekCount = 0;
  Object.values(weekResults).forEach(week => {
    if (week.total >= 5 && week.losses === 0 && week.wins > 0) {
      perfectWeekCount++;
    }
  });
  
  return perfectWeekCount;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 20, paddingTop: 60, paddingBottom: 24 },
  h1: { fontSize: 28, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 14 },
  sectionTitle: { fontSize: 18, fontWeight: '600' },
  card: { borderRadius: 12, padding: 16 },
});
