-- =====================================================
-- SUPABASE REALTIME SETUP
-- =====================================================
-- This enables real-time subscriptions for existing tables
-- Run this in Supabase SQL Editor
-- =====================================================

-- Enable Realtime for picks table
ALTER PUBLICATION supabase_realtime ADD TABLE picks;

-- Enable Realtime for leagues table
-- (This covers both league settings AND member changes since members are stored in leagues.members array)
ALTER PUBLICATION supabase_realtime ADD TABLE leagues;

-- Enable Realtime for friend_requests table
ALTER PUBLICATION supabase_realtime ADD TABLE friend_requests;

-- =====================================================
-- VERIFICATION
-- =====================================================
-- Check which tables have Realtime enabled:
-- SELECT schemaname, tablename 
-- FROM pg_publication_tables 
-- WHERE pubname = 'supabase_realtime';
-- =====================================================

-- =====================================================
-- NOTES
-- =====================================================
-- 1. This does NOT create new tables, only enables Realtime on existing ones
-- 2. If tables already have Realtime enabled, these commands will error (safe to ignore)
-- 3. Alternative: Enable via Supabase Dashboard > Database > Replication
-- 4. Members are stored in leagues.members (array), not a separate table
-- =====================================================
