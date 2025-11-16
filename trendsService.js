import { SUBSCRIPTION_PLANS } from './subscriptionManager';

// Mock data for demonstration - in a real app, this would come from an API
const TEAM_TRENDS = {
  'Arizona Cardinals': {
    basicStats: {
      wins: 5,
      losses: 4,
      homeRecord: '3-2',
      awayRecord: '2-2',
      pointsFor: 213,
      pointsAgainst: 198
    },
    premiumStats: {
      avgPointsHome: 27.4,
      avgPointsAway: 21.8,
      spreadCoverRate: 0.67,
      avgMargin: 2.1,
      lastFiveGames: [
        { result: 'W', score: '24-17', spread: -3 },
        { result: 'L', score: '21-28', spread: +4 },
        { result: 'W', score: '31-24', spread: -1 },
        { result: 'W', score: '17-14', spread: +2.5 },
        { result: 'L', score: '20-23', spread: -2.5 }
      ]
    },
    proStats: {
      situationalStats: {
        asUnderdog: { wins: 3, losses: 2, coverRate: 0.8 },
        asFavorite: { wins: 2, losses: 2, coverRate: 0.5 },
        afterLoss: { wins: 2, losses: 0, coverRate: 1.0 },
        divisionalGames: { wins: 2, losses: 1, coverRate: 0.67 }
      },
      injuries: [
        { player: 'John Doe', position: 'WR', status: 'Questionable' },
        { player: 'Mike Smith', position: 'CB', status: 'Out' }
      ],
      trends: [
        '7-3 ATS in last 10 road games',
        '5-0 to the Over vs. division opponents',
        '8-2 ATS as underdogs in last 10'
      ]
    }
  }
  // Add more teams here...
};

export const getTeamTrends = (teamName, userSubscription, isInUserLeague = false) => {
  const team = TEAM_TRENDS[teamName];
  if (!team) return null;

  // Base stats available to all users
  let trends = {
    basicStats: team.basicStats
  };

  // If team is in user's league, provide premium stats regardless of subscription
  if (isInUserLeague) {
    trends.premiumStats = team.premiumStats;
  } else {
    // Add premium stats based on subscription
    if (userSubscription.plan === SUBSCRIPTION_PLANS.PREMIUM || 
        userSubscription.plan === SUBSCRIPTION_PLANS.PRO) {
      trends.premiumStats = team.premiumStats;
    }
  }

  // Add pro stats only for PRO subscribers
  if (userSubscription.plan === SUBSCRIPTION_PLANS.PRO) {
    trends.proStats = team.proStats;
  }

  return trends;
};

export const getLeagueTrends = (league) => {
  const trends = {
    pickAccuracy: {},
    bestPickers: [],
    worstPickers: [],
    averageScore: 0,
    totalPicks: 0,
    correctPicks: 0
  };

  // Calculate trends based on league type and picks
  if (league.picks) {
    Object.entries(league.picks).forEach(([userId, userPicks]) => {
      let correct = 0;
      let total = 0;

      Object.entries(userPicks).forEach(([gameId, pick]) => {
        // Find game in completed games
        // This is mock logic - you'd need to implement actual game result checking
        total++;
        if (Math.random() > 0.5) correct++; // Mock correct/incorrect ratio
      });

      trends.pickAccuracy[userId] = (correct / total) || 0;
      trends.totalPicks += total;
      trends.correctPicks += correct;
    });

    // Sort users by accuracy
    const users = Object.entries(trends.pickAccuracy)
      .sort(([,a], [,b]) => b - a);

    trends.bestPickers = users.slice(0, 3);
    trends.worstPickers = users.slice(-3);
    trends.averageScore = trends.correctPicks / trends.totalPicks;
  }

  return trends;
};

export const getGlobalTrends = (userSubscription) => {
  // Only available to Premium and Pro subscribers
  if (userSubscription.plan === SUBSCRIPTION_PLANS.FREE) {
    return {
      message: 'Subscribe to Premium or Pro to access global trends'
    };
  }

  return {
    mostPickedTeams: [
      { team: 'Kansas City Chiefs', percentage: 78 },
      { team: 'San Francisco 49ers', percentage: 72 },
      { team: 'Philadelphia Eagles', percentage: 65 }
    ],
    bestAgainstSpread: [
      { team: 'Detroit Lions', record: '7-2 ATS' },
      { team: 'Miami Dolphins', record: '6-3 ATS' },
      { team: 'Cleveland Browns', record: '6-3 ATS' }
    ],
    upcomingTrends: [
      'Home underdogs are 17-8 ATS this season',
      'Primetime unders are hitting at 65%',
      'Weather impacts: Games with 15+ mph wind are 12-3 to the under'
    ],
    // Pro subscribers get additional insights
    ...(userSubscription.plan === SUBSCRIPTION_PLANS.PRO && {
      expertAnalysis: [
        'Sharp money trending towards underdogs in divisional games',
        'Teams off bye week covering at 70% rate',
        'West coast teams traveling east for 1PM games: 3-12 ATS'
      ],
      predictiveModels: {
        topValuePlays: [
          { team: 'Jacksonville Jaguars', confidence: 85 },
          { team: 'Cincinnati Bengals', confidence: 82 },
          { team: 'Los Angeles Chargers', confidence: 78 }
        ]
      }
    })
  };
};