import { supabase } from './supabaseClient';

/**
 * Friend Request System
 * 
 * Database schema (create in Supabase):
 * 
 * CREATE TABLE friend_requests (
 *   id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 *   requester_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 *   recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 *   status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
 *   created_at TIMESTAMPTZ DEFAULT NOW(),
 *   updated_at TIMESTAMPTZ DEFAULT NOW(),
 *   UNIQUE(requester_id, recipient_id)
 * );
 * 
 * RLS Policies:
 * - SELECT: requester_id = auth.uid() OR recipient_id = auth.uid()
 * - INSERT: requester_id = auth.uid()
 * - UPDATE: (requester_id = auth.uid() AND status = 'pending') OR (recipient_id = auth.uid() AND status = 'pending')
 * - DELETE: requester_id = auth.uid() OR recipient_id = auth.uid()
 */

/**
 * Send a friend request to another user
 * @param {string} recipientId - UUID of the user to send request to
 * @returns {object} { data, error }
 */
export async function createFriendRequest(recipientId) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: null, error: new Error('Not authenticated') };
    
    if (user.id === recipientId) {
      return { data: null, error: new Error('Cannot send friend request to yourself') };
    }

    // Check if request already exists
    const { data: existing } = await supabase
      .from('friend_requests')
      .select('id, status')
      .or(`and(requester_id.eq.${user.id},recipient_id.eq.${recipientId}),and(requester_id.eq.${recipientId},recipient_id.eq.${user.id})`)
      .single();

    if (existing) {
      if (existing.status === 'pending') {
        return { data: null, error: new Error('Friend request already pending') };
      }
      if (existing.status === 'accepted') {
        return { data: null, error: new Error('Already friends') };
      }
    }

    const { data, error } = await supabase
      .from('friend_requests')
      .insert([{ requester_id: user.id, recipient_id: recipientId, status: 'pending' }])
      .select('*')
      .single();

    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}

/**
 * Accept a friend request
 * @param {string} requestId - UUID of the friend request
 * @returns {object} { data, error }
 */
export async function acceptFriendRequest(requestId) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: null, error: new Error('Not authenticated') };

    // Update request status
    const { data, error } = await supabase
      .from('friend_requests')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('recipient_id', user.id) // Only recipient can accept
      .eq('status', 'pending')
      .select('*')
      .single();

    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}

/**
 * Decline a friend request
 * @param {string} requestId - UUID of the friend request
 * @returns {object} { data, error }
 */
export async function declineFriendRequest(requestId) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: null, error: new Error('Not authenticated') };

    const { data, error } = await supabase
      .from('friend_requests')
      .update({ status: 'declined', updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('recipient_id', user.id)
      .eq('status', 'pending')
      .select('*')
      .single();

    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}

/**
 * Revoke (cancel) a friend request you sent
 * @param {string} requestId - UUID of the friend request
 * @returns {object} { data, error }
 */
export async function revokeFriendRequest(requestId) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: null, error: new Error('Not authenticated') };

    const { data, error } = await supabase
      .from('friend_requests')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('requester_id', user.id)
      .eq('status', 'pending')
      .select('*')
      .single();

    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}

/**
 * Get incoming friend requests (requests sent TO current user)
 * @param {string} status - Filter by status ('pending', 'accepted', 'declined', or null for all)
 * @returns {object} { data: [requests], error }
 */
export async function listIncomingFriendRequests(status = 'pending') {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: [], error: new Error('Not authenticated') };

    let query = supabase
      .from('friend_requests')
      .select(`
        id,
        requester_id,
        recipient_id,
        status,
        created_at,
        updated_at,
        requester:requester_id (
          id,
          username,
          display_name
        )
      `)
      .eq('recipient_id', user.id)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    return { data: data || [], error };
  } catch (e) {
    return { data: [], error: e };
  }
}

/**
 * Get outgoing friend requests (requests sent BY current user)
 * @param {string} status - Filter by status ('pending', 'accepted', 'declined', or null for all)
 * @returns {object} { data: [requests], error }
 */
export async function listOutgoingFriendRequests(status = 'pending') {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: [], error: new Error('Not authenticated') };

    let query = supabase
      .from('friend_requests')
      .select(`
        id,
        requester_id,
        recipient_id,
        status,
        created_at,
        updated_at,
        recipient:recipient_id (
          id,
          username,
          display_name
        )
      `)
      .eq('requester_id', user.id)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    return { data: data || [], error };
  } catch (e) {
    return { data: [], error: e };
  }
}

/**
 * Get all accepted friendships (bidirectional) for current user
 * @returns {object} { data: [user profiles], error }
 */
export async function listFriends() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: [], error: new Error('Not authenticated') };

    const { data, error } = await supabase
      .from('friend_requests')
      .select(`
        id,
        requester_id,
        recipient_id,
        created_at,
        requester:requester_id (
          id,
          username,
          display_name
        ),
        recipient:recipient_id (
          id,
          username,
          display_name
        )
      `)
      .eq('status', 'accepted')
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`);

    if (error) return { data: [], error };

    // Extract the friend (the other person in the relationship)
    const friends = (data || []).map(req => {
      const iAmRequester = req.requester_id === user.id;
      const friend = iAmRequester ? req.recipient : req.requester;
      return {
        userId: friend.id,
        username: friend.username,
        displayName: friend.display_name,
        friendshipId: req.id,
        addedAt: req.created_at,
      };
    });

    return { data: friends, error: null };
  } catch (e) {
    return { data: [], error: e };
  }
}

/**
 * Remove a friendship (delete the accepted friend request)
 * @param {string} friendshipId - UUID of the friend_request row
 * @returns {object} { data, error }
 */
export async function removeFriend(friendshipId) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: null, error: new Error('Not authenticated') };

    const { data, error } = await supabase
      .from('friend_requests')
      .delete()
      .eq('id', friendshipId)
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
      .select('*')
      .single();

    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}
