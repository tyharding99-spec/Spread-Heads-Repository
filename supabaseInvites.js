import { supabase } from './supabaseClient';

// Expected table schema: league_invites
// id uuid (pk, default uuid_generate_v4())
// league_code text
// inviter_id uuid
// invitee_id uuid
// status text ('pending','accepted','declined','revoked')
// created_at timestamptz default now()
// responded_at timestamptz nullable

export async function createInvite({ league_code, inviter_id, invitee_id }) {
  const { data, error } = await supabase
    .from('league_invites')
    .insert([{ league_code, inviter_id, invitee_id, status: 'pending' }])
    .select('*')
    .single();
  return { data, error };
}

export async function listPendingInvitesForUser(invitee_id) {
  const { data, error } = await supabase
    .from('league_invites')
    .select('id, league_code, inviter_id, invitee_id, status, created_at')
    .eq('invitee_id', invitee_id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  return { data, error };
}

export async function listPendingInvitesForLeague(league_code) {
  const { data, error } = await supabase
    .from('league_invites')
    .select('id, league_code, inviter_id, invitee_id, status, created_at')
    .eq('league_code', league_code)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  return { data, error };
}

export async function setInviteStatus(id, status) {
  const { data, error } = await supabase
    .from('league_invites')
    .update({ status, responded_at: ['accepted','declined','revoked'].includes(status) ? new Date().toISOString() : null })
    .eq('id', id)
    .select('*')
    .single();
  return { data, error };
}

export async function acceptInvite(id) {
  return setInviteStatus(id, 'accepted');
}

export async function declineInvite(id) {
  return setInviteStatus(id, 'declined');
}

export async function revokeInvite(id) {
  return setInviteStatus(id, 'revoked');
}
