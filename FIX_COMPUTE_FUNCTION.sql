-- Fix the compute_weekly_points function to properly cast JSONB to text
-- The issue is on line where we do LOWER(v_pick.total) - need to cast to text first

CREATE OR REPLACE FUNCTION compute_weekly_points(
  p_league_code TEXT,
  p_week INTEGER,
  p_season INTEGER DEFAULT 2025
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
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
  SELECT * INTO v_league FROM leagues WHERE code = p_league_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League % not found', p_league_code;
  END IF;

  v_scoring_weights := COALESCE(v_league.settings->'scoring', '{"winner":1,"spread":1,"total":1}'::jsonb);

  FOR v_user_id IN 
    SELECT UNNEST(v_league.members) AS user_id
  LOOP
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

    FOR v_pick IN
      SELECT * FROM picks
      WHERE league_code = p_league_code
        AND user_id = v_user_id
        AND week = p_week
    LOOP
      v_games_picked := v_games_picked + 1;

      SELECT * INTO v_result FROM game_results
      WHERE game_id = v_pick.game_id AND is_final = true;

      IF NOT FOUND THEN
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
          NULL;
        ELSE
          v_winner_incorrect := v_winner_incorrect + 1;
        END IF;
      END IF;

      -- Grade SPREAD pick
      IF v_pick.spread IS NOT NULL THEN
        DECLARE picked_team TEXT;
        BEGIN
          picked_team := v_pick.spread;
          v_locked := v_league.locked_lines;
          v_spread_str := NULL;
          IF v_locked IS NOT NULL THEN
            v_spread_str := COALESCE( (v_locked -> (v_pick.game_id)::text ->> 'spread'), NULL );
          END IF;

          v_line_spread := NULL;
          v_fav_side := NULL;
          IF v_spread_str IS NOT NULL THEN
            SELECT (regexp_match(v_spread_str, '[-+]?\\d+(?:\\.\\d+)?'))[1]::NUMERIC INTO v_line_spread;
            IF v_spread_str ILIKE '%'||v_result.home_team||'%' THEN
              v_fav_side := 'home';
            ELSIF v_spread_str ILIKE '%'||v_result.away_team||'%' THEN
              v_fav_side := 'away';
            END IF;
          END IF;

          IF v_line_spread IS NULL AND v_result.spread_line IS NOT NULL THEN
            v_line_spread := ABS(v_result.spread_line);
            v_fav_side := CASE WHEN v_result.spread_line < 0 THEN 'home' ELSE 'away' END;
          END IF;

          IF v_line_spread IS NULL THEN
            v_is_complete := false;
          ELSE
            v_margin := v_result.home_score - v_result.away_score;
            v_home_line := CASE WHEN v_fav_side = 'home' THEN -v_line_spread ELSE v_line_spread END;

            IF (v_margin + v_home_line) = 0 THEN
              v_spread_push := v_spread_push + 1;
            ELSIF (v_margin + v_home_line) > 0 THEN
              IF picked_team = v_result.home_team THEN
                v_spread_correct := v_spread_correct + 1;
                v_total_points := v_total_points + (v_scoring_weights->>'spread')::NUMERIC;
              ELSE
                v_spread_incorrect := v_spread_incorrect + 1;
              END IF;
            ELSE
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

      -- Grade TOTAL pick (FIXED: cast to text before LOWER)
      IF v_pick.total IS NOT NULL THEN
        DECLARE picked_direction TEXT;
        BEGIN
          picked_direction := LOWER((v_pick.total)::text);

          v_total_str := NULL;
          IF v_league.locked_lines IS NOT NULL THEN
            v_total_str := COALESCE( (v_league.locked_lines -> (v_pick.game_id)::text ->> 'overUnder'), NULL );
          END IF;
          v_line_total := NULL;
          IF v_total_str IS NOT NULL THEN
            SELECT (regexp_match(v_total_str, '\\d+(?:\\.\\d+)?'))[1]::NUMERIC INTO v_line_total;
          END IF;
          IF v_line_total IS NULL THEN
            v_line_total := v_result.total_line;
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

    INSERT INTO weekly_points (
      user_id, league_code, week, season, 
      total_points, 
      winner_correct, winner_incorrect,
      spread_correct, spread_incorrect, spread_push,
      total_correct, total_incorrect, total_push,
      games_picked, games_graded, is_complete,
      scoring_weights
    )
    VALUES (
      v_user_id, p_league_code, p_week, p_season, 
      v_total_points,
      v_winner_correct, v_winner_incorrect,
      v_spread_correct, v_spread_incorrect, v_spread_push,
      v_total_correct, v_total_incorrect, v_total_push,
      v_games_picked, v_games_graded, v_is_complete,
      v_scoring_weights
    )
    ON CONFLICT (user_id, league_code, week, season)
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
      updated_at = NOW();

    v_computed_count := v_computed_count + 1;
  END LOOP;

  RETURN v_computed_count;
END;
$$;
