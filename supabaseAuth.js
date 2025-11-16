import { supabase } from './supabaseClient';

export async function signUp({ email, password, username, displayName }) {
  // Supabase sign up with email/password
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username, display_name: displayName || username }
    }
  });
  console.log('SignUp response:', { 
    user: data?.user ? { id: data.user.id, email: data.user.email } : null,
    session: data?.session ? 'present' : 'null',
    error: error ? { message: error.message, status: error.status, code: error.code } : null 
  });
  
  // Return both user and session - session is needed for RLS policies
  return { user: data?.user, session: data?.session, error };
}

export async function signIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  console.log('SignIn response:', { data, error });
  return { user: data?.user, error };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  return { error };
}

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  return { user: data?.user, error };
}

export async function updateUserMetadata(metadata) {
  const { data, error } = await supabase.auth.updateUser({ data: metadata });
  return { user: data?.user, error };
}

export async function updateUserEmail(email) {
  const { data, error } = await supabase.auth.updateUser({ email });
  return { user: data?.user, error };
}

// Resend verification email (signup confirmation). Supabase v2 uses auth.resend
export async function resendVerificationEmail(email) {
  try {
    const { data, error } = await supabase.auth.resend({
      type: 'signup',
      email,
    });
    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}
