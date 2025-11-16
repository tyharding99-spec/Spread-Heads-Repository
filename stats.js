// stats.js
// Utilities to compute user and league stats from picks and stored results

// Normalize helper: accepts "+3.5", "-2.0", 3.5 etc and returns a number or null
const toNum = (v) => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9+\-.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Calculate pick result using a compact result object
// pick: { spread?: teamName, total?: 'over'|'under' }
// result: { awayTeam, homeTeam, awayScore, homeScore, awaySpread, homeSpread, overUnder }
export const evaluatePick = (pick, result) => {
  if (!result || !Number.isFinite(result.awayScore) || !Number.isFinite(result.homeScore)) return null;

  const awayScore = Number(result.awayScore);
  const homeScore = Number(result.homeScore);
  const totalScore = awayScore + homeScore;

  const awaySpread = toNum(result.awaySpread);
  const homeSpread = toNum(result.homeSpread);
  const ou = toNum(result.overUnder);

  let spreadResult = null;
  let totalResult = null;

  if (pick?.spread) {
    const pickedTeam = pick.spread;
    const isAway = pickedTeam === result.awayTeam;
    const spread = isAway ? awaySpread : homeSpread;
    if (spread !== null) {
      const adjusted = isAway ? awayScore + spread : homeScore + spread;
      const opp = isAway ? homeScore : awayScore;
      spreadResult = adjusted > opp ? 'win' : adjusted < opp ? 'loss' : 'push';
    }
  }

  if (pick?.total && ou !== null) {
    if (pick.total === 'over') {
      totalResult = totalScore > ou ? 'win' : totalScore < ou ? 'loss' : 'push';
    } else if (pick.total === 'under') {
      totalResult = totalScore < ou ? 'win' : totalScore > ou ? 'loss' : 'push';
    }
  }

  return { spreadResult, totalResult };
};

// Compute user stats across leagues with filters
// pickType: 'all' | 'spread' | 'total'
// timePeriod: 'allTime' | 'thisWeek' | 'thisMonth'
export const computeUserStats = ({ leagues, userId, results, pickType = 'all', timePeriod = 'allTime' }) => {
  if (!userId) return defaultStats();
  const now = new Date();
  const withinPeriod = (iso) => {
    if (!iso || timePeriod === 'allTime') return true;
    const t = new Date(iso);
    if (timePeriod === 'thisWeek') {
      const diffDays = (now - t) / (1000 * 60 * 60 * 24);
      return diffDays <= 7;
    }
    if (timePeriod === 'thisMonth') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return t >= start;
    }
    return true;
  };

  let spreadWins = 0, spreadLosses = 0, spreadPushes = 0;
  let totalWins = 0, totalLosses = 0, totalPushes = 0;
  let overallWins = 0, overallLosses = 0;
  let totalPicks = 0;

  // For streaks: collect picks with timestamps and outcomes
  const resolved = [];

  // Track unique picks by gameId to avoid counting duplicates across leagues
  const uniqueSpreadPicks = new Map(); // gameId -> { pick, result, timestamp }
  const uniqueTotalPicks = new Map(); // gameId -> { pick, result, timestamp }

  (leagues || []).forEach(league => {
    const userPicks = league?.picks?.[userId] || {};
    Object.entries(userPicks).forEach(([gameId, pick]) => {
      const res = results?.[gameId];
      if (!res || !res.isFinal) return;
      if (!withinPeriod(res.finalizedAt || pick.timestamp)) return;

      const out = evaluatePick(pick, res);
      if (!out) return;

      const considerSpread = pickType === 'all' || pickType === 'spread';
      const considerTotal = pickType === 'all' || pickType === 'total';

      // Store spread pick (only first occurrence per gameId)
      if (considerSpread && pick.spread && out.spreadResult && !uniqueSpreadPicks.has(gameId)) {
        uniqueSpreadPicks.set(gameId, {
          pick,
          result: out.spreadResult,
          timestamp: pick.timestamp || res.finalizedAt
        });
      }

      // Store total pick (only first occurrence per gameId)
      if (considerTotal && pick.total && out.totalResult && !uniqueTotalPicks.has(gameId)) {
        uniqueTotalPicks.set(gameId, {
          pick,
          result: out.totalResult,
          timestamp: pick.timestamp || res.finalizedAt
        });
      }
    });
  });

  // Now count the unique picks
  uniqueSpreadPicks.forEach(({ result, timestamp }) => {
    totalPicks++;
    if (result === 'win') { spreadWins++; overallWins++; }
    if (result === 'loss') { spreadLosses++; overallLosses++; }
    if (result === 'push') { spreadPushes++; }
    resolved.push({ ts: timestamp, type: 'spread', result });
  });

  uniqueTotalPicks.forEach(({ result, timestamp }) => {
    totalPicks++;
    if (result === 'win') { totalWins++; overallWins++; }
    if (result === 'loss') { totalLosses++; overallLosses++; }
    if (result === 'push') { totalPushes++; }
    resolved.push({ ts: timestamp, type: 'total', result });
  });

  const denom = overallWins + overallLosses;
  const winPercentage = denom > 0 ? Math.round((overallWins / denom) * 1000) / 10 : 0;
  const spreadDen = spreadWins + spreadLosses;
  const spreadWinPercentage = spreadDen > 0 ? Math.round((spreadWins / spreadDen) * 1000) / 10 : 0;
  const totalDen = totalWins + totalLosses;
  const totalWinPercentage = totalDen > 0 ? Math.round((totalWins / totalDen) * 1000) / 10 : 0;

  // Streaks
  resolved.sort((a, b) => new Date(b.ts) - new Date(a.ts)); // newest first
  let currentStreakType = 'none';
  let currentStreak = 0;
  if (resolved.length) {
    const first = resolved[0].result;
    currentStreakType = first === 'win' ? 'wins' : first === 'loss' ? 'losses' : 'none';
    for (const r of resolved) {
      if (r.result === first) currentStreak++; else break;
    }
  }

  // Longest win streak
  const byOldest = [...resolved].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  let longestWinStreak = 0, cur = 0;
  for (const r of byOldest) {
    if (r.result === 'win') { cur++; longestWinStreak = Math.max(longestWinStreak, cur); } else if (r.result === 'loss') { cur = 0; }
  }

  return {
    totalPicks,
    spreadWins, spreadLosses, spreadPushes,
    totalWins, totalLosses, totalPushes,
    overallWins, overallLosses,
    winPercentage,
    spreadWinPercentage,
    totalWinPercentage,
    currentStreak: { type: currentStreakType, count: currentStreak },
    longestWinStreak,
  };
};

export const defaultStats = () => ({
  totalPicks: 0,
  spreadWins: 0,
  spreadLosses: 0,
  spreadPushes: 0,
  totalWins: 0,
  totalLosses: 0,
  totalPushes: 0,
  overallWins: 0,
  overallLosses: 0,
  winPercentage: 0,
  spreadWinPercentage: 0,
  totalWinPercentage: 0,
  currentStreak: { type: 'none', count: 0 },
  longestWinStreak: 0,
});

export default {
  computeUserStats,
  evaluatePick,
  defaultStats,
};
