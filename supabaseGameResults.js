import { supabase } from './supabaseClient';

/**
 * Populate game_results for specific final games from parsed scoreboard data
 * Called automatically when app detects games are final
 * @param {Array} finalGames - Array of parsed game objects with isFinal=true
 * @param {number} week - NFL week number
 * @param {number} season - Season year (default 2025)
 * @returns {Promise<{inserted: number, errors: Array}>}
 */
export async function populateFinalGames(finalGames, week, season = 2025) {
  if (!finalGames || finalGames.length === 0) {
    return { inserted: 0, errors: [] };
  }
  
  console.log(`[GameResults] Processing ${finalGames.length} final games for week ${week}`);
  
  let inserted = 0;
  const errors = [];
  
  for (const game of finalGames) {
    try {
      const homeScore = game.homeScore;
      const awayScore = game.awayScore;
      
      // Winner is stored as abbreviation for consistency
      const winner = homeScore > awayScore 
        ? game.homeAbbr
        : awayScore > homeScore 
          ? game.awayAbbr
          : 'TIE';
      
      // Upsert into game_results
      const gameResult = {
        game_id: game.id,
        week,
        season,
        home_team: game.homeAbbr,
        away_team: game.awayAbbr,
        home_score: homeScore,
        away_score: awayScore,
        winner,
        // We no longer compute outcomes globally, but we DO persist raw numeric lines
        // so server scoring can fallback if league locked_lines are missing.
        spread_result: null,
        spread_line: typeof game.homeSpreadNum === 'number' ? game.homeSpreadNum : null,
        total_result: null,
        total_line: typeof game.overUnderNum === 'number' ? game.overUnderNum : null,
        is_final: true,
      };
      
      const { error } = await supabase
        .from('game_results')
        .upsert(gameResult, { onConflict: 'game_id' });
      
      if (error) {
        console.error(`[GameResults] Error upserting game ${game.id}:`, error);
        errors.push({ gameId: game.id, error: error.message });
      } else {
        console.log(`[GameResults] ✓ ${game.awayAbbr} ${awayScore} @ ${game.homeAbbr} ${homeScore}`);
        inserted++;
      }
    } catch (gameErr) {
      console.error(`[GameResults] Error processing game ${game.id}:`, gameErr);
      errors.push({ gameId: game.id, error: gameErr.message });
    }
  }
  
  console.log(`[GameResults] Saved ${inserted}/${finalGames.length} games, ${errors.length} errors`);
  
  return { inserted, errors };
}

/**
 * Populate game_results table from ESPN scoreboard API for a given week
 * This should be called after games finish (manually or via cron/edge function)
 * @param {number} week - NFL week number
 * @param {number} season - Season year (default 2025)
 * @returns {Promise<{inserted: number, updated: number, errors: Array}>}
 */
export async function populateGameResults(week, season = 2025) {
  console.log(`[GameResults] Fetching final scores for week ${week}, season ${season}...`);
  
  try {
    // Fetch games from ESPN for the week
    const espnRes = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}`,
      { 
        headers: { 'Accept': 'application/json' },
        timeout: 10000
      }
    );
    
    if (!espnRes.ok) {
      throw new Error(`ESPN API error: ${espnRes.status}`);
    }
    
    const espnData = await espnRes.json();
    
    if (!espnData || !espnData.events) {
      throw new Error('Invalid data from ESPN API');
    }
    
    let inserted = 0;
    let updated = 0;
    const errors = [];
    
    for (const event of espnData.events) {
      try {
        const comp = event.competitions[0];
        const away = comp.competitors.find(c => c.homeAway === "away") || comp.competitors[0];
        const home = comp.competitors.find(c => c.homeAway === "home") || comp.competitors[1];
        
        // Only process completed games
        const status = comp.status?.type?.name;
        if (status !== 'STATUS_FINAL' && status !== 'STATUS_FULL_TIME') {
          console.log(`[GameResults] Skipping game ${event.id}: not final (${status})`);
          continue;
        }
        
        const homeScore = parseInt(home.score || 0);
        const awayScore = parseInt(away.score || 0);
        const winner = homeScore > awayScore 
          ? (home.team.abbreviation || home.team.displayName)
          : awayScore > homeScore 
            ? (away.team.abbreviation || away.team.displayName)
            : 'TIE';
        
        // Upsert into game_results
        const gameResult = {
          game_id: event.id,
          week,
          season,
          home_team: home.team.abbreviation || home.team.displayName,
          away_team: away.team.abbreviation || away.team.displayName,
          home_score: homeScore,
          away_score: awayScore,
          winner,
          // Persist raw numeric lines (from odds if available) for fallback only
          spread_result: null,
          spread_line: (comp.odds?.[0]?.spread !== undefined ? parseFloat(comp.odds[0].spread) : null) ?? null,
          total_result: null,
          total_line: (comp.odds?.[0]?.overUnder !== undefined ? parseFloat(comp.odds[0].overUnder) : null) ?? null,
          is_final: true,
        };
        
        const { data, error } = await supabase
          .from('game_results')
          .upsert(gameResult, { onConflict: 'game_id' });
        
        if (error) {
          console.error(`[GameResults] Error upserting game ${event.id}:`, error);
          errors.push({ gameId: event.id, error: error.message });
        } else {
          // Check if insert or update (Supabase doesn't distinguish in response)
          console.log(`[GameResults] ✓ Saved game ${event.id}: ${away.team.abbreviation} ${awayScore} @ ${home.team.abbreviation} ${homeScore}`);
          inserted++; // We'll count all as inserts for simplicity
        }
      } catch (gameErr) {
        console.error(`[GameResults] Error processing game ${event.id}:`, gameErr);
        errors.push({ gameId: event.id, error: gameErr.message });
      }
    }
    
    console.log(`[GameResults] Complete: ${inserted} games saved, ${errors.length} errors`);
    
    return { inserted, updated, errors };
  } catch (error) {
    console.error('[GameResults] Fatal error:', error);
    throw error;
  }
}

/**
 * Check if game results exist for a week
 * @param {number} week
 * @param {number} season
 * @returns {Promise<{count: number, finalized: number}>}
 */
export async function checkGameResults(week, season = 2025) {
  const { data, error } = await supabase
    .from('game_results')
    .select('game_id, is_final')
    .eq('week', week)
    .eq('season', season);
  
  if (error) {
    console.error('[GameResults] Error checking results:', error);
    return { count: 0, finalized: 0 };
  }
  
  const finalized = data.filter(r => r.is_final).length;
  
  return { count: data.length, finalized };
}

/**
 * Manual trigger to populate results for current week
 * Call this from a debug menu or after games finish
 */
export async function populateCurrentWeek() {
  const now = new Date();
  const seasonStart2025 = new Date('2025-09-04T00:00:00');
  const diffTime = now - seasonStart2025;
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  const week = now >= seasonStart2025 ? Math.max(1, Math.min(18, Math.floor(diffDays / 7) + 1)) : 1;
  
  console.log(`[GameResults] Auto-detecting current week: ${week}`);
  
  return await populateGameResults(week);
}
