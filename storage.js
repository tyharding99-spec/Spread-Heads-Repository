// storage.js
// Small storage wrapper for Expo/React Native projects.
// Uses @react-native-async-storage/async-storage when available,
// and falls back to an in-memory store so the app won't crash
// if the native module isn't installed yet.

let AsyncStorage = null;
try {
  // try require so this file doesn't hard-fail if the package isn't installed
  // Metro bundler supports require; the try/catch prevents crashes in dev
  AsyncStorage = require('@react-native-async-storage/async-storage').default;
} catch (e) {
  AsyncStorage = null;
}

const memoryStore = Object.create(null);

async function setItem(key, value) {
  if (AsyncStorage) {
    return AsyncStorage.setItem(key, value);
  }
  memoryStore[key] = value;
  return Promise.resolve();
}

async function getItem(key) {
  if (AsyncStorage) {
    return AsyncStorage.getItem(key);
  }
  return Promise.resolve(Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null);
}

async function removeItem(key) {
  if (AsyncStorage) {
    return AsyncStorage.removeItem(key);
  }
  delete memoryStore[key];
  return Promise.resolve();
}

async function setJSON(key, obj) {
  try {
    const s = JSON.stringify(obj);
    return setItem(key, s);
  } catch (e) {
    return Promise.reject(e);
  }
}

async function getJSON(key, fallback = null) {
  const v = await getItem(key);
  if (v == null) return fallback;
  try {
    return JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

// Convenience keys and helpers for this app
const LEAGUES_KEY = 'myapp:leagues:v1';
const PICKS_KEY = 'myapp:userPicks:v1';
const RESULTS_KEY = 'myapp:results:v1';
const FRIENDS_KEY = 'myapp:friends:v1';

export async function saveLeagues(leagues) {
  return setJSON(LEAGUES_KEY, leagues || []);
}

export async function loadLeagues() {
  return getJSON(LEAGUES_KEY, []);
}

export async function saveUserPicks(picks) {
  return setJSON(PICKS_KEY, picks || {});
}

export async function loadUserPicks() {
  return getJSON(PICKS_KEY, {});
}

export async function saveResults(results) {
  return setJSON(RESULTS_KEY, results || {});
}

export async function loadResults() {
  return getJSON(RESULTS_KEY, {});
}

// Merge helper to upsert new final results by gameId
export async function mergeResults(newResults) {
  try {
    const existing = await loadResults();
    const merged = { ...existing, ...newResults };
    await saveResults(merged);
    return merged;
  } catch (e) {
    return Promise.reject(e);
  }
}

export async function saveFriends(userId, friendsData) {
  return setJSON(`${FRIENDS_KEY}:${userId}`, friendsData || { friends: [], requests: [], isPublic: true });
}

export async function loadFriends(userId) {
  return getJSON(`${FRIENDS_KEY}:${userId}`, { friends: [], requests: [], isPublic: true });
}

export { setItem, getItem, removeItem, setJSON, getJSON };

export const hasNativeStorage = !!AsyncStorage;

export default {
  setItem,
  getItem,
  removeItem,
  setJSON,
  getJSON,
  saveLeagues,
  loadLeagues,
  saveUserPicks,
  loadUserPicks,
  saveResults,
  loadResults,
  mergeResults,
  saveFriends,
  loadFriends,
  hasNativeStorage,
};
