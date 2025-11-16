// notifications.js
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Global handler: how notifications are displayed when app is foregrounded
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function registerForPushNotificationsAsync() {
  let status = (await Notifications.getPermissionsAsync()).status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return { granted: false };

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  try {
    const token = await Notifications.getExpoPushTokenAsync();
    return { granted: true, token: token.data };
  } catch (e) {
    return { granted: true, token: null };
  }
}

export async function scheduleLocalNotification({ title, body, date }) {
  try {
    const trigger = date instanceof Date ? date : new Date(date);
    if (isNaN(trigger.getTime())) return null;
    if (trigger.getTime() <= Date.now()) return null; // past date
    const id = await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger,
    });
    return id;
  } catch (e) {
    return null;
  }
}

export async function cancelAllNotifications() {
  try { await Notifications.cancelAllScheduledNotificationsAsync(); } catch {}
}

// Schedule a weekly results reminder for next Monday at 9:00 AM if not already scheduled
export async function scheduleWeeklyResultsReminderIfNeeded() {
  try {
    const key = 'notifications:weeklyResultsScheduled';
    const flag = await AsyncStorage.getItem(key);
    if (flag === '1') return false;

    const now = new Date();
    const next = new Date(now);
    // Set to next Monday 9:00 AM local time
    const day = now.getDay(); // 0=Sun, 1=Mon...
    const daysUntilMonday = (8 - day) % 7 || 7; // ensure at least next week
    next.setDate(now.getDate() + daysUntilMonday);
    next.setHours(9, 0, 0, 0);

    const id = await scheduleLocalNotification({
      title: '🏁 Weekly Results',
      body: 'Results are in! Check your weekly performance and standings.',
      date: next,
    });

    if (id) {
      await AsyncStorage.setItem(key, '1');
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Schedule a notification only once per unique key
export async function scheduleUniqueNotification(key, { title, body, date }) {
  try {
    const storageKey = `notifications:once:${key}`;
    const existing = await AsyncStorage.getItem(storageKey);
    if (existing === '1') return false;
    const id = await scheduleLocalNotification({ title, body, date });
    if (id) {
      await AsyncStorage.setItem(storageKey, '1');
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Helper to schedule a line lock notification for a given game and lock datetime
export async function scheduleLineLockNotificationIfNeeded(game, lockDate) {
  try {
    if (!lockDate || !(lockDate instanceof Date)) return false;
    if (isNaN(lockDate.getTime())) return false;
    if (lockDate.getTime() <= Date.now()) return false;

    const key = `lock:${game?.id}:${lockDate.toISOString()}`;
    const title = '🔒 Lines Locked';
    const body = `${game?.awayTeam} @ ${game?.homeTeam}: Spreads and totals are now locked.`;
    return await scheduleUniqueNotification(key, { title, body, date: lockDate });
  } catch (e) {
    return false;
  }
}

/**
 * Schedule game reminder notifications (24h, 4h, 1h before kickoff)
 * Now sends ONE notification per league per time window instead of per-game
 * @param {Array} games - Array of game objects with id, awayTeam, homeTeam, date
 * @param {string} leagueName - Name of the league
 * @param {string} leagueCode - League code for de-duplication
 * @param {object} prefs - Notification preferences
 * @returns {Promise<{scheduled: number, skipped: number}>}
 */
export async function scheduleGameReminders(games, leagueName, leagueCode, prefs) {
  const results = { scheduled: 0, skipped: 0 };
  
  try {
    if (!prefs?.enabled || !prefs?.gameReminders) {
      results.skipped = 3;
      return results;
    }
    
    if (!games || games.length === 0) {
      results.skipped = 3;
      return results;
    }
    
    // Find the earliest game time (first kickoff of the week)
    const sortedGames = [...games].sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      return dateA.getTime() - dateB.getTime();
    });
    
    const firstGame = sortedGames[0];
    const gameDate = new Date(firstGame.date);
    
    if (isNaN(gameDate.getTime())) {
      results.skipped = 3;
      return results;
    }
    
    const now = Date.now();
    const reminderIntervals = [
      { hours: 24, emoji: '📅', label: '24 hours', prefKey: 'gameReminder24h' },
      { hours: 4, emoji: '⏰', label: '4 hours', prefKey: 'gameReminder4h' },
      { hours: 1, emoji: '🚨', label: '1 hour', prefKey: 'gameReminder1h' },
    ];
    
    // Format game time for notification (e.g., "8:15 PM")
    const gameTimeStr = gameDate.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
    
    for (const interval of reminderIntervals) {
      // Check if this specific interval is enabled
      if (prefs[interval.prefKey] === false) {
        results.skipped++;
        continue;
      }
      
      const reminderTime = new Date(gameDate.getTime() - (interval.hours * 60 * 60 * 1000));
      
      if (reminderTime.getTime() > now) {
        const key = `leagueGameReminder:${leagueCode}:${interval.hours}h`;
        const title = `${interval.emoji} Picks Closing Soon`;
        const body = `Your picks for ${leagueName} close in ${interval.label} for the ${gameTimeStr} games.`;
        
        const scheduled = await scheduleUniqueNotification(key, {
          title,
          body,
          date: reminderTime,
        });
        
        if (scheduled) {
          results.scheduled++;
        } else {
          results.skipped++;
        }
      } else {
        results.skipped++;
      }
    }
    
    return results;
  } catch (e) {
    console.warn('Failed to schedule game reminders:', e);
    return results;
  }
}

/**
 * Schedule reminders for all leagues in the current week
 * Sends ONE notification per league per interval instead of per-game
 * @param {Array} leagues - Array of league objects with games
 * @param {object} prefs - Notification preferences
 * @returns {Promise<{totalScheduled: number, totalSkipped: number}>}
 */
export async function scheduleWeeklyGameReminders(leagues, prefs) {
  const totals = { totalScheduled: 0, totalSkipped: 0 };
  
  try {
    if (!leagues || !Array.isArray(leagues) || leagues.length === 0) {
      return totals;
    }
    
    for (const league of leagues) {
      if (!league.games || league.games.length === 0) {
        continue;
      }
      
      const leagueName = league.league_name || league.name || 'Your League';
      const leagueCode = league.league_code || league.code;
      
      const result = await scheduleGameReminders(league.games, leagueName, leagueCode, prefs);
      totals.totalScheduled += result.scheduled;
      totals.totalSkipped += result.skipped;
    }
    
    return totals;
  } catch (e) {
    console.warn('Failed to schedule weekly game reminders:', e);
    return totals;
  }
}

/**
 * Schedule notification for friend request received
 * @param {string} senderUsername - Username of person who sent request
 * @returns {Promise<boolean>}
 */
export async function notifyFriendRequest(senderUsername) {
  try {
    return await scheduleLocalNotification({
      title: '👋 Friend Request',
      body: `${senderUsername} sent you a friend request!`,
      date: new Date(Date.now() + 1000), // 1 second delay for immediate notification
    });
  } catch (e) {
    console.warn('Failed to notify friend request:', e);
    return false;
  }
}

/**
 * Schedule notification for friend request accepted
 * @param {string} accepterUsername - Username of person who accepted
 * @returns {Promise<boolean>}
 */
export async function notifyFriendRequestAccepted(accepterUsername) {
  try {
    return await scheduleLocalNotification({
      title: '✅ Friend Request Accepted',
      body: `${accepterUsername} accepted your friend request!`,
      date: new Date(Date.now() + 1000),
    });
  } catch (e) {
    console.warn('Failed to notify friend accepted:', e);
    return false;
  }
}

/**
 * Schedule notification for league invite received
 * @param {string} leagueName - Name of the league
 * @param {string} inviterUsername - Username of person who invited
 * @returns {Promise<boolean>}
 */
export async function notifyLeagueInvite(leagueName, inviterUsername) {
  try {
    return await scheduleLocalNotification({
      title: '🏈 League Invite',
      body: `${inviterUsername} invited you to join "${leagueName}"!`,
      date: new Date(Date.now() + 1000),
    });
  } catch (e) {
    console.warn('Failed to notify league invite:', e);
    return false;
  }
}

/**
 * Schedule notification for achievement unlocked
 * @param {string} achievementName - Name of achievement
 * @param {string} achievementDescription - Description
 * @returns {Promise<boolean>}
 */
export async function notifyAchievement(achievementName, achievementDescription) {
  try {
    return await scheduleLocalNotification({
      title: `🏆 ${achievementName}`,
      body: achievementDescription,
      date: new Date(Date.now() + 1000),
    });
  } catch (e) {
    console.warn('Failed to notify achievement:', e);
    return false;
  }
}

/**
 * Schedule notification for new week starting
 * @param {number} weekNumber - Week number
 * @returns {Promise<boolean>}
 */
export async function notifyWeekStart(weekNumber) {
  try {
    return await scheduleLocalNotification({
      title: `🏁 Week ${weekNumber} Has Begun!`,
      body: `Time to make your picks for Week ${weekNumber}. Good luck!`,
      date: new Date(Date.now() + 1000),
    });
  } catch (e) {
    console.warn('Failed to notify week start:', e);
    return false;
  }
}

/**
 * Notify when league settings are changed by commissioner
 * @param {string} leagueName - Name of the league
 * @returns {Promise<boolean>}
 */
export async function notifyLeagueSettingsChanged(leagueName) {
  try {
    return await scheduleLocalNotification({
      title: '⚙️ League Settings Updated',
      body: `The commissioner has updated settings for "${leagueName}".`,
      date: new Date(Date.now() + 1000),
    });
  } catch (e) {
    console.warn('Failed to notify league settings change:', e);
    return false;
  }
}

/**
 * Notify when a member is added to the league
 * @param {string} username - Username of new member
 * @param {string} leagueName - Name of the league
 * @returns {Promise<boolean>}
 */
export async function notifyMemberAdded(username, leagueName) {
  try {
    return await scheduleLocalNotification({
      title: '👤 New League Member',
      body: `${username} has joined "${leagueName}".`,
      date: new Date(Date.now() + 1000),
    });
  } catch (e) {
    console.warn('Failed to notify member added:', e);
    return false;
  }
}

/**
 * Notify when a member is removed from the league
 * @param {string} username - Username of removed member
 * @param {string} leagueName - Name of the league
 * @returns {Promise<boolean>}
 */
export async function notifyMemberRemoved(username, leagueName) {
  try {
    return await scheduleLocalNotification({
      title: '👋 Member Left League',
      body: `${username} has left "${leagueName}".`,
      date: new Date(Date.now() + 1000),
    });
  } catch (e) {
    console.warn('Failed to notify member removed:', e);
    return false;
  }
}
