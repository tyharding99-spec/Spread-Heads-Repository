import { supabase } from './supabaseClient';

/**
 * Supabase helper functions for achievement syncing
 */

/**
 * Save achievement unlock to Supabase
 * @param {string} userId - User ID
 * @param {string} achievementKey - Unique achievement identifier
 * @param {number} progress - Progress value (0-100)
 * @param {object} metadata - Additional data
 * @returns {Promise<{data, error}>}
 */
export async function saveAchievement(userId, achievementKey, progress = 100, metadata = {}) {
  try {
    const { data, error } = await supabase
      .from('achievements_user')
      .upsert({
        user_id: userId,
        achievement_key: achievementKey,
        progress,
        metadata,
        unlocked_at: progress >= 100 ? new Date().toISOString() : null,
      }, {
        onConflict: 'user_id,achievement_key'
      });
    
    if (error) {
      console.error('Error saving achievement:', error);
      return { data: null, error };
    }
    
    return { data, error: null };
  } catch (e) {
    console.error('Failed to save achievement:', e);
    return { data: null, error: e };
  }
}

/**
 * Get all achievements for a user
 * @param {string} userId - User ID
 * @returns {Promise<{data, error}>}
 */
export async function getUserAchievements(userId) {
  try {
    const { data, error } = await supabase
      .from('achievements_user')
      .select('*')
      .eq('user_id', userId)
      .order('unlocked_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching achievements:', error);
      return { data: null, error };
    }
    
    return { data, error: null };
  } catch (e) {
    console.error('Failed to fetch achievements:', e);
    return { data: null, error: e };
  }
}

/**
 * Check if user has unlocked a specific achievement
 * @param {string} userId - User ID
 * @param {string} achievementKey - Achievement identifier
 * @returns {Promise<{unlocked: boolean, data, error}>}
 */
export async function hasAchievement(userId, achievementKey) {
  try {
    const { data, error } = await supabase
      .from('achievements_user')
      .select('*')
      .eq('user_id', userId)
      .eq('achievement_key', achievementKey)
      .gte('progress', 100)
      .maybeSingle();
    
    if (error) {
      console.error('Error checking achievement:', error);
      return { unlocked: false, data: null, error };
    }
    
    return { unlocked: !!data, data, error: null };
  } catch (e) {
    console.error('Failed to check achievement:', e);
    return { unlocked: false, data: null, error: e };
  }
}

/**
 * Sync local achievements to Supabase
 * @param {string} userId - User ID
 * @param {Array} localAchievements - Array of local achievement objects
 * @returns {Promise<{synced: number, error}>}
 */
export async function syncAchievementsToServer(userId, localAchievements) {
  try {
    let synced = 0;
    
    for (const achievement of localAchievements) {
      if (achievement.unlocked) {
        const { error } = await saveAchievement(
          userId,
          achievement.key,
          100,
          {
            name: achievement.name,
            description: achievement.description,
            unlockedAt: achievement.unlockedAt || new Date().toISOString(),
          }
        );
        
        if (!error) {
          synced++;
        }
      }
    }
    
    return { synced, error: null };
  } catch (e) {
    console.error('Failed to sync achievements:', e);
    return { synced: 0, error: e };
  }
}

/**
 * Merge server achievements with local achievements
 * Server is source of truth - local unlocks that aren't on server will be synced
 * @param {Array} localAchievements - Local achievement objects
 * @param {Array} serverAchievements - Server achievement records
 * @returns {Array} Merged achievement list
 */
export function mergeAchievements(localAchievements, serverAchievements) {
  const serverKeys = new Set(serverAchievements.map(a => a.achievement_key));
  
  return localAchievements.map(local => {
    const serverMatch = serverAchievements.find(s => s.achievement_key === local.key);
    
    if (serverMatch) {
      // Use server data
      return {
        ...local,
        unlocked: serverMatch.progress >= 100,
        unlockedAt: serverMatch.unlocked_at,
        progress: serverMatch.progress,
      };
    }
    
    // Keep local data (will be synced to server later)
    return local;
  });
}

/**
 * Subscribe to achievement changes for real-time sync
 * @param {string} userId - User ID
 * @param {function} onAchievementChanged - Callback when achievement is added/updated
 * @returns {function} Cleanup function
 */
export function subscribeToAchievements(userId, onAchievementChanged) {
  const channel = supabase
    .channel(`user:${userId}:achievements`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'achievements_user',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        console.log('[Realtime] Achievement changed:', payload);
        if (onAchievementChanged) {
          onAchievementChanged(payload);
        }
      }
    )
    .subscribe();
  
  return () => {
    channel.unsubscribe();
  };
}
