# 📊 ERROR & METRICS LOGGING GUIDE

## Overview

This app includes a comprehensive client-side logging system that tracks errors, warnings, info messages, and metrics. Logs are batched and sent to Supabase for analysis and monitoring.

---

## 🔧 Setup

### 1. Run the Database Migration

Execute `LOGGING_MIGRATION.sql` in your Supabase SQL Editor to create the `client_logs` table with proper indexes and RLS policies.

```sql
-- Creates client_logs table with:
-- - user_id, log_type, category, message, details, stack_trace
-- - Indexes for fast queries
-- - RLS policies (users can only see their own logs)
```

### 2. Integration (Already Complete)

The logging system is already integrated into `App.js`:
- `initLogging()` called on app start
- `shutdownLogging()` called on logout (flushes pending logs)
- Critical operations wrapped with error logging

---

## 📝 Usage

### Import the Logger

```javascript
import { 
  logError, 
  logWarning, 
  logInfo, 
  logMetric, 
  withErrorLogging, 
  withMetrics,
  ErrorCategory 
} from './logger';
```

### Log an Error

```javascript
try {
  await someDangerousOperation();
} catch (error) {
  await logError(
    ErrorCategory.PICK_SAVE,
    'Failed to save pick',
    error
  );
  // Show user-friendly message
  Alert.alert('Error', 'Could not save your pick');
}
```

### Log a Warning

```javascript
if (gameIsLocked) {
  await logWarning(
    ErrorCategory.PICK_SAVE,
    'Attempted to save pick for locked game',
    { gameId, userId }
  );
}
```

### Log Info Message

```javascript
await logInfo(
  ErrorCategory.AUTH,
  'User logged in successfully',
  { userId, method: 'email' }
);
```

### Log a Metric

```javascript
await logMetric(
  ErrorCategory.PICK_SAVE,
  'Pick save duration',
  { 
    duration: 150, // milliseconds
    success: true,
    gameId 
  }
);
```

### Wrap Operations with Error Logging

```javascript
const result = await withErrorLogging(
  ErrorCategory.DATA_FETCH,
  async () => {
    return await fetchLeagueData(leagueCode);
  },
  'Failed to fetch league data'
);

if (!result) {
  // Operation failed, error was automatically logged
  Alert.alert('Error', 'Could not load league');
}
```

### Wrap Operations with Performance Metrics

```javascript
const result = await withMetrics(
  ErrorCategory.DATA_FETCH,
  'Fetch league data',
  async () => {
    return await fetchLeagueData(leagueCode);
  }
);

// Automatically logs duration and success/failure
```

---

## 🏷️ Error Categories

Use these predefined categories for consistency:

```javascript
ErrorCategory.PICK_SAVE       // Pick saving operations
ErrorCategory.AUTH            // Authentication (login, logout, signup)
ErrorCategory.NETWORK         // Network requests
ErrorCategory.REALTIME        // Real-time subscriptions
ErrorCategory.NOTIFICATION    // Push notifications
ErrorCategory.ACHIEVEMENT     // Achievement unlocking
ErrorCategory.LEAGUE          // League operations
ErrorCategory.FRIEND          // Friend requests
ErrorCategory.OFFLINE_QUEUE   // Offline queue processing
ErrorCategory.DATA_FETCH      // Data loading
ErrorCategory.UI              // UI rendering errors
ErrorCategory.UNKNOWN         // Uncategorized
```

---

## 🔍 Log Types

### `error`
Critical failures that prevent functionality.

**Example:**
```javascript
await logError(ErrorCategory.PICK_SAVE, 'Pick save failed', error);
```

### `warning`
Non-critical issues that may indicate problems.

**Example:**
```javascript
await logWarning(ErrorCategory.LEAGUE, 'User attempted to join full league', { leagueCode });
```

### `info`
Informational messages for tracking user flows.

**Example:**
```javascript
await logInfo(ErrorCategory.AUTH, 'User completed onboarding', { userId });
```

### `metric`
Performance and usage metrics.

**Example:**
```javascript
await logMetric(ErrorCategory.NETWORK, 'API response time', { 
  endpoint: '/leagues',
  duration: 234,
  status: 200 
});
```

---

## ⚙️ Configuration

Located in `logger.js`:

```javascript
const CONFIG = {
  enableSupabaseLogging: true,    // Toggle remote logging
  enableConsoleLogging: __DEV__,  // Console.log in dev only
  batchSize: 10,                  // Send logs in batches
  flushInterval: 30000,           // Flush every 30 seconds
  maxRetries: 3,
  retryDelay: 2000,
};
```

### Toggle Logging Off

```javascript
// In logger.js
enableSupabaseLogging: false  // Disables remote logging completely
```

---

## 📊 Viewing Logs

### In Supabase Dashboard

1. Go to **Database** → **client_logs** table
2. Filter by `user_id`, `log_type`, `category`, or date range
3. Inspect `details` JSON column for context
4. View `stack_trace` for errors

### Query Examples

**Recent errors:**
```sql
SELECT * FROM client_logs 
WHERE log_type = 'error' 
ORDER BY created_at DESC 
LIMIT 50;
```

**Pick save failures:**
```sql
SELECT * FROM client_logs 
WHERE category = 'pick_save' AND log_type = 'error'
ORDER BY created_at DESC;
```

**User's error history:**
```sql
SELECT * FROM client_logs 
WHERE user_id = 'user-uuid-here' AND log_type = 'error'
ORDER BY created_at DESC;
```

**Performance metrics:**
```sql
SELECT 
  category, 
  message,
  AVG((details->>'duration')::numeric) as avg_duration,
  COUNT(*) as total_calls
FROM client_logs 
WHERE log_type = 'metric'
GROUP BY category, message
ORDER BY avg_duration DESC;
```

---

## 🧪 Testing

### Test Logging Locally

```javascript
// Force an error and check if it logs
try {
  throw new Error('Test error');
} catch (error) {
  await logError(ErrorCategory.UNKNOWN, 'Test error log', error);
}
```

### Flush Logs Manually

```javascript
import { flushLogs } from './logger';

// Force immediate flush (useful for testing)
await flushLogs();
```

### Check Queue Size

```javascript
// In logger.js, logQueue.length shows pending logs
console.log('Pending logs:', logQueue.length);
```

---

## 🛡️ Privacy & Security

### What Gets Logged

✅ **Logged:**
- Error messages and stack traces
- User IDs (for RLS filtering)
- Performance metrics (duration, success/failure)
- Operation context (league codes, game IDs, week numbers)
- Platform info (iOS/Android, app version)

❌ **NOT Logged:**
- Passwords or sensitive credentials
- Full pick data (only metadata like gameId, leagueCode)
- Personal identifiable information beyond user ID
- Third-party API keys

### Row Level Security

- Users can only view their own logs
- Logs are automatically associated with authenticated user
- Optional admin policy (commented out in migration)

---

## 📈 Monitoring Best Practices

### 1. Set Up Alerts

Create alerts for critical errors:

```sql
-- Example: Alert when >10 pick save errors in 1 hour
SELECT COUNT(*) FROM client_logs 
WHERE category = 'pick_save' 
  AND log_type = 'error' 
  AND created_at > NOW() - INTERVAL '1 hour';
```

### 2. Regular Cleanup

Delete old logs to save space:

```sql
DELETE FROM client_logs 
WHERE created_at < NOW() - INTERVAL '30 days';
```

Schedule this as a Supabase cron job or manual cleanup.

### 3. Track Key Metrics

Monitor:
- Error rate by category
- Pick save success rate
- Authentication failures
- Network request durations
- Real-time subscription stability

---

## 🔌 Integration Points

Logging is already integrated in:

### App.js
- ✅ App initialization (`initLogging()`)
- ✅ User login/logout
- ✅ Pick saving (success & failure)
- ✅ Real-time subscription errors
- ✅ Shutdown on logout (`shutdownLogging()`)

### Where to Add More Logging

**League Operations:**
```javascript
// In createLeague()
await logInfo(ErrorCategory.LEAGUE, 'League created', { leagueCode, type });
```

**Friend Requests:**
```javascript
// In sendFriendRequest()
await logInfo(ErrorCategory.FRIEND, 'Friend request sent', { recipientId });
```

**Achievements:**
```javascript
// In unlockAchievement()
await logMetric(ErrorCategory.ACHIEVEMENT, 'Achievement unlocked', { achievementKey });
```

**Offline Queue:**
```javascript
// In processOfflineQueue()
await logInfo(ErrorCategory.OFFLINE_QUEUE, 'Queue processed', { 
  successCount, 
  failureCount 
});
```

---

## 🚀 Advanced Usage

### Custom Categories

Add your own categories:

```javascript
// In logger.js, add to ErrorCategory object
export const ErrorCategory = {
  // ... existing categories
  CUSTOM_FEATURE: 'custom_feature',
};
```

### Batch Operations

Logging automatically batches:
- Logs queue in memory
- Flush every 30 seconds OR when batch size (10) reached
- Manual flush with `flushLogs()`

### Network Awareness

Logging handles offline scenarios:
- Failed log sends are re-queued
- Max 3 retries per batch
- Silent failures (won't break app)

---

## 🐛 Troubleshooting

### Logs Not Appearing in Supabase

1. **Check migration ran successfully:**
   ```sql
   SELECT * FROM client_logs LIMIT 1;
   ```

2. **Check RLS policies:**
   ```sql
   SELECT * FROM pg_policies WHERE tablename = 'client_logs';
   ```

3. **Check console for errors:**
   ```javascript
   // In logger.js, temporarily enable console logging
   enableConsoleLogging: true
   ```

4. **Manually flush:**
   ```javascript
   import { flushLogs } from './logger';
   await flushLogs();
   ```

### Too Many Logs

Reduce log volume:
- Increase `flushInterval` (e.g., 60000 for 1 minute)
- Increase `batchSize` (e.g., 20)
- Disable logging for non-critical operations
- Add conditional logging (e.g., only log errors)

### Performance Impact

Logging is designed to be lightweight:
- Asynchronous (non-blocking)
- Batched (reduces network calls)
- Configurable (disable in production if needed)

---

## 📋 Summary

- **Setup:** Run `LOGGING_MIGRATION.sql` in Supabase
- **Usage:** Import and call `logError()`, `logWarning()`, `logInfo()`, `logMetric()`
- **Categories:** Use `ErrorCategory` constants for consistency
- **Batching:** Automatic batching with 30-second flush interval
- **Privacy:** RLS ensures users only see their own logs
- **Monitoring:** Query `client_logs` table for insights

**Next Steps:**
1. Run `LOGGING_MIGRATION.sql`
2. Test logging with a sample error
3. View logs in Supabase Dashboard
4. Add logging to custom features as needed
