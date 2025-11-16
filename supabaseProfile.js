import { supabase } from './supabaseClient';

export async function createUserProfile({ id, email, username, display_name }) {
  // Insert user profile into Supabase and return the created row
  const { data, error } = await supabase
    .from('profiles')
    .insert([{ id, email, username, display_name }])
    .select('*')
    .single();
  return { data, error };
}

export async function getUserProfile(id) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single();
  return { data, error };
}

export async function updateUserProfile(id, updates) {
  // Only update provided fields; return the updated row
  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  return { data, error };
}

// Batch fetch profiles by array of IDs. Returns a map of id -> profile row
export async function getProfilesByIds(ids = []) {
  const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (uniqueIds.length === 0) return { data: new Map(), error: null };

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name')
    .in('id', uniqueIds);

  if (error) return { data: new Map(), error };

  const map = new Map();
  (data || []).forEach(row => {
    map.set(row.id, row);
  });
  return { data: map, error: null };
}

// Save Expo push token for a user profile (if the column exists)
export async function savePushToken(id, push_token) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .update({ push_token })
      .eq('id', id)
      .select('id, push_token')
      .single();
    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}

// Check if a username is available (case-sensitive exact match)
export async function isUsernameAvailable(username) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .limit(1);
    if (error) return { available: false, error };
    const exists = Array.isArray(data) && data.length > 0;
    return { available: !exists, error: null };
  } catch (e) {
    return { available: false, error: e };
  }
}

// Search for profiles by username or display name (case-insensitive partial match)
export async function searchProfilesByUsername(query, limit = 10) {
  try {
    if (!query || query.trim().length < 2) {
      return { data: [], error: null };
    }
    const searchTerm = `%${query.trim()}%`;
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name')
      .or(`username.ilike.${searchTerm},display_name.ilike.${searchTerm}`)
      .limit(limit);
    if (error) return { data: [], error };
    return { data: data || [], error: null };
  } catch (e) {
    return { data: [], error: e };
  }
}
