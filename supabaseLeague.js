import { supabase } from './supabaseClient';
import { normalizeLeagueSettings } from './leagueSettingsUtil';

// Create a new league in Supabase
export async function createLeague({ name, code, created_by, members, settings, description, type }) {
  // Normalize settings server-side to ensure canonical shape in DB
  const normalized = normalizeLeagueSettings(type, settings || {});
  const combinedSettings = { ...normalized, original: undefined, minPlayers: settings?.minPlayers, maxPlayers: settings?.maxPlayers, isActive: settings?.isActive };
  const { data, error } = await supabase
    .from('leagues')
    .insert([{ name, code, created_by, members, settings: combinedSettings, description, type }])
    .select('*')
    .single();
  return { data, error };
}

// Fetch all leagues for a user (where user is a member)
export async function getLeaguesForUser(userId) {
  const { data, error } = await supabase
    .from('leagues')
    .select('*')
    .contains('members', [userId]);
  if (data) {
    // Normalize settings for all returned leagues
    data.forEach(l => {
      if (l.settings) {
        l.settings = { ...normalizeLeagueSettings(l.type, l.settings) };
      }
    });
  }
  return { data, error };
}

// Add a user to a league's members array
export async function addUserToLeague(leagueCode, userId) {
  // Fetch current members
  const { data: league, error: fetchError } = await supabase
    .from('leagues')
    .select('members')
    .eq('code', leagueCode)
    .single();
  if (fetchError || !league) return { error: fetchError || 'League not found' };
  const updatedMembers = Array.from(new Set([...(league.members || []), userId]));
  const { data, error } = await supabase
    .from('leagues')
    .update({ members: updatedMembers })
    .eq('code', leagueCode)
    .select('*')
    .single();
  return { data, error };
}

// Fetch a single league by its code
export async function getLeagueByCode(code) {
  const normalizedCode = (code || '').toString().trim().toUpperCase();
  const { data, error } = await supabase
    .from('leagues')
    .select('*')
    .eq('code', normalizedCode)
    .single();
  if (data?.settings) {
    data.settings = { ...normalizeLeagueSettings(data.type, data.settings) };
  }
  return { data, error };
}

// Update league settings
export async function updateLeagueSettings(leagueCode, settings) {
  // Fetch league type to normalize correctly
  const { data: leagueRow } = await supabase
    .from('leagues')
    .select('type')
    .eq('code', leagueCode)
    .single();
  const type = leagueRow?.type || settings?.type || settings?.leagueType;
  const normalized = normalizeLeagueSettings(type, settings || {});
  const { data, error } = await supabase
    .from('leagues')
    .update({ settings: normalized })
    .eq('code', leagueCode)
    .select('*')
    .single();
  return { data, error };
}

// Rename a league
export async function renameLeague(leagueCode, newName) {
  const { data, error } = await supabase
    .from('leagues')
    .update({ name: newName })
    .eq('code', leagueCode)
    .select('*')
    .single();
  return { data, error };
}

// Remove a user from a league's members array
export async function removeUserFromLeague(leagueCode, userId) {
  // Fetch current members
  const { data: league, error: fetchError } = await supabase
    .from('leagues')
    .select('members')
    .eq('code', leagueCode)
    .single();
  if (fetchError || !league) return { error: fetchError || 'League not found' };
  
  const updatedMembers = (league.members || []).filter(id => id !== userId);
  
  const { data, error } = await supabase
    .from('leagues')
    .update({ members: updatedMembers })
    .eq('code', leagueCode)
    .select('*')
    .single();
  return { data, error };
}

// Delete a league
export async function deleteLeague(leagueCode) {
  const { data, error } = await supabase
    .from('leagues')
    .delete()
    .eq('code', leagueCode)
    .select('*')
    .single();
  return { data, error };
}

// Update locked lines for a league
export async function updateLeagueLockedLines(leagueCode, lockedLines) {
  const { data, error } = await supabase
    .from('leagues')
    .update({ locked_lines: lockedLines })
    .eq('code', leagueCode)
    .select('*')
    .single();
  return { data, error };
}

// Snapshot current ESPN lines for games that have passed their lock time
export async function snapshotLockedLines(league, games) {
  if (!league || !games || games.length === 0) return league;
  
  const now = new Date();
  const lineLockHours = league?.settings?.lineLockTime || 1;
  const currentLockedLines = league.locked_lines || {};
  let updated = false;

  games.forEach(game => {
    const gameTime = new Date(game.date);
    const lockTime = new Date(gameTime.getTime() - lineLockHours * 60 * 60 * 1000);
    
    // If lock time has passed and we haven't snapshotted yet
    if (now >= lockTime && !currentLockedLines[game.id]) {
      // Normalize spread to include team abbreviation for favorite/underdog parsing
      let normalizedSpread = 'N/A';
      if (game.spread) {
        // If spread already contains a team abbreviation keep it; otherwise assume home team context
        const hasTeam = /[A-Z]{2,4}\s*[+-]?\d/.test(game.spread);
        if (hasTeam) {
          normalizedSpread = game.spread;
        } else if (typeof game.homeAbbr === 'string') {
          normalizedSpread = `${game.homeAbbr} ${game.spread}`; // attach home abbreviation for parsing
        } else {
          normalizedSpread = game.spread; // fallback raw
        }
      }
      // Normalize over/under to numeric string only
      let normalizedOverUnder = 'N/A';
      if (game.overUnder) {
        const ouMatch = String(game.overUnder).match(/\d+(?:\.\d+)?/);
        if (ouMatch) normalizedOverUnder = ouMatch[0];
      }
      currentLockedLines[game.id] = {
        spread: normalizedSpread,
        overUnder: normalizedOverUnder,
        lockedAt: lockTime.toISOString()
      };
      updated = true;
    }
  });

  // Update in Supabase if any new lines were locked
  if (updated) {
    const { data, error } = await updateLeagueLockedLines(league.code, currentLockedLines);
    if (error) {
      console.error('Failed to update locked lines:', error);
      return league;
    }
    return data;
  }

  return league;
}
