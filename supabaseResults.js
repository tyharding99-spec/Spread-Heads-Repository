import { supabase } from './supabaseClient';

// ============================================================================
// SUPABASE RESULTS & SCORING MODULE
// Client helper functions for server-side scoring system
// ============================================================================

/**
 * Fetch weekly points for a league from cached server results
 * Returns computed scores if available, otherwise returns null (client should fallback)
 * @param {string} leagueCode - League code
 * @param {number} week - Week number
 * @param {number} season - Season year (default 2025)
 * @returns {Promise<{data: Array, error: any}>}
 */
export async function fetchWeeklyPoints(leagueCode, week, season = 2025) {
  const { data, error } = await supabase
    .from('weekly_points')
    .select('*')
    .eq('league_code', leagueCode)
    .eq('week', week)
    .eq('season', season)
    .order('total_points', { ascending: false });
  
  return { data, error };
}

/**
 * Fetch weekly leaderboard using RPC function (includes user profile data)
 * @param {string} leagueCode - League code
 * @param {number} week - Week number
 * @param {number} season - Season year (default 2025)
 * @returns {Promise<{data: Array, error: any}>}
 */
export async function fetchWeeklyLeaderboard(leagueCode, week, season = 2025) {
  const { data, error } = await supabase.rpc('get_weekly_leaderboard', {
    p_league_code: leagueCode,
    p_week: week,
    p_season: season,
  });
  
  return { data, error };
}

/**
 * Fetch a single user's weekly points
 * @param {string} leagueCode - League code
 * @param {string} userId - User ID
 * @param {number} week - Week number
 * @param {number} season - Season year (default 2025)
 * @returns {Promise<{data: object, error: any}>}
 */
export async function fetchUserWeeklyPoints(leagueCode, userId, week, season = 2025) {
  const { data, error } = await supabase
    .from('weekly_points')
    .select('*')
    .eq('league_code', leagueCode)
    .eq('user_id', userId)
    .eq('week', week)
    .eq('season', season)
    .single();
  
  return { data, error };
}

/**
 * Trigger recomputation of weekly points for a league
 * Calls the server-side compute function via RPC
 * @param {string} leagueCode - League code
 * @param {number} week - Week number
 * @param {number} season - Season year (default 2025)
 * @returns {Promise<{data: number, error: any}>} - Returns count of users computed
 */
export async function recomputeWeeklyPoints(leagueCode, week, season = 2025) {
  const { data, error } = await supabase.rpc('compute_weekly_points', {
    p_league_code: leagueCode,
    p_week: week,
    p_season: season,
  });
  
  return { data, error };
}

/**
 * Fetch game results for a specific week
 * @param {number} week - Week number
 * @param {number} season - Season year (default 2025)
 * @returns {Promise<{data: Array, error: any}>}
 */
export async function fetchGameResults(week, season = 2025) {
  const { data, error } = await supabase
    .from('game_results')
    .select('*')
    .eq('week', week)
    .eq('season', season)
    .eq('is_final', true);
  
  return { data, error };
}

/**
 * Fetch a single game result
 * @param {string} gameId - ESPN game ID
 * @returns {Promise<{data: object, error: any}>}
 */
export async function fetchGameResult(gameId) {
  const { data, error } = await supabase
    .from('game_results')
    .select('*')
    .eq('game_id', gameId)
    .eq('is_final', true)
    .single();
  
  return { data, error };
}

/**
 * Fetch user's stats for current week across all their leagues
 * @param {string} userId - User ID
 * @param {number} week - Week number
 * @param {number} season - Season year (default 2025)
 * @returns {Promise<{winPercentage: number, overallWins: number, overallLosses: number}>}
 */
export async function fetchUserWeeklyStats(userId, week, season = 2025) {
  const { data, error } = await supabase
    .from('weekly_points')
    .select('spread_correct, spread_incorrect, total_correct, total_incorrect, winner_correct, winner_incorrect')
    .eq('user_id', userId)
    .eq('week', week)
    .eq('season', season);
  
  if (error || !data || data.length === 0) {
    return { winPercentage: 0, overallWins: 0, overallLosses: 0 };
  }
  
  // Aggregate across all leagues
  let totalWins = 0;
  let totalLosses = 0;
  
  data.forEach(row => {
    totalWins += (row.spread_correct || 0) + (row.total_correct || 0) + (row.winner_correct || 0);
    totalLosses += (row.spread_incorrect || 0) + (row.total_incorrect || 0) + (row.winner_incorrect || 0);
  });
  
  const totalPicks = totalWins + totalLosses;
  const winPercentage = totalPicks > 0 ? Math.round((totalWins / totalPicks) * 100) : 0;
  
  return {
    winPercentage,
    overallWins: totalWins,
    overallLosses: totalLosses,
  };
}

/**
 * Check if weekly points are available (cached) for a league/week
 * @param {string} leagueCode - League code
 * @param {number} week - Week number
 * @param {number} season - Season year (default 2025)
 * @returns {Promise<boolean>} - True if cached data exists and is complete
 */
export async function hasWeeklyPointsCache(leagueCode, week, season = 2025) {
  const { data, error } = await supabase
    .from('weekly_points')
    .select('id, is_complete')
    .eq('league_code', leagueCode)
    .eq('week', week)
    .eq('season', season)
    .limit(1);
  
  if (error || !data || data.length === 0) return false;
  
  // Check if at least one record exists (indicates computation has run)
  return true;
}

/**
 * CLIENT-SIDE FALLBACK: Compute weekly points locally if server cache unavailable
 * This mirrors the server logic but runs in JS for backward compatibility
 * @param {object} league - League object with settings
 * @param {array} picks - Array of pick objects for the league/week
 * @param {array} results - Array of game result objects
 * @param {string} userId - User ID to compute for
 * @returns {object} - Computed weekly points object
 */
export function computeWeeklyPointsClientSide(league, picks, results, userId) {
  const userPicks = picks.filter(p => p.user_id === userId);
  const scoringWeights = league.settings?.scoring || { winner: 1, spread: 1, total: 1 };
  
  let totalPoints = 0;
  let winnerCorrect = 0;
  let winnerIncorrect = 0;
  let spreadCorrect = 0;
  let spreadIncorrect = 0;
  let spreadPush = 0;
  let totalCorrect = 0;
  let totalIncorrect = 0;
  let totalPush = 0;
  let gamesPicked = userPicks.length;
  let gamesGraded = 0;
  const locked = league.locked_lines || {};

  const parseSpread = (spreadStr, homeTeam, awayTeam) => {
    if (!spreadStr || spreadStr === 'N/A') return null;
    const teamMatch = spreadStr.match(/^([A-Z]{2,4})\s*([-+]?\d+(?:\.\d+)?)/);
    const numMatch = spreadStr.match(/([-+]?\d+(?:\.\d+)?)/);
    let line = null; let favSide = null;
    if (teamMatch) {
      const teamAbbr = teamMatch[1];
      const signedPart = teamMatch[2];
      line = Math.abs(parseFloat(signedPart));
      if (signedPart.startsWith('-')) {
        // team token is favorite
        if (teamAbbr === homeTeam) favSide = 'home';
        else if (teamAbbr === awayTeam) favSide = 'away';
      } else if (signedPart.startsWith('+')) {
        // team token is underdog; favorite is the opposite side
        if (teamAbbr === homeTeam) favSide = 'away';
        else if (teamAbbr === awayTeam) favSide = 'home';
      } else {
        // no explicit sign; assume token is favorite
        if (teamAbbr === homeTeam) favSide = 'home';
        else if (teamAbbr === awayTeam) favSide = 'away';
      }
    } else if (numMatch) {
      line = Math.abs(parseFloat(numMatch[1]));
      // Infer favorite by sign if present; assume home if negative, else away
      if (spreadStr.trim().startsWith('-')) favSide = 'home';
      else if (spreadStr.trim().startsWith('+')) favSide = 'away';
    }
    if (line == null || favSide == null) return null;
    return { line, favSide };
  };

  const parseTotal = (ouStr) => {
    if (!ouStr || ouStr === 'N/A') return null;
    const m = ouStr.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  };

  userPicks.forEach(pick => {
    const result = results.find(r => String(r.game_id) === String(pick.game_id) && r.is_final);
    if (!result) return; // Not final yet
    gamesGraded++;

    // Winner grading
    if (pick.winner) {
      if (pick.winner === result.winner) {
        winnerCorrect++;
        totalPoints += scoringWeights.winner;
      } else if (result.winner !== 'TIE') {
        winnerIncorrect++;
      }
    }

    // Spread grading via locked_lines
    if (pick.spread) {
      const lockedLineObj = locked[pick.game_id];
      const spreadStr = lockedLineObj?.spread;
      let parsed = parseSpread(spreadStr, result.home_team, result.away_team);
      // Fallback to numeric home-based line from result if no locked spread
      if (!parsed && typeof result.spread_line === 'number') {
        const sp = result.spread_line;
        parsed = { line: Math.abs(sp), favSide: sp < 0 ? 'home' : 'away' };
      }
      const pickedAbbr = (pick.spread.match(/^[A-Za-z]{2,4}/) || [pick.spread])[0];
      if (!parsed) {
        // Can't grade yet; treat as ungraded (do not increment incorrect)
        return;
      }
      const margin = result.home_score - result.away_score;
      const homeLineSigned = parsed.favSide === 'home' ? -parsed.line : parsed.line;
      const adjusted = margin + homeLineSigned;
      if (Math.abs(adjusted) < 0.0001) {
        spreadPush++;
      } else if (adjusted > 0) {
        // Home covered
        if (pickedAbbr === result.home_team) {
          spreadCorrect++; totalPoints += scoringWeights.spread;
        } else { spreadIncorrect++; }
      } else {
        // Away covered
        if (pickedAbbr === result.away_team) {
          spreadCorrect++; totalPoints += scoringWeights.spread;
        } else { spreadIncorrect++; }
      }
    }

    // Total grading via locked_lines
    if (pick.total) {
      const lockedLineObj = locked[pick.game_id];
      const ouStr = lockedLineObj?.overUnder;
      let lineTotal = parseTotal(ouStr);
      if (lineTotal == null && typeof result.total_line === 'number') {
        lineTotal = result.total_line;
      }
      if (lineTotal == null) {
        return; // cannot grade yet
      }
      const totPoints = result.home_score + result.away_score;
      const pickedDir = pick.total.toLowerCase().startsWith('o') ? 'over' : pick.total.toLowerCase().startsWith('u') ? 'under' : pick.total.toLowerCase();
      if (Math.abs(totPoints - lineTotal) < 0.0001) {
        totalPush++;
      } else if ((totPoints > lineTotal && pickedDir === 'over') || (totPoints < lineTotal && pickedDir === 'under')) {
        totalCorrect++; totalPoints += scoringWeights.total;
      } else {
        totalIncorrect++;
      }
    }
  });

  return {
    user_id: userId,
    total_points: totalPoints,
    winner_correct: winnerCorrect,
    winner_incorrect: winnerIncorrect,
    spread_correct: spreadCorrect,
    spread_incorrect: spreadIncorrect,
    spread_push: spreadPush,
    total_correct: totalCorrect,
    total_incorrect: totalIncorrect,
    total_push: totalPush,
    games_picked: gamesPicked,
    games_graded: gamesGraded,
    is_complete: gamesGraded === gamesPicked,
    source: 'client-computed', // Mark as client-side computation
  };
}

// Detailed debug version: returns array of per-pick grading objects for inspection
export function computeWeeklyPointsClientSideDetailed(league, picks, results, userId) {
  const userPicks = picks.filter(p => p.user_id === userId);
  const scoringWeights = league.settings?.scoring || { winner: 1, spread: 1, total: 1 };
  const locked = league.locked_lines || {};

  const parseSpread = (spreadStr, homeTeam, awayTeam) => {
    if (!spreadStr || spreadStr === 'N/A') return null;
    const teamMatch = spreadStr.match(/^([A-Z]{2,4})\s*([-+]?\d+(?:\.\d+)?)/);
    const numMatch = spreadStr.match(/([-+]?\d+(?:\.\d+)?)/);
    let line = null; let favSide = null; let source = null; let raw = spreadStr;
    if (teamMatch) {
      const teamAbbr = teamMatch[1];
      const signedPart = teamMatch[2];
      line = Math.abs(parseFloat(signedPart));
      if (signedPart.startsWith('-')) {
        if (teamAbbr === homeTeam) favSide = 'home'; else if (teamAbbr === awayTeam) favSide = 'away';
      } else if (signedPart.startsWith('+')) {
        if (teamAbbr === homeTeam) favSide = 'away'; else if (teamAbbr === awayTeam) favSide = 'home';
      } else {
        if (teamAbbr === homeTeam) favSide = 'home'; else if (teamAbbr === awayTeam) favSide = 'away';
      }
      source = 'locked_lines';
    } else if (numMatch) {
      line = Math.abs(parseFloat(numMatch[1]));
      if (spreadStr.trim().startsWith('-')) favSide = 'home';
      else if (spreadStr.trim().startsWith('+')) favSide = 'away';
      source = 'locked_lines_numeric';
    }
    if (line == null || favSide == null) return null;
    return { line, favSide, source, raw };
  };

  const parseTotal = (ouStr) => {
    if (!ouStr || ouStr === 'N/A') return null;
    const m = ouStr.match(/(\d+(?:\.\d+)?)/);
    return m ? { line: parseFloat(m[1]), raw: ouStr } : null;
  };

  return userPicks.map(pick => {
    const result = results.find(r => String(r.game_id) === String(pick.game_id) && r.is_final);
    const lockedLineObj = locked[pick.game_id];
    const spreadStr = lockedLineObj?.spread;
    const totalStr = lockedLineObj?.overUnder;
    let spreadParsed = parseSpread(spreadStr, result?.home_team, result?.away_team);
    let totalParsed = parseTotal(totalStr);
    // Add numeric fallbacks from result when locked lines missing
    if (!spreadParsed && result && typeof result.spread_line === 'number') {
      const sp = result.spread_line;
      spreadParsed = { line: Math.abs(sp), favSide: sp < 0 ? 'home' : 'away', source: 'result_numeric', raw: String(sp) };
    }
    if (!totalParsed && result && typeof result.total_line === 'number') {
      totalParsed = { line: result.total_line, raw: String(result.total_line) };
    }
    const pickedAbbr = pick.spread ? (pick.spread.match(/^[A-Za-z]{2,4}/) || [pick.spread])[0] : null;
    const pickedTotalDir = pick.total ? (pick.total.toLowerCase().startsWith('o') ? 'over' : pick.total.toLowerCase().startsWith('u') ? 'under' : pick.total.toLowerCase()) : null;

    let spreadOutcome = 'ungraded';
    let spreadCorrect = null;
    let spreadAdjusted = null;
    if (result && spreadParsed) {
      const margin = result.home_score - result.away_score;
      const homeLineSigned = spreadParsed.favSide === 'home' ? -spreadParsed.line : spreadParsed.line;
      spreadAdjusted = margin + homeLineSigned;
      if (Math.abs(spreadAdjusted) < 0.0001) {
        spreadOutcome = 'push';
      } else if (spreadAdjusted > 0) {
        spreadOutcome = 'home_covered';
        spreadCorrect = pickedAbbr === result.home_team;
      } else {
        spreadOutcome = 'away_covered';
        spreadCorrect = pickedAbbr === result.away_team;
      }
    }

    let totalOutcome = 'ungraded';
    let totalCorrect = null;
    if (result && totalParsed) {
      const totPoints = result.home_score + result.away_score;
      if (Math.abs(totPoints - totalParsed.line) < 0.0001) {
        totalOutcome = 'push';
      } else if (totPoints > totalParsed.line) {
        totalOutcome = 'over';
        totalCorrect = pickedTotalDir === 'over';
      } else {
        totalOutcome = 'under';
        totalCorrect = pickedTotalDir === 'under';
      }
    }

    return {
      game_id: pick.game_id,
      pick_id: pick.id,
      winner_pick: pick.winner,
      spread_pick: pick.spread,
      total_pick: pick.total,
      locked_spread: spreadStr,
      locked_total: totalStr,
      spread_parsed: spreadParsed,
      total_parsed: totalParsed,
      spread_outcome: spreadOutcome,
      spread_correct: spreadCorrect,
      spread_adjusted: spreadAdjusted,
      total_outcome: totalOutcome,
      total_correct: totalCorrect,
      final_home: result?.home_team,
      final_away: result?.away_team,
      home_score: result?.home_score,
      away_score: result?.away_score,
    };
  });
}

/**
 * SMART FETCH: Get weekly points with automatic fallback
 * Tries server cache first, falls back to client-side computation if unavailable
 * @param {string} leagueCode - League code
 * @param {object} league - Full league object (for fallback)
 * @param {number} week - Week number
 * @param {array} allPicks - All picks for the league/week (for fallback)
 * @param {array} gameResults - All game results for the week (for fallback)
 * @param {number} season - Season year (default 2025)
 * @returns {Promise<{data: Array, source: string, error: any}>}
 */
export async function getWeeklyPointsWithFallback(leagueCode, league, week, allPicks, gameResults, season = 2025) {
  // Try server cache first
  const { data: cachedData, error: cacheError } = await fetchWeeklyPoints(leagueCode, week, season);
  
  if (!cacheError && cachedData && cachedData.length > 0) {
    return { data: cachedData, source: 'server-cached', error: null };
  }

  // Fallback: compute client-side
  console.log(`[Scoring] No server cache for ${leagueCode} week ${week}, computing client-side`);
  
  if (!league?.members || !allPicks || !gameResults) {
    return { data: [], source: 'unavailable', error: 'Missing data for fallback computation' };
  }

  const memberScores = league.members.map(member => 
    computeWeeklyPointsClientSide(league, allPicks, gameResults, member.userId || member)
  );

  return { data: memberScores, source: 'client-fallback', error: null };
}
