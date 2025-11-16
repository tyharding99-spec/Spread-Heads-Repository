# Push Notifications Guide

## Overview

The app now supports comprehensive push notifications for game reminders and social events. Notifications are managed through `expo-notifications` with user-configurable preferences.

---

## Notification Types

### 🏈 Game Reminders
Automatically scheduled when games are loaded for the week. **One notification per league per time interval** (not per-game).

**Three reminder intervals:**
- **24 hours** before first game: 📅 "Picks Closing Soon"
- **4 hours** before first game: ⏰ "Picks Closing Soon"
- **1 hour** before first game: 🚨 "Picks Closing Soon"

**Example notification:**
```
Title: 🚨 Picks Closing Soon
Body: Your picks for Tyler's League close in 1 hour for the 8:15 PM games.
```

**Scheduling:**
- Happens automatically when week games are loaded in `App.js`
- Uses `scheduleWeeklyGameReminders(leagues, prefs)` function
- Sends ONE notification per league per time interval
- Based on the earliest game time for the week
- Skips reminders that are in the past
- Each reminder is de-duplicated by league code and interval

---

### 🔒 Line Lock Notifications
Alerts when spreads and totals are locked (before picks can still be made).

**When:** Based on league settings `lockOffsetMinutes` (default 60 minutes before kickoff)

**Example notification:**
```
Title: 🔒 Lines Locked
Body: Philadelphia Eagles @ Kansas City Chiefs: Spreads and totals are now locked.
```

**Scheduling:**
- Automatically scheduled per game when games load
- Respects league-specific lock offset settings
- Can be disabled in notification preferences

---

### 👋 Friend Request Received
Immediate notification when someone sends you a friend request.

**Example notification:**
```
Title: 👋 Friend Request
Body: john_smith sent you a friend request!
```

**Trigger:** When another user sends you a friend request via search

---

### ✅ Friend Request Accepted
Immediate notification when someone accepts your friend request.

**Example notification:**
```
Title: ✅ Friend Request Accepted
Body: jane_doe accepted your friend request!
```

**Trigger:** When your friend request is accepted

---

### 🏈 League Invite
Notification when you're invited to join a league.

**Example notification:**
```
Title: 🏈 League Invite
Body: mike_jones invited you to join "Sunday Showdown"!
```

**Trigger:** When a league admin sends you an invite

---

### 🏆 Achievement Unlocked
Celebration notification when you unlock an achievement.

**Example notification:**
```
Title: 🏆 Hot Streak
Body: You've won 5 picks in a row!
```

**Trigger:** When achievement criteria met (currently manual, future: automatic)

---

### 🏁 Week Start
Notification when a new week begins (Thursday night kickoff).

**Example notification:**
```
Title: 🏁 Week 11 Has Begun!
Body: Time to make your picks for Week 11. Good luck!
```

**Trigger:** Can be scheduled for Thursday at kickoff time

---

### ⚙️ League Settings Changed
Notification when commissioner updates league settings.

**Example notification:**
```
Title: ⚙️ League Settings Updated
Body: The commissioner has updated settings for "Tyler's League".
```

**Trigger:** Real-time when commissioner modifies league settings (name, lock time, scoring weights, etc.)

---

### 👤 Member Added to League
Notification when someone joins your league.

**Example notification:**
```
Title: 👤 New League Member
Body: john_smith has joined "Tyler's League".
```

**Trigger:** Real-time when a new member joins the league (not sent for self-join)

---

### 👋 Member Left League
Notification when someone leaves your league.

**Example notification:**
```
Title: 👋 Member Left League
Body: jane_doe has left "Tyler's League".
```

**Trigger:** Real-time when a member leaves or is removed from the league (not sent for self-leave)

---

### 🏁 Week Start
Notification when a new week begins (Thursday night kickoff).

**Example notification:**
```
Title: 🏁 Week 11 Has Begun!
Body: Time to make your picks for Week 11. Good luck!
```

**Trigger:** Can be scheduled for Thursday at kickoff time

---

## User Preferences

Users can configure notification settings in the **Profile → Notifications** screen.

### Accessing Settings
1. Open the app
2. Tap the **Profile** tab (bottom navigation)
3. Scroll to **Settings** section
4. Tap **🔔 Notifications**
5. Customize your preferences

### Available Settings

```javascript
{
  enabled: true,                // Master switch for all notifications
  gameReminders: true,          // Enable game reminder notifications
  gameReminder24h: true,        // 24h before first game
  gameReminder4h: true,         // 4h before first game  
  gameReminder1h: true,         // 1h before first game
  weeklyResults: true,          // Weekly results summary (Monday mornings)
  chatMentions: true,           // @mentions in chat (future)
  chatMessages: false,          // All chat messages (future)
  lineLocks: true,              // Line lock notifications
  lineLockTime: 15,             // Minutes before lock (unused, uses league setting)
  achievements: true,           // Achievement unlocks
  leagueInvites: true,          // League invitations
  weekStart: true,              // New week starting
  soundEnabled: true,           // Notification sound
  vibrationEnabled: true,       // Vibration pattern
}
```

**Storage:** Persisted in `AsyncStorage` under key `notifications:prefs`

**Individual Interval Controls:**
Users can now disable specific reminder intervals while keeping others enabled:
- **Enable only 1h reminder:** `{ gameReminders: true, gameReminder24h: false, gameReminder4h: false, gameReminder1h: true }`
- **Disable all reminders:** `{ gameReminders: false }` (overrides individual interval settings)
- **Enable all intervals:** All three interval flags default to `true` when `gameReminders` is enabled

**Access:**
```javascript
import { getNotificationPrefs, setNotificationPrefs } from './notificationPrefs';

const prefs = await getNotificationPrefs();
// Disable only the 24h reminders
await setNotificationPrefs({ ...prefs, gameReminder24h: false });
```

---

## Functions Reference

### Core Functions (`notifications.js`)

#### `registerForPushNotificationsAsync()`
Requests notification permissions and gets Expo push token.

**Returns:**
```javascript
{ granted: boolean, token: string | null }
```

**Usage:**
```javascript
const { granted, token } = await registerForPushNotificationsAsync();
if (granted && token) {
  // Save token to user profile for server-side push
}
```

---

#### `scheduleLocalNotification({ title, body, date })`
Schedules a single local notification.

**Parameters:**
- `title` (string): Notification title
- `body` (string): Notification body text
- `date` (Date): When to fire the notification

**Returns:** Notification ID (string) or null if failed

**Usage:**
```javascript
const id = await scheduleLocalNotification({
  title: '⏰ Reminder',
  body: 'Make your picks!',
  date: new Date(Date.now() + 3600000), // 1 hour from now
});
```

---

#### `scheduleWeeklyGameReminders(games, prefs)`
Schedules 24h/4h/1h reminders for all games in the week.

**Parameters:**
- `leagues` (Array): Array of league objects with `league_name`, `league_code`, and `games` array
- `prefs` (object): User notification preferences

**Returns:**
```javascript
{ totalScheduled: number, totalSkipped: number }
```

**Usage:**
```javascript
// Attach games to leagues for notification scheduling
const leaguesWithGames = leagues.map(league => ({
  league_name: league.league_name,
  league_code: league.league_code,
  games: parsedGames
}));

const { totalScheduled, totalSkipped } = await scheduleWeeklyGameReminders(
  leaguesWithGames, 
  notificationPrefs
);
console.log(`Scheduled ${totalScheduled} reminders, skipped ${totalSkipped}`);
```

**Behavior:**
- Skips if `prefs.enabled` or `prefs.gameReminders` is false
- Sends ONE notification per league per time interval (24h, 4h, 1h)
- Based on earliest game time for the week
- Skips past reminders (won't schedule 24h reminder if first game is in 23h)
- De-duplicates by key `leagueGameReminder:{leagueCode}:{interval}h`
- Each league can have up to 3 reminders total per week

---

#### `scheduleGameReminders(games, leagueName, leagueCode, prefs)`
Schedules reminders for a single league based on earliest game time.

**Parameters:**
- `games` (Array): Array of game objects with `date` property
- `leagueName` (string): Display name of the league
- `leagueCode` (string): Unique league identifier
- `prefs` (object): User notification preferences

**Returns:**
```javascript
{ scheduled: number, skipped: number }
```

**Usage:**
```javascript
const result = await scheduleGameReminders(
  league.games, 
  'Tyler\'s League',
  '4AU78W',
  prefs
);
// result = { scheduled: 3, skipped: 0 } if all 3 reminders scheduled
```

---

#### `scheduleLineLockNotificationIfNeeded(game, lockDate)`
Schedules line lock notification for a game.

**Parameters:**
- `game` (object): Game object with `id`, `awayTeam`, `homeTeam`
- `lockDate` (Date): When lines lock

**Returns:** boolean (true if scheduled)

**Usage:**
```javascript
const lockTime = new Date(gameStartTime.getTime() - 60 * 60 * 1000); // 1hr before
await scheduleLineLockNotificationIfNeeded(game, lockTime);
```

---

### Social Notification Functions

#### `notifyFriendRequest(senderUsername)`
Triggers immediate friend request notification.

**Parameters:**
- `senderUsername` (string): Username of person who sent request

**Returns:** boolean

**Usage:**
```javascript
await notifyFriendRequest('john_smith');
```

---

#### `notifyFriendRequestAccepted(accepterUsername)`
Triggers immediate friend request accepted notification.

**Parameters:**
- `accepterUsername` (string): Username of person who accepted

**Returns:** boolean

**Usage:**
```javascript
await notifyFriendRequestAccepted('jane_doe');
```

---

#### `notifyLeagueInvite(leagueName, inviterUsername)`
Triggers league invitation notification.

**Parameters:**
- `leagueName` (string): Name of the league
- `inviterUsername` (string): Username of inviter

**Returns:** boolean

**Usage:**
```javascript
await notifyLeagueInvite('Sunday Showdown', 'mike_jones');
```

---

#### `notifyAchievement(achievementName, achievementDescription)`
Triggers achievement unlocked notification.

**Parameters:**
- `achievementName` (string): Title of achievement
- `achievementDescription` (string): Description

**Returns:** boolean

**Usage:**
```javascript
await notifyAchievement('Hot Streak', "You've won 5 picks in a row!");
```

---

#### `notifyWeekStart(weekNumber)`
Triggers new week starting notification.

**Parameters:**
- `weekNumber` (number): Week number

**Returns:** boolean

**Usage:**
```javascript
await notifyWeekStart(11);
```

---

### Utility Functions

#### `scheduleUniqueNotification(key, { title, body, date })`
Schedules a notification only once per unique key.

**Parameters:**
- `key` (string): Unique identifier for this notification
- `title`, `body`, `date`: Notification details

**Returns:** boolean (true if scheduled, false if already scheduled)

**Usage:**
```javascript
const scheduled = await scheduleUniqueNotification('weekly-reminder', {
  title: 'Weekly Recap',
  body: 'Check your results!',
  date: nextMonday,
});
```

**Storage:** Tracks scheduled notifications in `AsyncStorage` under `notifications:once:{key}`

---

#### `cancelAllNotifications()`
Cancels all scheduled notifications.

**Usage:**
```javascript
await cancelAllNotifications();
```

---

#### `scheduleWeeklyResultsReminderIfNeeded()`
Schedules Monday morning results reminder (if not already scheduled).

**Returns:** boolean

**Usage:**
```javascript
const scheduled = await scheduleWeeklyResultsReminderIfNeeded();
```

---

## Integration Points

### App.js

**On startup (useEffect):**
```javascript
// Request notification permissions
const res = await registerForPushNotificationsAsync();
if (res.granted && res.token) {
  setPushToken(res.token);
  // TODO: Save token to user profile in Supabase for server-side push
}
```

**When games load (fetchGames):**
```javascript
// Schedule game reminders
const { totalScheduled, totalSkipped } = await scheduleWeeklyGameReminders(
  parsedGames, 
  notificationPrefs
);
console.log(`[Notifications] Scheduled ${totalScheduled} game reminders`);

// Schedule line lock notifications
for (const game of parsedGames) {
  const lockTime = new Date(startTime.getTime() - lockOffsetMinutes * 60 * 1000);
  await scheduleLineLockNotificationIfNeeded(game, lockTime);
}
```

---

### FriendsScreen.js

**When sending friend request:**
```javascript
await createFriendRequest(recipientId);
await notifyFriendRequest(currentUser?.username);
```

**When accepting friend request:**
```javascript
await acceptFriendRequest(requestId);
await notifyFriendRequestAccepted(currentUser?.username);
```

---

## Current Limitations & Future Enhancements

### Current Limitations

1. **Local notifications only**
   - Notifications are scheduled locally on the device
   - User must have app installed and permissions granted
   - No remote push (can't notify user on a different device)

2. **Social notifications are immediate, not async**
   - Friend request notifications fire immediately (1 second delay)
   - In production, should use server-side push to notify recipient's device

3. **No server-side push token storage**
   - Push tokens are obtained but not persisted in Supabase
   - Can't send remote notifications yet

4. **Game reminders don't check if user has picked**
   - Sends all 3 reminders regardless of whether user has made picks
   - Future: skip reminders if user has already picked that game

---

### Future Enhancements

#### 1. Server-Side Push Notifications
Store Expo push tokens in Supabase and use server-side push service.

**Implementation:**
```javascript
// Save token to profiles table
await supabase
  .from('profiles')
  .update({ push_token: token, push_token_updated_at: new Date() })
  .eq('user_id', currentUser.id);
```

**Server-side push:**
```javascript
// Supabase Edge Function or cron job
const { Expo } = require('expo-server-sdk');
const expo = new Expo();

const messages = [];
for (const user of usersToNotify) {
  if (!Expo.isExpoPushToken(user.push_token)) continue;
  messages.push({
    to: user.push_token,
    sound: 'default',
    title: '👋 Friend Request',
    body: `${sender} sent you a friend request!`,
    data: { type: 'friend_request', requestId: request.id },
  });
}

const chunks = expo.chunkPushNotifications(messages);
for (const chunk of chunks) {
  await expo.sendPushNotificationsAsync(chunk);
}
```

---

#### 2. Smart Game Reminders
Skip reminders if user has already made picks for that game.

**Implementation:**
```javascript
// In scheduleGameReminders():
const userPick = league?.picks?.[userId]?.[game.id];
const hasCompletePick = userPick?.spread || userPick?.total || userPick?.winner;
if (hasCompletePick) {
  // Skip this game's reminders
  continue;
}
```

---

#### 3. Notification History
Track sent notifications for analytics and debugging.

**DB Table:**
```sql
CREATE TABLE notification_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id),
  type TEXT NOT NULL, -- 'game_reminder', 'friend_request', etc.
  title TEXT,
  body TEXT,
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivery_status TEXT, -- 'scheduled', 'sent', 'failed'
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

#### 4. Notification Action Buttons
Add interactive actions to notifications.

**Example:**
```javascript
await scheduleLocalNotification({
  title: '🚨 Game Starting Soon',
  body: 'Eagles @ Chiefs in 1 hour',
  date: reminderTime,
  categoryIdentifier: 'game_reminder',
  // iOS: Quick actions
  ios: {
    _displayInForeground: true,
    categoryId: 'game_reminder',
    // User can tap "Make Picks" to deep link directly to PicksScreen
  },
});
```

---

#### 5. Notification Grouping
Group related notifications (e.g., all game reminders for a day).

**iOS:**
```javascript
threadId: 'game-reminders-week-11',
```

**Android:**
```javascript
channelId: 'game-reminders',
```

---

#### 6. Weekly Results Automation
Automatically compute and send weekly results every Monday morning.

**Implementation:**
- Supabase cron job runs Monday 9:00 AM
- Calls `compute_weekly_points()` for all active leagues
- Sends push notification to all league members with their rank/points

---

## Testing

### Test Game Reminders

```javascript
// Create a test game 30 minutes in the future
const testGame = {
  id: 'test123',
  awayTeam: 'Test Away',
  homeTeam: 'Test Home',
  date: new Date(Date.now() + 30 * 60 * 1000), // 30 min from now
};

const prefs = { enabled: true, gameReminders: true };
const result = await scheduleGameReminders(testGame, prefs);
console.log(result); // { scheduled: 1, skipped: 2 } (only 1h reminder is in future)
```

---

### Test Friend Request Notification

```javascript
await notifyFriendRequest('test_user');
// Should see notification immediately (1 second delay)
```

---

### Check Scheduled Notifications

```javascript
import * as Notifications from 'expo-notifications';

const scheduled = await Notifications.getAllScheduledNotificationsAsync();
console.log('Scheduled notifications:', scheduled.length);
console.log(scheduled.map(n => ({
  id: n.identifier,
  title: n.content.title,
  date: n.trigger.value,
})));
```

---

### Cancel All Notifications

```javascript
import { cancelAllNotifications } from './notifications';

await cancelAllNotifications();
console.log('All notifications cancelled');
```

---

## Troubleshooting

### Notifications not appearing

**iOS:**
1. Check Settings > Notifications > [Your App]
2. Ensure "Allow Notifications" is ON
3. Check banner style is set to "Temporary" or "Persistent"

**Android:**
1. Check Settings > Apps > [Your App] > Notifications
2. Ensure notifications are enabled
3. Check "Default" channel is enabled

**Code check:**
```javascript
const { status } = await Notifications.getPermissionsAsync();
console.log('Notification permission status:', status);
// Should be 'granted'
```

---

### Notifications scheduled but not firing

**Check trigger date:**
```javascript
const scheduled = await Notifications.getAllScheduledNotificationsAsync();
scheduled.forEach(n => {
  const triggerDate = new Date(n.trigger.value);
  console.log(`${n.content.title} scheduled for ${triggerDate.toLocaleString()}`);
  if (triggerDate < new Date()) {
    console.warn('⚠️ Trigger date is in the past!');
  }
});
```

---

### Duplicate notifications

**Check storage keys:**
```javascript
// List all notification keys
import AsyncStorage from '@react-native-async-storage/async-storage';

const keys = await AsyncStorage.getAllKeys();
const notifKeys = keys.filter(k => k.startsWith('notifications:once:'));
console.log('Unique notification keys:', notifKeys);

// Clear all to reset
for (const key of notifKeys) {
  await AsyncStorage.removeItem(key);
}
```

---

## Best Practices

1. **Always check preferences before scheduling**
   ```javascript
   const prefs = await getNotificationPrefs();
   if (!prefs.enabled || !prefs.gameReminders) return;
   ```

2. **Handle permission denials gracefully**
   ```javascript
   const { granted } = await registerForPushNotificationsAsync();
   if (!granted) {
     // Show onboarding explaining why notifications are useful
   }
   ```

3. **Use de-duplication for recurring schedules**
   ```javascript
   // Use scheduleUniqueNotification to prevent duplicates
   await scheduleUniqueNotification(`game:${gameId}:1h`, {...});
   ```

4. **Schedule notifications in batches**
   ```javascript
   // Better: schedule all at once
   await scheduleWeeklyGameReminders(games, prefs);
   
   // Avoid: individual scheduling in loops
   // for (const game of games) { await schedule... }
   ```

5. **Log notification activity**
   ```javascript
   console.log(`[Notifications] Scheduled ${count} reminders`);
   ```

---

## Summary

The notification system provides comprehensive coverage for:
- **Game reminders** (24h/4h/1h before kickoff)
- **Line lock alerts** (when spreads/totals freeze)
- **Social events** (friend requests, league invites)
- **Achievements** (unlocks and milestones)
- **Weekly events** (new week, results recap)

All notifications respect user preferences and can be toggled on/off. The system uses local scheduling with de-duplication to prevent spam. Future enhancements will add server-side push for cross-device notifications and smarter targeting based on user activity.
