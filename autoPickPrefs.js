import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'autopick:prefs';

export const AUTO_PICK_STRATEGIES = {
  FAVORITES: 'favorites', // Pick team with better record
  HOME_TEAMS: 'homeTeams', // Always pick home team
  AWAY_TEAMS: 'awayTeams', // Always pick away team
  SPREAD_FAVORITE: 'spreadFavorite', // Pick team with smallest spread (favorite)
  SPREAD_UNDERDOG: 'spreadUnderdog', // Pick team with largest spread (underdog)
  OVER: 'over', // Always pick over on totals
  UNDER: 'under', // Always pick under on totals
  RANDOM: 'random', // Random selection
};

export const defaultAutoPickPrefs = {
  enabled: false, // Auto-pick disabled by default
  spreadStrategy: AUTO_PICK_STRATEGIES.FAVORITES, // Strategy for spread picks
  totalStrategy: AUTO_PICK_STRATEGIES.OVER, // Strategy for total picks
  notifyOnAutoPick: true, // Send notification when auto-picks are made
  onlyWhenMissing: true, // Only auto-pick if user hasn't made picks
  applyToAllLeagues: true, // Apply to all leagues or per-league
  excludedLeagues: [], // League codes to exclude from auto-pick
};

export async function getAutoPickPrefs() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...defaultAutoPickPrefs };
    const parsed = JSON.parse(raw);
    return { ...defaultAutoPickPrefs, ...parsed };
  } catch (e) {
    console.warn('Failed to load auto-pick prefs:', e);
    return { ...defaultAutoPickPrefs };
  }
}

export async function setAutoPickPrefs(prefs) {
  try {
    const merged = { ...defaultAutoPickPrefs, ...(prefs || {}) };
    await AsyncStorage.setItem(KEY, JSON.stringify(merged));
    return merged;
  } catch (e) {
    console.warn('Failed to save auto-pick prefs:', e);
    return { ...defaultAutoPickPrefs };
  }
}

/**
 * Get the strategy display name for UI
 */
export const getStrategyDisplayName = (strategy) => {
  const names = {
    favorites: 'Favorites (Better Record)',
    homeTeams: 'Always Home Team',
    awayTeams: 'Always Away Team',
    spreadFavorite: 'Spread Favorite',
    spreadUnderdog: 'Spread Underdog',
    over: 'Always Over',
    under: 'Always Under',
    random: 'Random',
  };
  return names[strategy] || 'Favorites';
};

/**
 * Get the strategy description for UI
 */
export const getStrategyDescription = (strategy) => {
  const descriptions = {
    favorites: 'Picks the team with the better win-loss record',
    homeTeams: 'Always picks the home team to cover the spread',
    awayTeams: 'Always picks the away team to cover the spread',
    spreadFavorite: 'Picks the favorite (smallest spread number)',
    spreadUnderdog: 'Picks the underdog (largest spread number)',
    over: 'Always picks the over on total points',
    under: 'Always picks the under on total points',
    random: 'Randomly selects a pick',
  };
  return descriptions[strategy] || 'Picks the team with the better record';
};
