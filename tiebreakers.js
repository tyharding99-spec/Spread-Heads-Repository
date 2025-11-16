/**
 * Tiebreaker logic for league standings
 * Supports multiple tiebreaker methods that commissioners can choose
 */

import { computeUserStats } from './stats';

/**
 * Apply tiebreaker rules to sort players
 * @param {Array} players - Array of player objects with stats
 * @param {string} tiebreakerRule - The tiebreaker method to use
 * @param {Object} league - The league object (for head-to-head calculations)
 * @param {Object} results - Game results for advanced calculations
 * @returns {Array} - Sorted array of players
 */
export const applyTiebreaker = (players, tiebreakerRule = 'totalPoints', league = null, results = null) => {
  // First sort by wins/win percentage (primary sort)
  const sorted = [...players].sort((a, b) => {
    const wp = parseFloat(b.winPercentage) - parseFloat(a.winPercentage);
    if (wp !== 0) return wp;
    
    // If win percentages are equal, apply tiebreaker
    return applyTiebreakerRule(a, b, tiebreakerRule, league, results);
  });

  return sorted;
};

/**
 * Apply specific tiebreaker rule between two players
 */
const applyTiebreakerRule = (a, b, rule, league, results) => {
  switch (rule) {
    case 'totalPoints':
      // Most total points wins
      return (b.points || 0) - (a.points || 0);

    case 'winPercentage':
      // Already handled in primary sort, fall back to total wins
      if (b.wins !== a.wins) return b.wins - a.wins;
      return (b.totalPicks || 0) - (a.totalPicks || 0);

    case 'headToHead':
      // Best record vs tied players (if league data available)
      if (league && league.picks) {
        const h2h = calculateHeadToHead(a.userId, b.userId, league, results);
        if (h2h !== 0) return h2h;
      }
      // Fall back to total points
      return (b.points || 0) - (a.points || 0);

    case 'bestWeek':
      // Highest single week score
      const bestWeekA = getBestWeekScore(a.userId, league, results);
      const bestWeekB = getBestWeekScore(b.userId, league, results);
      if (bestWeekB !== bestWeekA) return bestWeekB - bestWeekA;
      // Fall back to total points
      return (b.points || 0) - (a.points || 0);

    case 'fewestMissed':
      // Least missed picks wins
      const missedA = (a.totalPicks || 0) - (a.wins || 0) - (a.losses || 0) - (a.pushes || 0);
      const missedB = (b.totalPicks || 0) - (b.wins || 0) - (b.losses || 0) - (b.pushes || 0);
      if (missedA !== missedB) return missedA - missedB;
      // Fall back to total points
      return (b.points || 0) - (a.points || 0);

    case 'mostRecentWin':
      // Who won most recently
      const lastWinA = getMostRecentWin(a.userId, league, results);
      const lastWinB = getMostRecentWin(b.userId, league, results);
      if (lastWinA && lastWinB) {
        // More recent date = higher timestamp
        return lastWinB - lastWinA;
      }
      if (lastWinA) return -1; // A has a win, B doesn't
      if (lastWinB) return 1; // B has a win, A doesn't
      // Fall back to total points
      return (b.points || 0) - (a.points || 0);

    default:
      // Default: total points
      return (b.points || 0) - (a.points || 0);
  }
};

/**
 * Calculate head-to-head record between two players
 * Returns: positive if B wins, negative if A wins, 0 if tied
 */
const calculateHeadToHead = (userA, userB, league, results) => {
  if (!league?.picks || !results) return 0;

  const picksA = league.picks[userA] || {};
  const picksB = league.picks[userB] || {};

  let aWins = 0;
  let bWins = 0;

  // Compare each game where both players made a pick
  Object.keys(picksA).forEach(gameId => {
    if (!picksB[gameId]) return; // Only count games where both picked

    const pickA = picksA[gameId];
    const pickB = picksB[gameId];
    const result = results[gameId];

    if (!result || result.status !== 'completed') return;

    // Determine if each player won their pick
    const aCorrect = isPickCorrect(pickA, result);
    const bCorrect = isPickCorrect(pickB, result);

    if (aCorrect && !bCorrect) aWins++;
    if (bCorrect && !aCorrect) bWins++;
  });

  return bWins - aWins;
};

/**
 * Check if a pick was correct based on the result
 */
const isPickCorrect = (pick, result) => {
  if (!pick || !result) return false;

  if (pick.pickType === 'spread') {
    return pick.team === result.spreadWinner;
  } else if (pick.pickType === 'total') {
    return pick.pick === result.totalResult;
  }
  return false;
};

/**
 * Get the best single week score for a user
 */
const getBestWeekScore = (userId, league, results) => {
  if (!league?.picks || !results) return 0;

  const picks = league.picks[userId] || {};
  const weekScores = {};

  // Group picks by week and calculate scores
  Object.entries(picks).forEach(([gameId, pick]) => {
    const result = results[gameId];
    if (!result || result.status !== 'completed') return;

    const week = result.week || 1;
    if (!weekScores[week]) weekScores[week] = 0;

    if (isPickCorrect(pick, result)) {
      // Add confidence points if applicable
      const points = pick.confidence || 1;
      weekScores[week] += points;
    }
  });

  // Return the highest week score
  return Math.max(...Object.values(weekScores), 0);
};

/**
 * Get the timestamp of the most recent win for a user
 */
const getMostRecentWin = (userId, league, results) => {
  if (!league?.picks || !results) return null;

  const picks = league.picks[userId] || {};
  let mostRecent = null;

  Object.entries(picks).forEach(([gameId, pick]) => {
    const result = results[gameId];
    if (!result || result.status !== 'completed') return;

    if (isPickCorrect(pick, result)) {
      const gameTime = result.gameTime ? new Date(result.gameTime).getTime() : 0;
      if (!mostRecent || gameTime > mostRecent) {
        mostRecent = gameTime;
      }
    }
  });

  return mostRecent;
};

/**
 * Get tiebreaker display name for UI
 */
export const getTiebreakerDisplayName = (rule) => {
  const names = {
    totalPoints: 'Total Points',
    winPercentage: 'Win Percentage',
    headToHead: 'Head-to-Head Record',
    bestWeek: 'Best Single Week',
    fewestMissed: 'Fewest Missed Picks',
    mostRecentWin: 'Most Recent Win',
  };
  return names[rule] || 'Total Points';
};

/**
 * Get tiebreaker description for UI
 */
export const getTiebreakerDescription = (rule) => {
  const descriptions = {
    totalPoints: 'Ties broken by most total points scored',
    winPercentage: 'Ties broken by highest win percentage, then total wins',
    headToHead: 'Ties broken by record in games where both players made picks',
    bestWeek: 'Ties broken by highest single week score',
    fewestMissed: 'Ties broken by fewest missed picks',
    mostRecentWin: 'Ties broken by who won most recently',
  };
  return descriptions[rule] || 'Ties broken by most total points scored';
};
