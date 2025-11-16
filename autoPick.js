/**
 * Auto-Pick Logic
 * Automatically makes picks for users based on their preferences
 */

import { getAutoPickPrefs, AUTO_PICK_STRATEGIES } from './autoPickPrefs';
import { scheduleLocalNotification } from './notifications';

/**
 * Determine auto-pick for a spread pick
 */
const getAutoSpreadPick = (game, strategy, teamRecords = {}) => {
  const { homeTeam, awayTeam, spread } = game;
  
  switch (strategy) {
    case AUTO_PICK_STRATEGIES.HOME_TEAMS:
      return homeTeam;
      
    case AUTO_PICK_STRATEGIES.AWAY_TEAMS:
      return awayTeam;
      
    case AUTO_PICK_STRATEGIES.SPREAD_FAVORITE:
      // Favorite is the team with negative spread (or smaller number)
      return spread < 0 ? homeTeam : awayTeam;
      
    case AUTO_PICK_STRATEGIES.SPREAD_UNDERDOG:
      // Underdog is the team with positive spread (or larger number)
      return spread > 0 ? homeTeam : awayTeam;
      
    case AUTO_PICK_STRATEGIES.FAVORITES:
      // Pick team with better record
      const homeRecord = teamRecords[homeTeam];
      const awayRecord = teamRecords[awayTeam];
      
      if (homeRecord && awayRecord) {
        const homeWinPct = homeRecord.wins / (homeRecord.wins + homeRecord.losses || 1);
        const awayWinPct = awayRecord.wins / (awayRecord.wins + awayRecord.losses || 1);
        
        if (homeWinPct > awayWinPct) return homeTeam;
        if (awayWinPct > homeWinPct) return awayTeam;
      }
      
      // Fall back to spread favorite if no record data
      return spread < 0 ? homeTeam : awayTeam;
      
    case AUTO_PICK_STRATEGIES.RANDOM:
      return Math.random() < 0.5 ? homeTeam : awayTeam;
      
    default:
      // Default to favorites
      return spread < 0 ? homeTeam : awayTeam;
  }
};

/**
 * Determine auto-pick for a total pick
 */
const getAutoTotalPick = (game, strategy) => {
  switch (strategy) {
    case AUTO_PICK_STRATEGIES.OVER:
      return 'over';
      
    case AUTO_PICK_STRATEGIES.UNDER:
      return 'under';
      
    case AUTO_PICK_STRATEGIES.RANDOM:
      return Math.random() < 0.5 ? 'over' : 'under';
      
    default:
      return 'over';
  }
};

/**
 * Check if a game's line has locked
 */
const isLineLocked = (game, lockOffsetMinutes = 60) => {
  if (!game.gameTime) return false;
  
  const gameTime = new Date(game.gameTime).getTime();
  const lockTime = gameTime - (lockOffsetMinutes * 60 * 1000);
  const now = Date.now();
  
  return now >= lockTime;
};

/**
 * Process auto-picks for a user across all their leagues
 * @param {string} userId - The user's ID
 * @param {Array} leagues - All leagues the user is in
 * @param {Object} games - Available games to pick from
 * @param {Object} teamRecords - Team win-loss records for favorites strategy
 * @returns {Object} - { picksAdded: number, leaguesAffected: Array }
 */
export const processAutoPicks = async (userId, leagues, games, teamRecords = {}) => {
  try {
    const prefs = await getAutoPickPrefs();
    
    // Check if auto-pick is enabled
    if (!prefs.enabled) {
      return { picksAdded: 0, leaguesAffected: [] };
    }
    
    let totalPicksAdded = 0;
    const leaguesAffected = [];
    const updatedLeagues = [];
    
    // Process each league the user is in
    for (const league of leagues) {
      // Skip if user is not a member
      if (!league.members?.includes(userId)) continue;
      
      // Skip if league is excluded from auto-pick
      if (prefs.excludedLeagues?.includes(league.code)) continue;
      
      const lockOffsetMinutes = league.settings?.lockOffsetMinutes || 60;
      const userPicks = league.picks?.[userId] || {};
      let picksAddedThisLeague = 0;
      
      // Check each available game
      for (const [gameId, game] of Object.entries(games)) {
        // Skip if game status is not upcoming
        if (game.status !== 'upcoming') continue;
        
        // Skip if line hasn't locked yet
        if (!isLineLocked(game, lockOffsetMinutes)) continue;
        
        // Skip if user already has a pick for this game (if onlyWhenMissing is true)
        if (prefs.onlyWhenMissing && userPicks[gameId]) continue;
        
        // Determine league type for pick requirements
        const leagueType = league.type || 'freeForAll';
        const requiresBothPicks = leagueType === 'moneylineMania' || leagueType === 'individual';
        
        // Make auto-picks based on strategy
        const autoPick = {
          gameId,
          timestamp: Date.now(),
          isAutoPick: true, // Flag to indicate this was auto-generated
        };
        
        // Spread pick
        if (game.spread !== undefined && game.spread !== null) {
          autoPick.pickType = 'spread';
          autoPick.team = getAutoSpreadPick(game, prefs.spreadStrategy, teamRecords);
          autoPick.spread = game.spread;
        }
        
        // Total pick (if league requires both picks)
        if (requiresBothPicks && game.total !== undefined && game.total !== null) {
          // If we need both picks, create a separate total pick
          const totalPick = {
            gameId,
            pickType: 'total',
            pick: getAutoTotalPick(game, prefs.totalStrategy),
            total: game.total,
            timestamp: Date.now(),
            isAutoPick: true,
          };
          
          // For moneyline mania, we need both in the same pick object
          if (leagueType === 'moneylineMania') {
            autoPick.pickType = 'both';
            autoPick.totalPick = totalPick.pick;
            autoPick.total = totalPick.total;
          }
        }
        
        // Add the pick to the league
        if (!league.picks) league.picks = {};
        if (!league.picks[userId]) league.picks[userId] = {};
        
        league.picks[userId][gameId] = autoPick;
        picksAddedThisLeague++;
        totalPicksAdded++;
      }
      
      if (picksAddedThisLeague > 0) {
        leaguesAffected.push({
          code: league.code,
          name: league.name,
          picksAdded: picksAddedThisLeague,
        });
        updatedLeagues.push(league);
      }
    }
    
    // Send notification if picks were made and user wants notifications
    if (totalPicksAdded > 0 && prefs.notifyOnAutoPick) {
      await scheduleLocalNotification({
        title: '🤖 Auto-Picks Made',
        body: `${totalPicksAdded} pick${totalPicksAdded !== 1 ? 's' : ''} automatically made across ${leaguesAffected.length} league${leaguesAffected.length !== 1 ? 's' : ''}`,
        data: { type: 'autoPick', count: totalPicksAdded, leagues: leaguesAffected },
      });
    }
    
    return {
      picksAdded: totalPicksAdded,
      leaguesAffected,
      updatedLeagues,
    };
  } catch (error) {
    console.warn('Auto-pick processing failed:', error);
    return { picksAdded: 0, leaguesAffected: [], error: error.message };
  }
};

/**
 * Check if auto-picks should be processed now
 * This can be called periodically or when the app opens
 */
export const shouldProcessAutoPicks = async () => {
  const prefs = await getAutoPickPrefs();
  return prefs.enabled;
};
