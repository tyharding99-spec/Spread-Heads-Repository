import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const supabaseUrl = 'https://dqlbdwugykzhrrqtafbx.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxbGJkd3VneWt6aHJycXRhZmJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEzODA2MjgsImV4cCI6MjA3Njk1NjYyOH0.DBzCGjzEUq8Ba139KHSbns4L3zj2Md2QVC-uVtFVi3E';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
