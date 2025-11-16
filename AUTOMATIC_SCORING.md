# Automatic Scoring System

## How It Works

The app automatically scores games **the moment they become final** - no delays, no manual steps, no scheduled jobs required.

### The Flow

1. **User opens app** → Scoreboard screen fetches ESPN API
2. **ESPN returns game status** → Shows "Final" for completed games
3. **App detects finals** → `const finals = parsedGames.filter(g => g.isFinal)`
4. **Edge function populate** → POST to `/functions/v1/populate-game-results?week=<week>&season=<season>` (service role)
5. **Database trigger fires** → `trg_recompute_weekly_points_on_game_final`
6. **Scoring computes** → `compute_weekly_points(league_code, week)` for all affected leagues
7. **UI updates** → Weekly Results shows ⚡ server-computed scores

**Result:** The same fetch that shows "Final" on the scoreboard also triggers the scoring. Zero delay.

## Why This Is Better

### Before (Edge Function + Cron)
- Required deploying Edge Function to Supabase
- Required configuring pg_cron or GitHub Actions
- Scoring delayed until next cron run (up to 1 hour)
- Added complexity and potential points of failure

### Now (Integrated in App)
- No deployment needed - already in the app code
- Scoring happens instantly when anyone opens the app
- Works automatically for all users
- Leverages existing ESPN scoreboard fetch
- Idempotent upserts prevent duplicates

## Code Location

**App.js** (Scoreboard final game handling excerpt):
```javascript
const finals = parsedGames.filter(g => g.isFinal);
if (finals.length) {
  const toMerge = finals.reduce((acc, g) => { /* cache */ return acc; }, {});
  await mergeResults(toMerge);
  console.log(`[App] Detected ${finals.length} final games → edge populate-game-results`);
  const url = `${SUPABASE_URL}/functions/v1/populate-game-results?week=${currentWeek}&season=2025`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (res.ok) {
    const payload = await res.json();
    console.log(`[GameResults] Edge populate success: inserted=${payload.inserted} errors=${payload.errors}`);
  } else {
    console.warn('[GameResults] Edge populate failed:', res.status, await res.text());
  }
}
```

`populateFinalGames` now kept only for manual/debug use and is no longer called in the normal scoreboard flow.

## Testing

1. **Before games start:**
   - Make picks in any league
   - Verify picks saved (check database `picks` table)

2. **During games:**
   - Scoreboard shows "In Progress" or "Final"
   - Console logs show detection and scoring

3. **After games finish:**
   - Open app (triggers scoring if not already done)
   - Check console:
     ```
     [App] Detected 3 final games, populating game_results...
     [GameResults] ✓ KC 24 @ BUF 21 (W: home, T: over)
     [App] ✓ Scored 3 games automatically
     ```
   - Open Weekly Results → Select week
   - See ⚡ badge and correct scores

## Edge Function (Primary Path)

The Edge Function at `supabase/functions/populate-game-results/` is now the primary writer to `game_results` using the service role (bypasses RLS safely). The app triggers it when it detects new finals. Optional cron/webhook can be added for redundancy if you want guaranteed coverage when no users open the app.

## Database Schema

**game_results** (service-role populated via edge function):
- `game_id` (PK): ESPN event ID
- `is_final`: When TRUE, trigger fires and computes `weekly_points`
- Final `home_score`, `away_score`, `winner`
- Optional `spread_line`, `total_line` stored for fallback if a league missed locking lines
- League outcomes (spread/total) are derived per league at scoring time using `leagues.locked_lines`

**weekly_points** table (cached scores):
- `user_id`, `league_code`, `week`, `season` (composite PK)
- `total_points`, `correct_picks`, `incorrect_picks`, `push_picks`
- Updated automatically by database trigger

## Pick Format

Picks are normalized before saving to ensure consistent grading:
- **Spread/Winner:** Team abbreviation (e.g., "KC", "BUF")
- **Total:** Lowercase string ("over" or "under")

Edge function ensures consistent abbreviation usage and avoids client RLS issues.
