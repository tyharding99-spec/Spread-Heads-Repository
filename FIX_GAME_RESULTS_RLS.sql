-- Fix RLS policy for game_results to allow authenticated users to insert
-- This allows the app to automatically populate game results when games become final

-- Drop the restrictive service role policy
-- Remove any existing broad authenticated policy (idempotent)
DROP POLICY IF EXISTS "Authenticated users can manage game results" ON game_results;
DROP POLICY IF EXISTS "Service role can manage game results" ON game_results;

-- Narrow policies: authenticated users can INSERT/UPDATE only finalized rows
-- (Prevents creating non-final placeholders from the client.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'game_results'
      AND policyname = 'Auth can insert finals'
  ) THEN
    CREATE POLICY "Auth can insert finals"
      ON game_results
      FOR INSERT
      TO authenticated
      WITH CHECK (is_final = true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'game_results'
      AND policyname = 'Auth can update finals'
  ) THEN
    CREATE POLICY "Auth can update finals"
      ON game_results
      FOR UPDATE
      TO authenticated
      USING (is_final = true)
      WITH CHECK (is_final = true);
  END IF;
END$$;

-- Final results read policy (keep if already present; create if missing)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'game_results'
      AND policyname = 'Anyone can read final game results'
  ) THEN
    CREATE POLICY "Anyone can read final game results"
      ON game_results
      FOR SELECT
      USING (is_final = true);
  END IF;
END$$;

-- Optional: Reintroduce a service role policy only if you need non-final staging rows (commented out)
-- CREATE POLICY "Service role can manage game results"
--   ON game_results
--   FOR ALL
--   TO service_role
--   USING (true)
--   WITH CHECK (true);
