# Scoring Debug Guide

## Issues Fixed (Build 1.0.9)

### 1. Spread Highlighting Not Working in League Picks
**Problem:** Master Picks saves team abbreviations (e.g., "KC"), but league pick buttons only compared against full team names (e.g., "Kansas City Chiefs"), so spread buttons didn't highlight green.

**Fix:** Added `awayAbbr` and `homeAbbr` to game objects in `App.js` `fetchNFLGames`:
```javascript
awayAbbr: away.team.abbreviation || away.team.displayName,
homeAbbr: home.team.abbreviation || home.team.displayName,
```

Now button highlights check both:
```javascript
(userPick?.spread === game.awayTeam || userPick?.spread === game.awayAbbr)
```

**Result:** Spread buttons now highlight correctly after using Master Picks.

---

### 2. Scoring Not Updating Automatically
**Problem:** Server-side scoring requires `game_results` table to have final scores with `is_final = true`. Without results, the trigger can't fire and `weekly_points` stays empty.

**Fix:** Created `supabaseGameResults.js` with:
- `populateGameResults(week, season)` - Fetches ESPN scoreboard and inserts final scores into `game_results`
- `populateCurrentWeek()` - Auto-detects current week and populates
- `checkGameResults(week, season)` - Diagnostic to see how many results exist

Added debug buttons in `WeeklyResultsScreen.js` (visible in dev mode):
- **Check Results** - Shows count of game results in DB
- **Populate Results** - Fetches ESPN finals and triggers automatic scoring

**How It Works:**
1. Games finish on ESPN
2. Call `populateGameResults(week)` (manually via debug button or via cron/edge function)
3. Game results inserted with `is_final = true`
4. DB trigger `trg_recompute_weekly_points_on_game_final` fires automatically
5. Calls `compute_weekly_points(league_code, week)` for every league with picks on that game
6. `weekly_points` table updates with computed scores per user/league
7. UI fetches from `weekly_points` and displays automatically

**Result:** Scoring updates automatically once game results are populated.

---

## Testing Workflow

### Before Games (Thursday night)
1. Open Master Picks
2. Make picks across moneyline, spread, O/U for selected games
3. Submit to all leagues
4. Verify:
   - All leagues show picks in their pick screens
   - Spread buttons highlight green ✓
   - Over/Under buttons highlight green ✓

### After Games Finish (Automatic)
1. Edge Function runs hourly on game days (Thu/Sun/Mon)
2. Fetches ESPN scoreboard for current week
3. Inserts final scores into `game_results` with `is_final = true`
4. DB trigger automatically fires: `trg_recompute_weekly_points_on_game_final`
5. Calls `compute_weekly_points(league_code, week)` for every affected league
6. `weekly_points` table updates
7. Open app → Weekly Results → Select week
8. Verify:
   - "⚡ Server-computed scores" badge appears
   - Correct/Incorrect counts match your actual picks vs outcomes
   - Total points calculated correctly
   - League rankings show your position

### Production Setup
**Deploy the Edge Function:**
```bash
cd supabase/functions
supabase functions deploy populate-game-results
```

**Schedule with Supabase Cron (recommended):**
```sql
-- Run hourly on game days
SELECT cron.schedule(
  'populate-nfl-results',
  '0 * * * *', -- Every hour
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT.supabase.co/functions/v1/populate-game-results',
    headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
  ) AS request_id;
  $$
);
```

See `supabase/functions/populate-game-results/README.md` for detailed setup instructions.

---

## Database Tables

### `game_results`
Stores official outcomes per game:
- `game_id` (ESPN event ID)
- `week`, `season`
- `home_team`, `away_team` (abbreviations)
- `home_score`, `away_score`
- `winner` (abbreviation or 'TIE')
- `spread_result` ('home', 'away', 'push')
- `spread_line` (e.g., -3.5)
- `total_result` ('over', 'under', 'push')
- `total_line` (e.g., 47.5)
- `is_final` (boolean) ← triggers scoring when true

### `weekly_points`
Cached per-user per-league weekly scores:
- `league_code`, `user_id`, `week`, `season`
- `total_points`
- `winner_correct`, `winner_incorrect`
- `spread_correct`, `spread_incorrect`, `spread_push`
- `total_correct`, `total_incorrect`, `total_push`
- `games_picked`, `games_graded`, `is_complete`
- `scoring_weights` (snapshot)
- `computed_at`

### Trigger
```sql
CREATE TRIGGER trg_recompute_weekly_points_on_game_final
AFTER INSERT OR UPDATE OF is_final ON game_results
FOR EACH ROW
WHEN (NEW.is_final = true)
EXECUTE FUNCTION recompute_weekly_points_for_final_game();
```

---

## Client API

### Fetch Scores
```javascript
import { fetchWeeklyPoints, fetchWeeklyLeaderboard } from './supabaseResults';

// Get all users' scores for a league/week
const { data, error } = await fetchWeeklyPoints(leagueCode, week);

// Get ranked leaderboard with usernames
const { data, error } = await fetchWeeklyLeaderboard(leagueCode, week);
```

### Populate Results (Admin/Debug)
```javascript
import { populateCurrentWeek, populateGameResults } from './supabaseGameResults';

// Auto-detect week and populate
await populateCurrentWeek();

// Specific week
await populateGameResults(11, 2025);
```

---

## Common Issues

### "Scoring shows 0-0 even though games finished"
- Check: Run "Check Results" button. If 0 finalized, run "Populate Results".
- Cause: `game_results` table empty or `is_final = false`.

### "Spread button doesn't highlight after Master Picks"
- Check: Game objects have `awayAbbr` / `homeAbbr` fields.
- Cause: Missing abbreviations in parsed games (fixed in 1.0.9).

### "Points differ between leagues for same picks"
- Expected: Each league uses its own `locked_lines` for grading.
- If lines differ, spread/total outcomes can differ legitimately.

### "Server-computed badge doesn't show"
- Cause: `weekly_points` table empty for that league/week.
- Fix: Populate game results and wait ~1 sec for trigger to compute.

---

## Future Enhancements

1. **Automatic Results Ingestion**
   - Deploy Edge Function to poll ESPN every hour on game days
   - Insert/update `game_results` as games finalize
   - No manual "Populate Results" needed

2. **Real-Time Score Updates**
   - Subscribe to `weekly_points` changes via Supabase Realtime
   - Show live leaderboard as games finish

3. **Push Notifications**
   - Notify users when their scores update after a game
   - "You went 3-1 in Week 11 and moved to #2 in League ABC!"

4. **Admin Dashboard**
   - Web interface to manually trigger result population
   - View trigger logs and recompute history
   - Bulk operations for past weeks

---

## Contact
For issues or questions about scoring, check:
- `SCORING_MIGRATION.sql` - Database schema and functions
- `supabaseResults.js` - Client scoring helpers
- `supabaseGameResults.js` - Results population
- `WeeklyResultsScreen.js` - UI and debug tools
