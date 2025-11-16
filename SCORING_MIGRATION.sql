-- ============================================================================
-- Server-Side Scoring Migration
-- ============================================================================
-- This migration adds two tables to enable server-side score computation:
--   1. game_results: Stores official results for each game (winner, final score)
--   2. weekly_points: Caches computed weekly scores per user per league
-- 
-- NAMING CONVENTION: snake_case for database (standard SQL convention)
-- ============================================================================

-- Required extensions/helpers
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Generic updated_at helper used by triggers below
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. GAME RESULTS TABLE
-- Stores official outcomes for each game once final
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_id TEXT NOT NULL UNIQUE,
  week INTEGER NOT NULL,
  season INTEGER NOT NULL DEFAULT 2025,
  
  -- Final scores
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  
  -- Winner (team abbreviation)
  winner TEXT NOT NULL,
  
  -- Spread outcome: 'home' if home covered, 'away' if away covered, 'push' if exact
  spread_result TEXT CHECK (spread_result IN ('home', 'away', 'push')),
  spread_line NUMERIC(4,1), -- The spread line used (e.g., -3.5)
  
  -- Total outcome: 'over' or 'under' or 'push'
  total_result TEXT CHECK (total_result IN ('over', 'under', 'push')),
  total_line NUMERIC(4,1), -- The total line used (e.g., 47.5)
  
  -- Status tracking
  is_final BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT valid_winner CHECK (winner IN (home_team, away_team) OR winner = 'TIE')
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_game_results_week ON game_results(week, season);
CREATE INDEX IF NOT EXISTS idx_game_results_game_id ON game_results(game_id);
CREATE INDEX IF NOT EXISTS idx_game_results_final ON game_results(is_final);

-- Enable RLS
ALTER TABLE game_results ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Anyone can read finalized results (public data)
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

-- RLS Policy: Only service role can insert/update (via admin or cron job)
-- Note: Service role bypasses RLS by default, this is for documentation
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'game_results'
      AND policyname = 'Service role can manage game results'
  ) THEN
    CREATE POLICY "Service role can manage game results"
      ON game_results
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END$$;

-- Updated_at trigger
DROP TRIGGER IF EXISTS update_game_results_updated_at ON game_results;
CREATE TRIGGER update_game_results_updated_at
  BEFORE UPDATE ON game_results
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ----------------------------------------------------------------------------
-- 2. WEEKLY POINTS TABLE
-- Stores computed weekly scores per user per league (cached results)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weekly_points (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_code TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week INTEGER NOT NULL,
  season INTEGER NOT NULL DEFAULT 2025,
  
  -- Computed totals
  total_points NUMERIC(6,2) NOT NULL DEFAULT 0,
  
  -- Breakdown by pick type
  winner_correct INTEGER DEFAULT 0,
  winner_incorrect INTEGER DEFAULT 0,
  spread_correct INTEGER DEFAULT 0,
  spread_incorrect INTEGER DEFAULT 0,
  spread_push INTEGER DEFAULT 0,
  total_correct INTEGER DEFAULT 0,
  total_incorrect INTEGER DEFAULT 0,
  total_push INTEGER DEFAULT 0,
  
  -- Metadata
  games_picked INTEGER DEFAULT 0,
  games_graded INTEGER DEFAULT 0, -- How many games have final results
  is_complete BOOLEAN DEFAULT false, -- True when all picked games are graded
  
  -- Scoring weights snapshot (for audit trail)
  scoring_weights JSONB, -- e.g., {"winner":1,"spread":1,"total":1}
  
  -- Timestamps
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- One row per user per league per week
  CONSTRAINT unique_weekly_points UNIQUE(league_code, user_id, week, season)
);

-- Indexes for leaderboard queries
CREATE INDEX IF NOT EXISTS idx_weekly_points_league_week ON weekly_points(league_code, week, season);
CREATE INDEX IF NOT EXISTS idx_weekly_points_user ON weekly_points(user_id);
CREATE INDEX IF NOT EXISTS idx_weekly_points_leaderboard ON weekly_points(league_code, week, season, total_points DESC);

-- Enable RLS
ALTER TABLE weekly_points ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view weekly points for leagues they're members of
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'weekly_points'
      AND policyname = 'Users can view weekly points in their leagues'
  ) THEN
    CREATE POLICY "Users can view weekly points in their leagues"
      ON weekly_points
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM leagues
          WHERE leagues.code = weekly_points.league_code
          AND auth.uid() = ANY(leagues.members)
        )
      );
  END IF;
END$$;

-- RLS Policy: Service role can insert/update (via compute function)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'weekly_points'
      AND policyname = 'Service role can manage weekly points'
  ) THEN
    CREATE POLICY "Service role can manage weekly points"
      ON weekly_points
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END$$;

-- Updated_at trigger
DROP TRIGGER IF EXISTS update_weekly_points_updated_at ON weekly_points;
CREATE TRIGGER update_weekly_points_updated_at
  BEFORE UPDATE ON weekly_points
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ----------------------------------------------------------------------------
-- 3. COMPUTE FUNCTION: calculate weekly points for a league
-- ----------------------------------------------------------------------------
-- This function recalculates scores for all users in a league for a specific week
-- Call via: SELECT compute_weekly_points('LEAGUE123', 10, 2025);
-- Returns: number of user records computed
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compute_weekly_points(
  p_league_code TEXT,
  p_week INTEGER,
  p_season INTEGER DEFAULT 2025
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER -- Run with elevated privileges
AS $$
DECLARE
  v_league RECORD;
  v_user_id UUID;
  v_computed_count INTEGER := 0;
  v_scoring_weights JSONB;
  v_total_points NUMERIC := 0;
  v_winner_correct INTEGER := 0;
  v_winner_incorrect INTEGER := 0;
  v_spread_correct INTEGER := 0;
  v_spread_incorrect INTEGER := 0;
  v_spread_push INTEGER := 0;
  v_total_correct INTEGER := 0;
  v_total_incorrect INTEGER := 0;
  v_total_push INTEGER := 0;
  v_games_picked INTEGER := 0;
  v_games_graded INTEGER := 0;
  v_is_complete BOOLEAN := true;
  v_pick RECORD;
  v_result RECORD;
  -- Per-league line grading helpers
  v_locked JSONB;
  v_spread_str TEXT;
  v_total_str TEXT;
  v_line_spread NUMERIC;
  v_line_total NUMERIC;
  v_fav_side TEXT;
  v_home_line NUMERIC;
  v_margin INTEGER;
  v_tot_points INTEGER;
BEGIN
  -- Fetch league to get scoring weights
  SELECT * INTO v_league FROM leagues WHERE code = p_league_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League % not found', p_league_code;
  END IF;

  -- Extract scoring weights from settings
  v_scoring_weights := COALESCE(v_league.settings->'scoring', '{"winner":1,"spread":1,"total":1}'::jsonb);

  -- Loop through each member of the league
  FOR v_user_id IN 
    SELECT UNNEST(v_league.members) AS user_id
  LOOP
    -- Reset counters for this user
    v_total_points := 0;
    v_winner_correct := 0;
    v_winner_incorrect := 0;
    v_spread_correct := 0;
    v_spread_incorrect := 0;
    v_spread_push := 0;
    v_total_correct := 0;
    v_total_incorrect := 0;
    v_total_push := 0;
    v_games_picked := 0;
    v_games_graded := 0;
    v_is_complete := true;

    -- Process each pick for this user
    FOR v_pick IN
      SELECT * FROM picks
      WHERE league_code = p_league_code
        AND user_id = v_user_id
        AND week = p_week
    LOOP
      v_games_picked := v_games_picked + 1;

      -- Find corresponding game result
      SELECT * INTO v_result FROM game_results
      WHERE game_id = v_pick.game_id AND is_final = true;

      IF NOT FOUND THEN
        -- Game not yet graded
        v_is_complete := false;
        CONTINUE;
      END IF;

      v_games_graded := v_games_graded + 1;

      -- Grade WINNER pick
      IF v_pick.winner IS NOT NULL THEN
        IF v_pick.winner = v_result.winner THEN
          v_winner_correct := v_winner_correct + 1;
          v_total_points := v_total_points + (v_scoring_weights->>'winner')::NUMERIC;
        ELSIF v_result.winner = 'TIE' THEN
          -- Tie game: no points (could adjust logic here if needed)
          NULL;
        ELSE
          v_winner_incorrect := v_winner_incorrect + 1;
        END IF;
      END IF;

      -- Grade SPREAD pick (per-league locked line if available)
      IF v_pick.spread IS NOT NULL THEN
        -- We store abbreviations directly in picks
        DECLARE picked_team TEXT;
        BEGIN
          -- Normalize picked team (strip any trailing line info if stored like 'NYJ +13.5')
          picked_team := COALESCE( (regexp_match(v_pick.spread, '^[A-Za-z]{2,4}'))[1], v_pick.spread );

          -- Read league-specific locked spread string if present
          v_locked := v_league.locked_lines;
          v_spread_str := NULL;
          IF v_locked IS NOT NULL THEN
            v_spread_str := COALESCE( (v_locked -> (v_pick.game_id)::text ->> 'spread'), NULL );
          END IF;

          -- Derive spread number and favorite side
          v_line_spread := NULL;
          v_fav_side := NULL;
          IF v_spread_str IS NOT NULL THEN
            -- Preferred pattern: 'TEAM +/-X.X'
            IF v_spread_str ~ '^[A-Z]{2,4}\s*[-+]?\d' THEN
              -- Extract team abbreviation and numeric line
              PERFORM 1; -- noop
              DECLARE v_team_token TEXT; DECLARE v_num_token TEXT; BEGIN
                SELECT (regexp_match(v_spread_str, '^[A-Z]{2,4}'))[1] INTO v_team_token; -- team abbreviation appearing in string
                SELECT (regexp_match(v_spread_str, '([-+]?\d+(?:\.\d+)?)'))[1] INTO v_num_token; -- numeric portion with sign
                IF v_num_token IS NOT NULL THEN
                  v_line_spread := ABS(v_num_token::NUMERIC);
                END IF;
                -- Determine if the team token is favorite or underdog by sign
                IF v_team_token IS NOT NULL THEN
                  IF v_num_token LIKE '-%' THEN
                    -- Team token is favorite
                    IF v_team_token = v_result.home_team THEN
                      v_fav_side := 'home';
                    ELSIF v_team_token = v_result.away_team THEN
                      v_fav_side := 'away';
                    ELSE
                      v_fav_side := NULL; -- unknown team abbreviation
                    END IF;
                  ELSIF v_num_token LIKE '+%' THEN
                    -- Team token shown with plus => it's the underdog, so favorite is the opposite side
                    IF v_team_token = v_result.home_team THEN
                      v_fav_side := 'away';
                    ELSIF v_team_token = v_result.away_team THEN
                      v_fav_side := 'home';
                    ELSE
                      v_fav_side := NULL;
                    END IF;
                  ELSE
                    -- No explicit sign (assume team token is favorite)
                    IF v_team_token = v_result.home_team THEN
                      v_fav_side := 'home';
                    ELSIF v_team_token = v_result.away_team THEN
                      v_fav_side := 'away';
                    ELSE
                      v_fav_side := NULL;
                    END IF;
                  END IF;
                END IF;
              END;
            ELSE
              -- Fallback: numeric-only string; infer favorite from sign
              SELECT (regexp_match(v_spread_str, '[-+]?\d+(?:\.\d+)?'))[1]::NUMERIC INTO v_line_spread;
              IF v_line_spread IS NOT NULL THEN
                IF v_spread_str LIKE '-%' THEN
                  v_fav_side := 'home';
                  v_line_spread := ABS(v_line_spread);
                ELSE
                  v_fav_side := 'away';
                  v_line_spread := ABS(v_line_spread);
                END IF;
              END IF;
            END IF;
          END IF;

          IF v_line_spread IS NULL OR v_fav_side IS NULL THEN
            -- Fallback: use global stored scoreboard spread_line if present
            IF v_result.spread_line IS NOT NULL THEN
              v_line_spread := ABS(v_result.spread_line);
              IF v_result.spread_line < 0 THEN
                v_fav_side := 'home';
              ELSIF v_result.spread_line > 0 THEN
                v_fav_side := 'away';
              END IF;
            END IF;
          END IF;

          IF v_line_spread IS NULL OR v_fav_side IS NULL THEN
            -- Still no line to grade against
            v_is_complete := false;
          ELSE
            v_margin := v_result.home_score - v_result.away_score;
            v_home_line := CASE WHEN v_fav_side = 'home' THEN -v_line_spread ELSE v_line_spread END;

            IF (v_margin + v_home_line) = 0 THEN
              v_spread_push := v_spread_push + 1;
            ELSIF (v_margin + v_home_line) > 0 THEN
              -- home covered
              IF picked_team = v_result.home_team THEN
                v_spread_correct := v_spread_correct + 1;
                v_total_points := v_total_points + (v_scoring_weights->>'spread')::NUMERIC;
              ELSE
                v_spread_incorrect := v_spread_incorrect + 1;
              END IF;
            ELSE
              -- away covered
              IF picked_team = v_result.away_team THEN
                v_spread_correct := v_spread_correct + 1;
                v_total_points := v_total_points + (v_scoring_weights->>'spread')::NUMERIC;
              ELSE
                v_spread_incorrect := v_spread_incorrect + 1;
              END IF;
            END IF;
          END IF;
        END;
      END IF;

      -- Grade TOTAL pick (per-league locked line if available)
      IF v_pick.total IS NOT NULL THEN
        DECLARE picked_direction TEXT;
        BEGIN
          picked_direction := LOWER(v_pick.total);

          v_total_str := NULL;
          IF v_league.locked_lines IS NOT NULL THEN
            v_total_str := COALESCE( (v_league.locked_lines -> (v_pick.game_id)::text ->> 'overUnder'), NULL );
          END IF;
          v_line_total := NULL;
          IF v_total_str IS NOT NULL THEN
            SELECT (regexp_match(v_total_str, '\\d+(?:\\.\\d+)?'))[1]::NUMERIC INTO v_line_total;
          END IF;
          IF v_line_total IS NULL THEN
            -- Fallback: use stored total_line from game_results if available
            IF v_result.total_line IS NOT NULL THEN
              v_line_total := v_result.total_line;
            END IF;
          END IF;
          IF v_line_total IS NULL THEN
            v_is_complete := false;
          ELSE
            v_tot_points := v_result.home_score + v_result.away_score;
            IF v_tot_points = v_line_total THEN
              v_total_push := v_total_push + 1;
            ELSIF (v_tot_points > v_line_total AND picked_direction = 'over') OR (v_tot_points < v_line_total AND picked_direction = 'under') THEN
              v_total_correct := v_total_correct + 1;
              v_total_points := v_total_points + (v_scoring_weights->>'total')::NUMERIC;
            ELSE
              v_total_incorrect := v_total_incorrect + 1;
            END IF;
          END IF;
        END;
      END IF;
    END LOOP;

    -- Upsert weekly_points row for this user
    INSERT INTO weekly_points (
      league_code, user_id, week, season,
      total_points,
      winner_correct, winner_incorrect,
      spread_correct, spread_incorrect, spread_push,
      total_correct, total_incorrect, total_push,
      games_picked, games_graded, is_complete,
      scoring_weights, computed_at
    ) VALUES (
      p_league_code, v_user_id, p_week, p_season,
      v_total_points,
      v_winner_correct, v_winner_incorrect,
      v_spread_correct, v_spread_incorrect, v_spread_push,
      v_total_correct, v_total_incorrect, v_total_push,
      v_games_picked, v_games_graded, v_is_complete,
      v_scoring_weights, NOW()
    )
    ON CONFLICT (league_code, user_id, week, season)
    DO UPDATE SET
      total_points = EXCLUDED.total_points,
      winner_correct = EXCLUDED.winner_correct,
      winner_incorrect = EXCLUDED.winner_incorrect,
      spread_correct = EXCLUDED.spread_correct,
      spread_incorrect = EXCLUDED.spread_incorrect,
      spread_push = EXCLUDED.spread_push,
      total_correct = EXCLUDED.total_correct,
      total_incorrect = EXCLUDED.total_incorrect,
      total_push = EXCLUDED.total_push,
      games_picked = EXCLUDED.games_picked,
      games_graded = EXCLUDED.games_graded,
      is_complete = EXCLUDED.is_complete,
      scoring_weights = EXCLUDED.scoring_weights,
      computed_at = NOW(),
      updated_at = NOW();

    v_computed_count := v_computed_count + 1;
  END LOOP;

  RETURN v_computed_count;
END;
$$;

-- Grant execute to authenticated users (they can trigger recompute via RPC)
GRANT EXECUTE ON FUNCTION compute_weekly_points TO authenticated;


-- ----------------------------------------------------------------------------
-- 4. HELPER FUNCTION: Get current leaderboard for a league/week
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_weekly_leaderboard(
  p_league_code TEXT,
  p_week INTEGER,
  p_season INTEGER DEFAULT 2025
)
RETURNS TABLE (
  user_id UUID,
  username TEXT,
  display_name TEXT,
  total_points NUMERIC,
  winner_correct INTEGER,
  spread_correct INTEGER,
  total_correct INTEGER,
  games_picked INTEGER,
  rank INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    wp.user_id,
    p.username,
    p.display_name,
    wp.total_points,
    wp.winner_correct,
    wp.spread_correct,
    wp.total_correct,
    wp.games_picked,
    ROW_NUMBER() OVER (ORDER BY wp.total_points DESC, wp.games_picked DESC)::INTEGER AS rank
  FROM weekly_points wp
  LEFT JOIN profiles p ON p.user_id = wp.user_id
  WHERE wp.league_code = p_league_code
    AND wp.week = p_week
    AND wp.season = p_season
  ORDER BY wp.total_points DESC, wp.games_picked DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_weekly_leaderboard TO authenticated;


-- ============================================================================
-- 5. AUTOMATION: Recompute on Finalization
-- ============================================================================
-- Automatically recompute weekly points for all affected leagues whenever a
-- game becomes final (is_final = true).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_weekly_points_for_final_game()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_league RECORD;
BEGIN
  -- Only act when the row is final
  IF NEW.is_final IS DISTINCT FROM TRUE THEN
    RETURN NEW;
  END IF;

  -- Recompute for each league that has a pick on this game/week
  FOR v_league IN
    SELECT DISTINCT p.league_code
    FROM picks p
    WHERE p.game_id = NEW.game_id
      AND p.week = NEW.week
  LOOP
    PERFORM compute_weekly_points(v_league.league_code, NEW.week, NEW.season);
  END LOOP;

  RETURN NEW;
END;
$$;

-- Create trigger to fire after insert or when is_final flips to true
DROP TRIGGER IF EXISTS trg_recompute_weekly_points_on_game_final ON game_results;
CREATE TRIGGER trg_recompute_weekly_points_on_game_final
AFTER INSERT OR UPDATE OF is_final ON game_results
FOR EACH ROW
WHEN (NEW.is_final = true)
EXECUTE FUNCTION recompute_weekly_points_for_final_game();


-- ============================================================================
-- USAGE INSTRUCTIONS
-- ============================================================================
-- 
-- 1. Run this entire SQL file in your Supabase SQL Editor
-- 
-- 2. Populate game_results after games finish (via admin script or cron):
--    INSERT INTO game_results (game_id, week, season, home_team, away_team, 
--                               home_score, away_score, winner, 
--                               spread_result, spread_line, 
--                               total_result, total_line, is_final)
--    VALUES ('401671706', 10, 2025, 'KC', 'DEN', 28, 24, 'KC',
--            'home', -7.5, 'under', 47.5, true);
--
-- 3. Compute weekly points for a league:
--    SELECT compute_weekly_points('ABC123', 10, 2025);
--
-- 4. Fetch leaderboard via RPC from client:
--    const { data } = await supabase.rpc('get_weekly_leaderboard', {
--      p_league_code: 'ABC123',
--      p_week: 10,
--      p_season: 2025
--    });
--
-- 5. Query weekly_points directly:
--    SELECT * FROM weekly_points 
--    WHERE league_code = 'ABC123' AND week = 10 
--    ORDER BY total_points DESC;
--
-- ============================================================================
-- 6. DEBUG FUNCTION: Inspect per-pick grading details
-- ============================================================================
-- Returns granular grading breakdown for each pick in a league/week to debug
-- spread/total parsing issues.
-- Call: SELECT * FROM debug_league_week('LEAGUECODE', 11, 2025);
-- ============================================================================
CREATE OR REPLACE FUNCTION debug_league_week(
  p_league_code TEXT,
  p_week INTEGER,
  p_season INTEGER DEFAULT 2025
)
RETURNS TABLE (
  pick_id UUID,
  user_id UUID,
  game_id TEXT,
  home_team TEXT,
  away_team TEXT,
  home_score INTEGER,
  away_score INTEGER,
  winner TEXT,
  raw_locked_spread TEXT,
  parsed_spread_line NUMERIC,
  parsed_fav_side TEXT,
  picked_spread_team TEXT,
  spread_margin INTEGER,
  spread_adjusted NUMERIC,
  spread_outcome TEXT,
  spread_correct BOOLEAN,
  raw_locked_total TEXT,
  parsed_total_line NUMERIC,
  total_points_scored INTEGER,
  picked_total_dir TEXT,
  total_outcome TEXT,
  total_correct BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_league RECORD;
  v_pick RECORD;
  v_result RECORD;
  v_locked JSONB;
  v_spread_str TEXT;
  v_total_str TEXT;
  v_line_spread NUMERIC;
  v_fav_side TEXT;
  v_line_total NUMERIC;
  v_margin INTEGER;
  v_home_line NUMERIC;
  v_adjusted NUMERIC;
  v_tot_points INTEGER;
  v_picked_team TEXT;
  v_picked_total_dir TEXT;
BEGIN
  SELECT * INTO v_league FROM leagues WHERE code = p_league_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League % not found', p_league_code;
  END IF;
  v_locked := v_league.locked_lines;

  FOR v_pick IN
    SELECT * FROM picks
    WHERE league_code = p_league_code
      AND week = p_week
  LOOP
    SELECT * INTO v_result FROM game_results
      WHERE game_id = v_pick.game_id
        AND week = p_week
        AND season = p_season
        AND is_final = true;

    IF NOT FOUND THEN
      CONTINUE; -- skip non-final games
    END IF;

    -- Spread parsing
    v_spread_str := NULL; v_line_spread := NULL; v_fav_side := NULL; v_adjusted := NULL; v_home_line := NULL; v_margin := NULL; v_picked_team := NULL;
    IF v_locked IS NOT NULL THEN
      v_spread_str := v_locked -> (v_pick.game_id)::text ->> 'spread';
    END IF;
    IF v_spread_str IS NOT NULL AND v_spread_str <> 'N/A' THEN
      IF v_spread_str ~ '^[A-Z]{2,4}\s*[-+]?\d' THEN
        DECLARE v_team_token TEXT; DECLARE v_num_token TEXT; BEGIN
          SELECT (regexp_match(v_spread_str, '^[A-Z]{2,4}'))[1] INTO v_team_token;
          SELECT (regexp_match(v_spread_str, '([-+]?\d+(?:\.\d+)?)'))[1] INTO v_num_token;
          IF v_num_token IS NOT NULL THEN v_line_spread := ABS(v_num_token::NUMERIC); END IF;
          IF v_team_token IS NOT NULL THEN
            IF v_num_token LIKE '-%' THEN
              IF v_team_token = v_result.home_team THEN v_fav_side := 'home';
              ELSIF v_team_token = v_result.away_team THEN v_fav_side := 'away'; END IF;
            ELSIF v_num_token LIKE '+%' THEN
              IF v_team_token = v_result.home_team THEN v_fav_side := 'away';
              ELSIF v_team_token = v_result.away_team THEN v_fav_side := 'home'; END IF;
            ELSE
              IF v_team_token = v_result.home_team THEN v_fav_side := 'home';
              ELSIF v_team_token = v_result.away_team THEN v_fav_side := 'away'; END IF;
            END IF;
          END IF;
        END;
      ELSE
        SELECT (regexp_match(v_spread_str, '([-+]?\d+(?:\.\d+)?)'))[1]::NUMERIC INTO v_line_spread;
        IF v_line_spread IS NOT NULL THEN
          IF v_spread_str LIKE '-%' THEN v_fav_side := 'home'; v_line_spread := ABS(v_line_spread);
          ELSIF v_spread_str LIKE '+%' THEN v_fav_side := 'away'; v_line_spread := ABS(v_line_spread);
          END IF;
        END IF;
      END IF;
    END IF;
    -- Fallback to stored scoreboard line
    IF (v_line_spread IS NULL OR v_fav_side IS NULL) AND v_result.spread_line IS NOT NULL THEN
      v_line_spread := ABS(v_result.spread_line);
      IF v_result.spread_line < 0 THEN v_fav_side := 'home';
      ELSIF v_result.spread_line > 0 THEN v_fav_side := 'away'; END IF;
    END IF;
    IF v_pick.spread IS NOT NULL THEN
      v_picked_team := COALESCE( (regexp_match(v_pick.spread, '^[A-Za-z]{2,4}'))[1], v_pick.spread );
    END IF;
    IF v_line_spread IS NOT NULL AND v_fav_side IS NOT NULL THEN
      v_margin := v_result.home_score - v_result.away_score;
      v_home_line := CASE WHEN v_fav_side = 'home' THEN -v_line_spread ELSE v_line_spread END;
      v_adjusted := v_margin + v_home_line;
    END IF;
    -- Spread outcome & correctness
    DECLARE v_spread_outcome TEXT; DECLARE v_spread_correct BOOLEAN; BEGIN
      IF v_adjusted IS NULL THEN v_spread_outcome := 'ungraded'; v_spread_correct := NULL;
      ELSIF v_adjusted = 0 THEN v_spread_outcome := 'push'; v_spread_correct := NULL;
      ELSIF v_adjusted > 0 THEN v_spread_outcome := 'home_covered'; v_spread_correct := (v_picked_team = v_result.home_team);
      ELSE v_spread_outcome := 'away_covered'; v_spread_correct := (v_picked_team = v_result.away_team); END IF;
    END;

    -- Total parsing
    v_total_str := NULL; v_line_total := NULL; v_tot_points := NULL; v_picked_total_dir := NULL;
    IF v_locked IS NOT NULL THEN
      v_total_str := v_locked -> (v_pick.game_id)::text ->> 'overUnder';
    END IF;
    IF v_total_str IS NOT NULL AND v_total_str <> 'N/A' THEN
      SELECT (regexp_match(v_total_str, '\\d+(?:\\.\\d+)?'))[1]::NUMERIC INTO v_line_total;
    END IF;
    IF v_line_total IS NULL AND v_result.total_line IS NOT NULL THEN
      v_line_total := v_result.total_line;
    END IF;
    IF v_line_total IS NOT NULL THEN
      v_tot_points := v_result.home_score + v_result.away_score;
    END IF;
    IF v_pick.total IS NOT NULL THEN
      v_picked_total_dir := CASE WHEN LOWER(v_pick.total) LIKE 'o%' THEN 'over' WHEN LOWER(v_pick.total) LIKE 'u%' THEN 'under' ELSE LOWER(v_pick.total) END;
    END IF;
    DECLARE v_total_outcome TEXT; DECLARE v_total_correct BOOLEAN; BEGIN
      IF v_line_total IS NULL THEN v_total_outcome := 'ungraded'; v_total_correct := NULL;
      ELSIF v_tot_points = v_line_total THEN v_total_outcome := 'push'; v_total_correct := NULL;
      ELSIF v_tot_points > v_line_total THEN v_total_outcome := 'over'; v_total_correct := (v_picked_total_dir = 'over');
      ELSE v_total_outcome := 'under'; v_total_correct := (v_picked_total_dir = 'under'); END IF;
    END;

    RETURN NEXT (
      v_pick.id,
      v_pick.user_id,
      v_pick.game_id,
      v_result.home_team,
      v_result.away_team,
      v_result.home_score,
      v_result.away_score,
      v_result.winner,
      v_spread_str,
      v_line_spread,
      v_fav_side,
      v_picked_team,
      v_margin,
      v_adjusted,
      v_spread_outcome,
      v_spread_correct,
      v_total_str,
      v_line_total,
      v_tot_points,
      v_picked_total_dir,
      v_total_outcome,
      v_total_correct
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION debug_league_week TO authenticated;

-- ============================================================================
