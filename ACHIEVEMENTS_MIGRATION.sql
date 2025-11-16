-- =====================================================
-- ACHIEVEMENTS SERVER SYNC
-- =====================================================
-- Create table to sync achievement unlocks across devices
-- Run this in Supabase SQL Editor
-- =====================================================

-- Create achievements_user table
CREATE TABLE IF NOT EXISTS achievements_user (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  achievement_key TEXT NOT NULL,
  unlocked_at TIMESTAMPTZ DEFAULT NOW(),
  progress INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_user_achievement UNIQUE(user_id, achievement_key)
);

-- Create indexes for faster queries
CREATE INDEX idx_achievements_user_user_id ON achievements_user(user_id);
CREATE INDEX idx_achievements_user_achievement_key ON achievements_user(achievement_key);
CREATE INDEX idx_achievements_user_unlocked_at ON achievements_user(unlocked_at DESC);

-- Enable Row Level Security
ALTER TABLE achievements_user ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view their own achievements
CREATE POLICY "Users can view their own achievements"
  ON achievements_user
  FOR SELECT
  USING (auth.uid() = user_id);

-- RLS Policy: Users can insert their own achievements
CREATE POLICY "Users can create their own achievements"
  ON achievements_user
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policy: Users can update their own achievements
CREATE POLICY "Users can update their own achievements"
  ON achievements_user
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- RLS Policy: Users can delete their own achievements
CREATE POLICY "Users can delete their own achievements"
  ON achievements_user
  FOR DELETE
  USING (auth.uid() = user_id);

-- Create updated_at trigger
CREATE TRIGGER update_achievements_user_updated_at
    BEFORE UPDATE ON achievements_user
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- ENABLE REALTIME
-- =====================================================
-- Enable realtime for achievement syncing
ALTER PUBLICATION supabase_realtime ADD TABLE achievements_user;

-- =====================================================
-- NOTES
-- =====================================================
-- 1. achievement_key: Unique identifier for each achievement (e.g., 'first_win', 'hot_streak_5')
-- 2. progress: Track progress towards achievement (0-100 for percentage-based)
-- 3. metadata: Store additional data (e.g., {"streak_count": 5, "timestamp": "..."})
-- 4. Realtime enabled for instant sync across devices
-- =====================================================
