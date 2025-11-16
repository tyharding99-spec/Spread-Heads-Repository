import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'notifications:prefs';

export const defaultNotificationPrefs = {
  enabled: true,
  gameReminders: true,
  gameReminder24h: true,   // 24 hours before first game
  gameReminder4h: true,    // 4 hours before first game
  gameReminder1h: true,    // 1 hour before first game
  weeklyResults: true,
  chatMentions: true,
  chatMessages: false, // All chat messages (can be noisy)
  lineLocks: true,
  lineLockTime: 15, // minutes before lock
  achievements: true,
  leagueInvites: true,
  weekStart: true, // Notification when new week begins
  soundEnabled: true,
  vibrationEnabled: true,
};

export async function getNotificationPrefs() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...defaultNotificationPrefs };
    const parsed = JSON.parse(raw);
    return { ...defaultNotificationPrefs, ...parsed };
  } catch (e) {
    return { ...defaultNotificationPrefs };
  }
}

export async function setNotificationPrefs(prefs) {
  try {
    const merged = { ...defaultNotificationPrefs, ...(prefs || {}) };
    await AsyncStorage.setItem(KEY, JSON.stringify(merged));
    return merged;
  } catch (e) {
    return { ...defaultNotificationPrefs };
  }
}
