import { supabase } from './supabaseClient';

// Save a pick for a user/game/league (confidence removed)
export async function savePick({ league_code, user_id, game_id, week, spread, total, winner }) {
  const { data, error } = await supabase
    .from('picks')
    .upsert([{ league_code, user_id, game_id, week, spread, total, winner }], { onConflict: ['league_code', 'user_id', 'game_id'] })
    .select('*')
    .single();
  return { data, error };
}

// Get all picks for a league and week
export async function getPicksForLeagueWeek(league_code, week) {
  const { data, error } = await supabase
    .from('picks')
    .select('*')
    .eq('league_code', league_code)
    .eq('week', week);
  return { data, error };
}

// Get all picks for a user
export async function getPicksForUser(user_id) {
  const { data, error } = await supabase
    .from('picks')
    .select('*')
    .eq('user_id', user_id);
  return { data, error };
}

// Get all picks for a league (all users)
export async function getPicksForLeague(league_code) {
  const { data, error } = await supabase
    .from('picks')
    .select('*')
    .eq('league_code', league_code);
  return { data, error };
}
