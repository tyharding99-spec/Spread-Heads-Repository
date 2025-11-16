export const LEAGUE_TYPES = {
  INDIVIDUAL: 'individual',
  FREE_FOR_ALL: 'freeForAll',
  SURVIVOR: 'survivor',
  HEAD_TO_HEAD: 'headToHead',
  MONEYLINE_MANIA: 'moneylineMania',
};

export const LEAGUE_TYPE_DETAILS = {
  [LEAGUE_TYPES.INDIVIDUAL]: {
    name: 'Individual',
    description: 'Play solo and track your own picks and performance',
    minPlayers: 1,
    maxPlayers: 1,
    features: ['Personal stats tracking', 'Weekly performance history'],
  },
  [LEAGUE_TYPES.FREE_FOR_ALL]: {
    name: 'Free for All',
    description: 'Everyone competes against each other each week',
    minPlayers: 2,
    maxPlayers: 100,
    features: ['Weekly leaderboard', 'Season-long standings', 'Multiple participants'],
  },
  [LEAGUE_TYPES.SURVIVOR]: {
    name: 'Survivor',
    description: 'Lowest scoring player each week is eliminated until one remains',
    minPlayers: 3,
    maxPlayers: 50,
    features: ['Weekly eliminations', 'Survival tracking', 'Final standings'],
  },
  [LEAGUE_TYPES.HEAD_TO_HEAD]: {
    name: 'Head to Head',
    description: 'Weekly matchups against other players with playoffs',
    minPlayers: 4,
    maxPlayers: 32,
    features: ['Weekly matchups', 'Win-loss records', 'Playoff bracket', 'Championship'],
  },
  [LEAGUE_TYPES.MONEYLINE_MANIA]: {
    name: 'Moneyline Mania',
    description: 'Pick straight-up winners only - no spreads or totals',
    minPlayers: 2,
    maxPlayers: 100,
    features: ['Simple win/loss picks', 'No spreads or totals', 'Weekly leaderboard', 'Season standings'],
  },
};