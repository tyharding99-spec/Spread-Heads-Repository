import { supabase } from './supabaseClient';
import { notifyLeagueSettingsChanged, notifyMemberAdded, notifyMemberRemoved } from './notifications';

/**
 * Real-time subscription management for Supabase channels
 * Handles automatic UI updates and push notifications for league events
 */

const activeChannels = new Map();

/**
 * Subscribe to picks changes in a league
 * @param {string} leagueCode - League code
 * @param {function} onPicksChanged - Callback when picks are inserted/updated/deleted
 * @returns {function} Cleanup function to unsubscribe
 */
export function subscribeToLeaguePicks(leagueCode, onPicksChanged) {
  const channelName = `league:${leagueCode}:picks`;
  
  // Unsubscribe existing channel if present
  if (activeChannels.has(channelName)) {
    const existing = activeChannels.get(channelName);
    existing.unsubscribe();
    activeChannels.delete(channelName);
  }
  
  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: '*', // INSERT, UPDATE, DELETE
        schema: 'public',
        table: 'picks',
        filter: `league_code=eq.${leagueCode}`,
      },
      (payload) => {
        console.log(`[Realtime] Pick change in ${leagueCode}:`, payload.eventType);
        if (onPicksChanged) {
          onPicksChanged(payload);
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime] Subscribed to picks for league ${leagueCode}`);
      }
    });
  
  activeChannels.set(channelName, channel);
  
  // Return cleanup function
  return () => {
    channel.unsubscribe();
    activeChannels.delete(channelName);
    console.log(`[Realtime] Unsubscribed from picks for league ${leagueCode}`);
  };
}

/**
 * Subscribe to league settings changes
 * @param {string} leagueCode - League code
 * @param {function} onSettingsChanged - Callback when league settings are updated
 * @param {boolean} notifyUser - Whether to send push notification for changes
 * @returns {function} Cleanup function to unsubscribe
 */
export function subscribeToLeagueSettings(leagueCode, onSettingsChanged, notifyUser = true) {
  const channelName = `league:${leagueCode}:settings`;
  
  if (activeChannels.has(channelName)) {
    const existing = activeChannels.get(channelName);
    existing.unsubscribe();
    activeChannels.delete(channelName);
  }
  
  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'leagues',
        filter: `league_code=eq.${leagueCode}`,
      },
      async (payload) => {
        console.log(`[Realtime] League settings changed for ${leagueCode}`);
        
        // Notify user about settings change
        if (notifyUser) {
          const leagueName = payload.new?.league_name || 'Your league';
          await notifyLeagueSettingsChanged(leagueName);
        }
        
        if (onSettingsChanged) {
          onSettingsChanged(payload);
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime] Subscribed to settings for league ${leagueCode}`);
      }
    });
  
  activeChannels.set(channelName, channel);
  
  return () => {
    channel.unsubscribe();
    activeChannels.delete(channelName);
    console.log(`[Realtime] Unsubscribed from settings for league ${leagueCode}`);
  };
}

/**
 * Subscribe to league member changes (joins/leaves)
 * Note: Members are stored in leagues.members array, so we watch for UPDATE events on leagues table
 * @param {string} leagueCode - League code
 * @param {string} currentUserId - Current user's ID to filter out self-actions
 * @param {function} onMembersChanged - Callback when members are added/removed
 * @param {boolean} notifyUser - Whether to send push notification for changes
 * @returns {function} Cleanup function to unsubscribe
 */
export function subscribeToLeagueMembers(leagueCode, currentUserId, onMembersChanged, notifyUser = true) {
  const channelName = `league:${leagueCode}:members`;
  
  if (activeChannels.has(channelName)) {
    const existing = activeChannels.get(channelName);
    existing.unsubscribe();
    activeChannels.delete(channelName);
  }
  
  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'leagues',
        filter: `league_code=eq.${leagueCode}`,
      },
      async (payload) => {
        console.log(`[Realtime] League updated in ${leagueCode}, checking member changes...`);
        
        // Compare old and new members arrays to detect additions/removals
        const oldMembers = payload.old?.members || [];
        const newMembers = payload.new?.members || [];
        
        // Check for added members
        const addedMembers = newMembers.filter(m => !oldMembers.includes(m));
        if (addedMembers.length > 0 && notifyUser && !addedMembers.includes(currentUserId)) {
          // Someone else joined
          const leagueName = payload.new?.league_name || 'the league';
          await notifyMemberAdded('A new member', leagueName);
        }
        
        // Check for removed members
        const removedMembers = oldMembers.filter(m => !newMembers.includes(m));
        if (removedMembers.length > 0 && notifyUser && !removedMembers.includes(currentUserId)) {
          // Someone else left
          const leagueName = payload.new?.league_name || 'the league';
          await notifyMemberRemoved('A member', leagueName);
        }
        
        if (addedMembers.length > 0 || removedMembers.length > 0) {
          if (onMembersChanged) {
            onMembersChanged({ 
              type: addedMembers.length > 0 ? 'MEMBER_ADDED' : 'MEMBER_REMOVED', 
              payload 
            });
          }
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime] Subscribed to members for league ${leagueCode}`);
      }
    });
  
  activeChannels.set(channelName, channel);
  
  return () => {
    channel.unsubscribe();
    activeChannels.delete(channelName);
    console.log(`[Realtime] Unsubscribed from members for league ${leagueCode}`);
  };
}

/**
 * Subscribe to friend requests for current user
 * @param {string} userId - Current user's ID
 * @param {function} onFriendRequest - Callback when a friend request is received
 * @returns {function} Cleanup function to unsubscribe
 */
export function subscribeToFriendRequests(userId, onFriendRequest) {
  const channelName = `user:${userId}:friend_requests`;
  
  if (activeChannels.has(channelName)) {
    const existing = activeChannels.get(channelName);
    existing.unsubscribe();
    activeChannels.delete(channelName);
  }
  
  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'friend_requests',
        filter: `receiver_id=eq.${userId}`,
      },
      (payload) => {
        console.log(`[Realtime] Friend request received for user ${userId}`);
        if (onFriendRequest) {
          onFriendRequest(payload);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'friend_requests',
        filter: `sender_id=eq.${userId}`,
      },
      (payload) => {
        // Friend request was accepted
        if (payload.new?.status === 'accepted') {
          console.log(`[Realtime] Friend request accepted for user ${userId}`);
          if (onFriendRequest) {
            onFriendRequest({ ...payload, type: 'ACCEPTED' });
          }
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime] Subscribed to friend requests for user ${userId}`);
      }
    });
  
  activeChannels.set(channelName, channel);
  
  return () => {
    channel.unsubscribe();
    activeChannels.delete(channelName);
    console.log(`[Realtime] Unsubscribed from friend requests for user ${userId}`);
  };
}

/**
 * Unsubscribe from all active channels
 * Call this when user logs out or app backgrounds
 */
export function unsubscribeAll() {
  console.log(`[Realtime] Unsubscribing from ${activeChannels.size} channels`);
  activeChannels.forEach((channel, name) => {
    channel.unsubscribe();
    console.log(`[Realtime] Unsubscribed from ${name}`);
  });
  activeChannels.clear();
}

/**
 * Get count of active subscriptions
 */
export function getActiveSubscriptionCount() {
  return activeChannels.size;
}

/**
 * Subscribe to finalized NFL game results for a specific week/season.
 * Triggers callback whenever a final result row is inserted/updated.
 * @param {number} week
 * @param {number} season
 * @param {(payload:any)=>void} onResultChanged
 * @returns {function} cleanup
 */
export function subscribeToFinalResults(week, season, onResultChanged) {
  const channelName = `results:W${week}:S${season}`;

  if (activeChannels.has(channelName)) {
    const existing = activeChannels.get(channelName);
    existing.unsubscribe();
    activeChannels.delete(channelName);
  }

  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'game_results',
        filter: `week=eq.${week},season=eq.${season}`,
      },
      (payload) => {
        const row = payload.new || payload.old || {};
        if (row?.is_final) {
          console.log(`[Realtime] Final result change W${week} S${season}:`, payload.eventType, row.game_id);
          if (onResultChanged) onResultChanged(payload);
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime] Subscribed to final results for W${week} S${season}`);
      }
    });

  activeChannels.set(channelName, channel);

  return () => {
    channel.unsubscribe();
    activeChannels.delete(channelName);
    console.log(`[Realtime] Unsubscribed from final results for W${week} S${season}`);
  };
}
