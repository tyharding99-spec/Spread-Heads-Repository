# Real-time Subscriptions Guide

## Overview

The app now uses Supabase real-time channels to provide live updates when data changes. Users see picks, league settings, and member changes instantly without refreshing.

---

## Features

### 🎯 Silent Background Updates
- **Picks updates**: When anyone makes a pick, standings refresh automatically
- **No notification spam**: Updates happen silently in the background
- **Seamless UX**: Users see live data without manual refresh

### 🔔 Commissioner Notifications
- **Settings changes**: Users notified when commissioner updates league settings
- **Member changes**: Notifications when members join or leave the league
- **Friend requests**: Instant notifications for incoming friend requests

---

## How It Works

### Subscription Lifecycle

1. **Subscribe on Login**: When user logs in and leagues load, the app automatically subscribes to:
   - Pick changes for each league
   - League settings changes
   - Member add/remove events
   - Friend requests

2. **Background Updates**: When Supabase detects a change:
   - Callback function fires immediately
   - App reloads relevant data from database
   - UI updates automatically via React state
   - Push notification sent (if applicable)

3. **Cleanup on Logout**: When user logs out or app closes:
   - All subscriptions unsubscribed
   - No memory leaks or ghost listeners

### Technical Architecture

```javascript
// Example: Subscribe to picks in a league
const cleanup = subscribeToLeaguePicks(leagueCode, async (payload) => {
  // 1. Supabase detects INSERT/UPDATE/DELETE in picks table
  // 2. This callback fires immediately
  // 3. Reload picks from database
  // 4. Update React state -> UI refreshes
});

// Cleanup function removes subscription
cleanup();
```

---

## Subscribed Events

### 1. League Picks (`league:{code}:picks`)

**Table**: `picks`  
**Events**: INSERT, UPDATE, DELETE  
**Filter**: `league_code=eq.{leagueCode}`

**Behavior**:
- Reloads all picks for the league
- Updates standings/leaderboard in real-time
- No push notification sent (silent update)

**Use Cases**:
- User A makes a pick → User B sees updated pick count immediately
- User edits their pick → Others see the change live
- Commissioner removes a pick → Reflected instantly

---

### 2. League Settings (`league:{code}:settings`)

**Table**: `leagues`  
**Events**: UPDATE  
**Filter**: `league_code=eq.{leagueCode}`

**Behavior**:
- Reloads league data (name, lock time, scoring weights, etc.)
- Updates UI with new settings
- **Sends push notification** to all members except commissioner

**Notification**:
```
⚙️ League Settings Updated
The commissioner has updated settings for "Tyler's League".
```

**Use Cases**:
- Commissioner changes league name → All members see new name + get notified
- Lock time adjusted → All members see update
- Scoring weights modified → Reflected in all member views

---

### 3. League Members (`league:{code}:members`)

**Table**: `league_members`  
**Events**: INSERT (join), DELETE (leave)  
**Filter**: `league_code=eq.{leagueCode}`

**Behavior**:
- Reloads league member list
- Updates standings with new member
- **Sends push notification** to existing members (not the joiner/leaver themselves)

**Notifications**:
```
👤 New League Member
john_smith has joined "Tyler's League".

👋 Member Left League
jane_doe has left "Tyler's League".
```

**Use Cases**:
- New user joins via invite code → Everyone sees them in standings + gets notified
- User leaves league → Removed from all member views
- Commissioner removes user → Reflected immediately

---

### 4. Friend Requests (`user:{userId}:friend_requests`)

**Table**: `friend_requests`  
**Events**: INSERT (new request), UPDATE (accepted)  
**Filter**: `receiver_id=eq.{userId}` or `sender_id=eq.{userId}`

**Behavior**:
- Triggers callback for new requests or acceptances
- Push notification handled in `FriendsScreen.js` integration
- No automatic UI refresh (handled per screen)

**Use Cases**:
- User sends you a friend request → Instant notification
- Someone accepts your request → You're notified immediately

---

## Subscription Management

### When Subscriptions Are Created

**Trigger**: `useEffect` in `App.js` after leagues are loaded

```javascript
useEffect(() => {
  if (!currentUser?.id || !leagues || leagues.length === 0) {
    return;
  }

  // Subscribe to all leagues
  leagues.forEach(league => {
    subscribeToLeaguePicks(league.code, handlePicksChanged);
    subscribeToLeagueSettings(league.code, handleSettingsChanged, true);
    subscribeToLeagueMembers(league.code, currentUser.id, handleMembersChanged, true);
  });

  // Subscribe to friend requests
  subscribeToFriendRequests(currentUser.id, handleFriendRequest);

  // Cleanup on unmount
  return () => unsubscribeAll();
}, [currentUser?.id, leagues?.length]);
```

### When Subscriptions Are Removed

1. **User logs out**: `handleLogout()` calls `unsubscribeAll()`
2. **Component unmounts**: Cleanup function in `useEffect` runs
3. **League list changes**: Old subscriptions cleaned up, new ones created

### Active Subscription Tracking

All active channels tracked in `activeChannels` Map in `supabaseRealtime.js`:
- Prevents duplicate subscriptions
- Enables bulk cleanup
- Allows subscription count monitoring

```javascript
import { getActiveSubscriptionCount } from './supabaseRealtime';
console.log(`Active subscriptions: ${getActiveSubscriptionCount()}`);
```

---

## Notification Preferences

Users can control real-time notifications in **Profile → Notifications**:

- **League Settings Changes**: Toggle in settings (future enhancement)
- **Member Join/Leave**: Toggle in settings (future enhancement)
- **Master switch**: `enabled: false` disables all notifications (silent updates continue)

**Current behavior**: Commissioner notifications always enabled, silent updates always active.

---

## Performance Considerations

### Bandwidth
- Subscriptions use WebSocket connection (minimal overhead)
- Only changed data transmitted
- Efficient for real-time apps

### Database Load
- Each subscription = 1 database listener
- User with 5 leagues = ~15 subscriptions (picks + settings + members per league)
- Supabase handles thousands of concurrent subscriptions

### Battery Impact
- WebSocket maintained while app is foregrounded
- Subscriptions automatically pause when app backgrounds
- Re-subscribe on app focus

---

## Troubleshooting

### Subscriptions Not Working

**Symptom**: Changes in database don't appear in UI

**Checks**:
1. Verify user is logged in: `currentUser?.id` exists
2. Check leagues loaded: `leagues.length > 0`
3. Check console for subscription logs: `[Realtime] Subscribed to...`
4. Verify Supabase Realtime enabled in project settings

**Debug**:
```javascript
import { getActiveSubscriptionCount } from './supabaseRealtime';
console.log(`Active subs: ${getActiveSubscriptionCount()}`);
```

### Duplicate Subscriptions

**Symptom**: Callbacks fire multiple times for one change

**Cause**: Multiple subscriptions to same channel

**Fix**: Automatic - `subscribeToLeaguePicks()` unsubscribes existing before creating new

### Notifications Not Appearing

**Symptom**: Silent updates work but no push notifications

**Checks**:
1. Verify notification permissions granted
2. Check notification prefs: `enabled: true`
3. Ensure commissioner is not receiving own change notifications (filtered out)

---

## Future Enhancements

### Server-Side Push
Currently local notifications only. Future:
- Save push tokens to `profiles` table
- Supabase database webhook triggers server-side push
- Works even when app is closed

### Granular Notification Controls
Add user preferences:
- Toggle commissioner notifications on/off
- Toggle member change notifications on/off
- Per-league notification settings

### Presence Indicators
Show who's currently online:
- Green dot next to active users
- "User is making picks now..." indicator
- Last seen timestamps

### Typing Indicators (Chat)
When chat feature added:
- "User is typing..." in league chat
- Real-time message delivery

---

## API Reference

See `supabaseRealtime.js` for full API documentation:

- `subscribeToLeaguePicks(leagueCode, callback)` - Returns cleanup function
- `subscribeToLeagueSettings(leagueCode, callback, notifyUser)` - Returns cleanup function
- `subscribeToLeagueMembers(leagueCode, userId, callback, notifyUser)` - Returns cleanup function
- `subscribeToFriendRequests(userId, callback)` - Returns cleanup function
- `unsubscribeAll()` - Removes all active subscriptions
- `getActiveSubscriptionCount()` - Returns number of active subscriptions

---

## Testing

### Manual Testing

1. **Picks Update**:
   - Open app on two devices with same league
   - Device A makes a pick
   - Device B should see pick count update within 1-2 seconds

2. **Settings Change**:
   - Device A (commissioner) changes league name
   - Device B should see new name + receive notification

3. **Member Join**:
   - Device A creates league and shares code
   - Device B joins via code
   - Device A should see new member + receive notification

### Automated Testing

Future enhancement: Add unit tests for subscription callbacks

```javascript
// Test example
test('League picks subscription updates state', async () => {
  const callback = jest.fn();
  const cleanup = subscribeToLeaguePicks('TEST123', callback);
  
  // Simulate database change
  await insertPick({ league_code: 'TEST123', user_id: 'user1', game_id: 'game1' });
  
  await waitFor(() => {
    expect(callback).toHaveBeenCalled();
  });
  
  cleanup();
});
```

---

## Best Practices

1. **Always cleanup subscriptions**: Return cleanup function from `useEffect`
2. **Filter self-actions**: Don't notify user about their own changes
3. **Debounce rapid changes**: If many picks made quickly, batch UI updates
4. **Handle errors gracefully**: Failed callback shouldn't crash app
5. **Log subscription lifecycle**: Use console.log for debugging

---

## Related Documentation

- [NOTIFICATIONS_GUIDE.md](./NOTIFICATIONS_GUIDE.md) - Push notification system
- [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) - Database tables and RLS policies
- [Supabase Realtime Docs](https://supabase.com/docs/guides/realtime) - Official Supabase guide
