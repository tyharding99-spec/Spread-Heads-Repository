# Populate Game Results Edge Function

Automatically fetches final scores from ESPN and populates the `game_results` table, which triggers automatic scoring computation.

## Deployment

```bash
supabase functions deploy populate-game-results
```

## Usage

### Manual Trigger (for testing)
```bash
curl -X POST "https://YOUR_PROJECT.supabase.co/functions/v1/populate-game-results" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

### With Specific Week
```bash
curl -X POST "https://YOUR_PROJECT.supabase.co/functions/v1/populate-game-results?week=11&season=2025" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

### Automated Schedule (Recommended)

#### Option 1: Supabase Cron (pg_cron)
Run SQL in Supabase SQL Editor:

```sql
-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule function to run every hour on game days (Thursday, Sunday, Monday)
-- Runs at :00 of each hour from 1pm-11pm ET on Sunday/Monday, 8pm-11pm ET on Thursday
SELECT cron.schedule(
  'populate-nfl-results-sunday',
  '0 18-4 * * 0', -- Sunday 1pm-11pm ET (18:00-04:00 UTC next day)
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT.supabase.co/functions/v1/populate-game-results',
    headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'populate-nfl-results-monday',
  '0 1-4 * * 1', -- Monday 8pm-11pm ET (01:00-04:00 UTC Tuesday)
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT.supabase.co/functions/v1/populate-game-results',
    headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'populate-nfl-results-thursday',
  '0 1-4 * * 5', -- Thursday 8pm-11pm ET (01:00-04:00 UTC Friday)
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT.supabase.co/functions/v1/populate-game-results',
    headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
  ) AS request_id;
  $$
);
```

#### Option 2: External Cron (GitHub Actions, etc.)
Create `.github/workflows/populate-results.yml`:

```yaml
name: Populate Game Results
on:
  schedule:
    # Sunday 1pm-11pm ET hourly
    - cron: '0 18-23 * * 0'
    - cron: '0 0-4 * * 1'
    # Monday 8pm-11pm ET hourly
    - cron: '0 1-4 * * 2'
    # Thursday 8pm-11pm ET hourly
    - cron: '0 1-4 * * 5'
  workflow_dispatch: # Manual trigger

jobs:
  populate:
    runs-on: ubuntu-latest
    steps:
      - name: Call Edge Function
        run: |
          curl -X POST "${{ secrets.SUPABASE_URL }}/functions/v1/populate-game-results" \
            -H "Authorization: Bearer ${{ secrets.SUPABASE_ANON_KEY }}"
```

## How It Works

1. Edge Function fetches ESPN scoreboard for current week (or specified week)
2. Filters for games with `STATUS_FINAL` or `STATUS_FULL_TIME`
3. Computes spread and total results based on final scores
4. Upserts into `game_results` with `is_final = true`
5. **Database trigger automatically fires**: `trg_recompute_weekly_points_on_game_final`
6. Trigger calls `compute_weekly_points(league_code, week)` for every league with picks on that game
7. `weekly_points` table updates with computed scores
8. UI fetches from `weekly_points` and displays updated scores—no user action needed

## Response Format

```json
{
  "success": true,
  "week": 11,
  "season": 2025,
  "inserted": 14,
  "updated": 0,
  "errors": 0,
  "processed": [
    {
      "gameId": "401671706",
      "away": "DEN",
      "home": "KC",
      "score": "24-28"
    }
  ]
}
```

## Testing

1. Deploy the function
2. Wait for games to finish (or use a past week for testing)
3. Call manually:
   ```bash
   curl -X POST "https://YOUR_PROJECT.supabase.co/functions/v1/populate-game-results?week=10" \
     -H "Authorization: Bearer YOUR_ANON_KEY"
   ```
4. Check `game_results` table in Supabase:
   ```sql
   SELECT * FROM game_results WHERE week = 10 AND is_final = true;
   ```
5. Check `weekly_points` was computed:
   ```sql
   SELECT * FROM weekly_points WHERE week = 10;
   ```
6. Open app → Weekly Results → Select Week 10 → Should show "⚡ Server-computed scores"

## Monitoring

View function logs in Supabase Dashboard → Edge Functions → populate-game-results → Logs

Check cron job status:
```sql
SELECT * FROM cron.job;
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
```
