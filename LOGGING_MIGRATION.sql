-- =====================================================
-- ERROR & METRICS LOGGING
-- =====================================================
-- Create table for client-side error and metrics logging
-- Run this in Supabase SQL Editor
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
CREATE INDEX idx_client_logs_user_id ON client_logs(user_id);
CREATE INDEX idx_client_logs_type ON client_logs(log_type);
CREATE INDEX idx_client_logs_category ON client_logs(category);
CREATE INDEX idx_client_logs_created_at ON client_logs(created_at DESC);
CREATE INDEX idx_client_logs_user_type_created ON client_logs(user_id, log_type, created_at DESC);

-- Enable Row Level Security
ALTER TABLE client_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can insert their own logs
CREATE POLICY "Users can create their own logs"
  ON client_logs
  FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

-- RLS Policy: Users can view their own logs
CREATE POLICY "Users can view their own logs"
  ON client_logs
  FOR SELECT
  USING (auth.uid() = user_id);

-- RLS Policy: Admins can view all logs (future enhancement)
-- CREATE POLICY "Admins can view all logs"
--   ON client_logs
--   FOR SELECT
--   USING (
--     EXISTS (
--       SELECT 1 FROM profiles
--       WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
--     )
--   );

-- =====================================================
-- RETENTION POLICY
-- =====================================================
-- Optional: Delete logs older than 30 days
-- Run this as a scheduled job or manual cleanup

-- DELETE FROM client_logs
-- WHERE created_at < NOW() - INTERVAL '30 days';

-- =====================================================
-- NOTES
-- =====================================================
-- 1. log_type: 'error', 'warning', 'info', or 'metric'
-- 2. category: Group logs by feature (e.g., 'pick_save', 'auth', 'network')
-- 3. details: Store additional context as JSON
-- 4. stack_trace: Full error stack for debugging
-- 5. Consider implementing log aggregation/alerting for critical errors
-- =====================================================
