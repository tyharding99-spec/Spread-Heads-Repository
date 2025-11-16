-- =====================================================
-- COMPLETE MIGRATION SCRIPT
-- =====================================================
-- Run this entire script in Supabase SQL Editor
-- Combines: Realtime, Achievements, and Logging setup
-- =====================================================

-- =====================================================
-- PART 1: ENABLE REALTIME
-- =====================================================
-- Enables real-time subscriptions for existing tables
-- Note: These will error if already enabled - that's okay!
-- =====================================================

-- Enable Realtime for picks table (skip if already enabled)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE picks;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Enable Realtime for leagues table (skip if already enabled)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE leagues;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Enable Realtime for friend_requests table (skip if already enabled)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE friend_requests;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================
-- PART 2: ACHIEVEMENTS SYNC
-- =====================================================
-- Creates table for cross-device achievement syncing
-- =====================================================

-- Create achievements_user table
CREATE TABLE IF NOT EXISTS achievements_user (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  achievement_key TEXT NOT NULL,
  unlocked_at TIMESTAMPTZ DEFAULT NOW(),
  progress JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, achievement_key)
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_achievements_user_id ON achievements_user(user_id);
CREATE INDEX IF NOT EXISTS idx_achievements_key ON achievements_user(achievement_key);
CREATE INDEX IF NOT EXISTS idx_achievements_unlocked ON achievements_user(user_id, unlocked_at DESC);

-- Enable Row Level Security
ALTER TABLE achievements_user ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only access their own achievements
DO $$
BEGIN
  CREATE POLICY "Users can view their own achievements"
    ON achievements_user
    FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "Users can insert their own achievements"
    ON achievements_user
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "Users can update their own achievements"
    ON achievements_user
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Enable Realtime for achievements (for cross-device sync)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE achievements_user;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_achievements_user_updated_at ON achievements_user;
CREATE TRIGGER update_achievements_user_updated_at
  BEFORE UPDATE ON achievements_user
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- PART 3: ERROR & METRICS LOGGING
-- =====================================================
-- Creates table for client-side error and metrics logging
-- =====================================================

-- Create client_logs table
CREATE TABLE IF NOT EXISTS client_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  log_type TEXT NOT NULL CHECK (log_type IN ('error', 'warning', 'info', 'metric')),
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  stack_trace TEXT,
  user_agent TEXT,
  platform TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_client_logs_user_id ON client_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_client_logs_type ON client_logs(log_type);
CREATE INDEX IF NOT EXISTS idx_client_logs_category ON client_logs(category);
CREATE INDEX IF NOT EXISTS idx_client_logs_created_at ON client_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_logs_user_type_created ON client_logs(user_id, log_type, created_at DESC);

-- Enable Row Level Security
ALTER TABLE client_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can insert their own logs
DO $$
BEGIN
  CREATE POLICY "Users can create their own logs"
    ON client_logs
    FOR INSERT
    WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- RLS Policy: Users can view their own logs
DO $$
BEGIN
  CREATE POLICY "Users can view their own logs"
    ON client_logs
    FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================
-- Run these individually to verify setup
-- =====================================================

-- Check which tables have Realtime enabled:
-- SELECT schemaname, tablename 
-- FROM pg_publication_tables 
-- WHERE pubname = 'supabase_realtime';

-- Check achievements table exists:
-- SELECT COUNT(*) FROM achievements_user;

-- Check client_logs table exists:
-- SELECT COUNT(*) FROM client_logs;

-- =====================================================
-- SUCCESS!
-- =====================================================
-- If you see no errors, all migrations completed successfully.
-- Your app now has:
-- ✅ Real-time subscriptions (picks, leagues, friend_requests, achievements)
-- ✅ Achievement server sync with cross-device support
-- ✅ Error and metrics logging
-- =====================================================
