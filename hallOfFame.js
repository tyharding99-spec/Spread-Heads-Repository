/**
 * Hall of Fame - Track historical achievements and records for leagues
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const HOF_KEY_PREFIX = 'hallOfFame:';

/**
 * Get Hall of Fame data for a league
 */
export const getHallOfFame = async (leagueCode) => {
  try {
    const key = `${HOF_KEY_PREFIX}${leagueCode}`;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return getDefaultHallOfFame();
    const parsed = JSON.parse(raw);
    return { ...getDefaultHallOfFame(), ...parsed };
  } catch (error) {
    console.warn('Failed to load Hall of Fame:', error);
    return getDefaultHallOfFame();
  }
};

/**
 * Save Hall of Fame data for a league
 */
export const saveHallOfFame = async (leagueCode, hofData) => {
  try {
    const key = `${HOF_KEY_PREFIX}${leagueCode}`;
    await AsyncStorage.setItem(key, JSON.stringify(hofData));
    return true;
  } catch (error) {
    console.warn('Failed to save Hall of Fame:', error);
    return false;
  }
};

/**
 * Default Hall of Fame structure
 */
const getDefaultHallOfFame = () => ({
  champions: [], // Season champions
  records: {
    highestWinPercentage: null,
    mostWinsInSeason: null,
    longestWinStreak: null,
    mostPointsInWeek: null,
    mostPointsInSeason: null,
    perfectWeeks: [], // Users who had perfect weeks
    ironMan: null, // Most consecutive picks without missing
  },
  achievements: {
    firstBlood: null, // First person to win a pick
    centurion: [], // 100+ wins
    undefeated: [], // Perfect seasons
    comeback: [], // Biggest comeback victories
  },
  milestones: [], // Custom milestones
  seasonHistory: [], // Record of each season
});

/**
 * Calculate Hall of Fame stats from league data and results
 */
export const calculateHallOfFame = (league, results) => {
  const hof = getDefaultHallOfFame();
  
  if (!league || !results) return hof;

  const picks = league.picks || {};
  const members = league.members || [];

  // Calculate stats per user
  const userStats = {};
  
  members.forEach(userId => {
    userStats[userId] = {
      userId,
      totalWins: 0,
      totalLosses: 0,
      totalPicks: 0,
      totalPoints: 0,
      perfectWeeks: 0,
      bestWeek: { week: null, points: 0 },
      currentStreak: 0,
      longestStreak: 0,
      consecutivePicks: 0,
      weeklyScores: {},
    };
  });

  // Process all picks
  Object.entries(picks).forEach(([userId, userPicks]) => {
    if (!userStats[userId]) return;

    const stats = userStats[userId];
    
    Object.entries(userPicks).forEach(([gameId, pick]) => {
      const result = results[gameId];
      if (!result || result.status !== 'completed') return;

      const week = result.week || 1;
      if (!stats.weeklyScores[week]) {
        stats.weeklyScores[week] = { correct: 0, incorrect: 0, points: 0 };
      }

      stats.totalPicks++;
      stats.consecutivePicks++;

      // Check if pick was correct
      const isCorrect = checkPickCorrect(pick, result);
      
      if (isCorrect) {
        stats.totalWins++;
        stats.weeklyScores[week].correct++;
        stats.currentStreak++;
        
        const points = pick.confidence || 1;
        stats.totalPoints += points;
        stats.weeklyScores[week].points += points;

        if (stats.currentStreak > stats.longestStreak) {
          stats.longestStreak = stats.currentStreak;
        }
      } else {
        stats.totalLosses++;
        stats.weeklyScores[week].incorrect++;
        stats.currentStreak = 0;
      }
    });

    // Calculate perfect weeks
    Object.entries(stats.weeklyScores).forEach(([week, scores]) => {
      if (scores.correct > 0 && scores.incorrect === 0) {
        stats.perfectWeeks++;
        hof.records.perfectWeeks.push({
          userId,
          week: parseInt(week),
          points: scores.points,
        });
      }

      // Track best week
      if (scores.points > stats.bestWeek.points) {
        stats.bestWeek = { week: parseInt(week), points: scores.points };
      }
    });
  });

  // Find records
  let highestWinPct = { userId: null, percentage: 0, wins: 0, total: 0 };
  let mostWins = { userId: null, wins: 0 };
  let longestStreak = { userId: null, streak: 0 };
  let mostPointsWeek = { userId: null, week: null, points: 0 };
  let mostPointsSeason = { userId: null, points: 0 };
  let mostConsecutivePicks = { userId: null, picks: 0 };

  Object.entries(userStats).forEach(([userId, stats]) => {
    // Win percentage
    if (stats.totalPicks > 0) {
      const pct = (stats.totalWins / stats.totalPicks) * 100;
      if (pct > highestWinPct.percentage || (pct === highestWinPct.percentage && stats.totalPicks > highestWinPct.total)) {
        highestWinPct = {
          userId,
          percentage: pct,
          wins: stats.totalWins,
          total: stats.totalPicks,
        };
      }
    }

    // Most wins
    if (stats.totalWins > mostWins.wins) {
      mostWins = { userId, wins: stats.totalWins };
    }

    // Longest streak
    if (stats.longestStreak > longestStreak.streak) {
      longestStreak = { userId, streak: stats.longestStreak };
    }

    // Most points in a week
    if (stats.bestWeek.points > mostPointsWeek.points) {
      mostPointsWeek = {
        userId,
        week: stats.bestWeek.week,
        points: stats.bestWeek.points,
      };
    }

    // Most points in season
    if (stats.totalPoints > mostPointsSeason.points) {
      mostPointsSeason = { userId, points: stats.totalPoints };
    }

    // Iron Man (most consecutive picks)
    if (stats.consecutivePicks > mostConsecutivePicks.picks) {
      mostConsecutivePicks = { userId, picks: stats.consecutivePicks };
    }

    // Centurion achievement (100+ wins)
    if (stats.totalWins >= 100) {
      hof.achievements.centurion.push({
        userId,
        wins: stats.totalWins,
        date: new Date().toISOString(),
      });
    }
  });

  // Set records
  if (highestWinPct.userId) hof.records.highestWinPercentage = highestWinPct;
  if (mostWins.userId) hof.records.mostWinsInSeason = mostWins;
  if (longestStreak.userId) hof.records.longestWinStreak = longestStreak;
  if (mostPointsWeek.userId) hof.records.mostPointsInWeek = mostPointsWeek;
  if (mostPointsSeason.userId) hof.records.mostPointsInSeason = mostPointsSeason;
  if (mostConsecutivePicks.userId) hof.records.ironMan = mostConsecutivePicks;

  return hof;
};

/**
 * Check if a pick was correct
 */
const checkPickCorrect = (pick, result) => {
  if (!pick || !result) return false;

  if (pick.pickType === 'spread') {
    return pick.team === result.spreadWinner;
  } else if (pick.pickType === 'total') {
    return pick.pick === result.totalResult;
  } else if (pick.pickType === 'both') {
    const spreadCorrect = pick.team === result.spreadWinner;
    const totalCorrect = pick.totalPick === result.totalResult;
    return spreadCorrect && totalCorrect;
  }
  
  return false;
};

/**
 * Add a season champion to Hall of Fame
 */
export const addChampion = async (leagueCode, championData) => {
  try {
    const hof = await getHallOfFame(leagueCode);
    
    hof.champions.push({
      userId: championData.userId,
      season: championData.season || new Date().getFullYear(),
      wins: championData.wins,
      losses: championData.losses,
      winPercentage: championData.winPercentage,
      totalPoints: championData.totalPoints,
      date: new Date().toISOString(),
    });

    await saveHallOfFame(leagueCode, hof);
    return true;
  } catch (error) {
    console.warn('Failed to add champion:', error);
    return false;
  }
};

/**
 * Add a milestone achievement
 */
export const addMilestone = async (leagueCode, milestone) => {
  try {
    const hof = await getHallOfFame(leagueCode);
    
    hof.milestones.push({
      ...milestone,
      date: new Date().toISOString(),
    });

    await saveHallOfFame(leagueCode, hof);
    return true;
  } catch (error) {
    console.warn('Failed to add milestone:', error);
    return false;
  }
};

/**
 * Get display name for a record type
 */
export const getRecordDisplayName = (recordType) => {
  const names = {
    highestWinPercentage: 'Highest Win %',
    mostWinsInSeason: 'Most Wins',
    longestWinStreak: 'Longest Win Streak',
    mostPointsInWeek: 'Most Points (Week)',
    mostPointsInSeason: 'Most Points (Season)',
    ironMan: 'Iron Man (Consecutive Picks)',
  };
  return names[recordType] || recordType;
};
