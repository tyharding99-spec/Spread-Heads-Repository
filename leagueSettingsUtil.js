// Utility to normalize league settings into a canonical shape
// Ensures backward compatibility with legacy fields while providing a stable contract.
// Canonical shape returned:
// {
//   lockOffsetMinutes: number,
//   scoring: { winner: number, spread: number, total: number },
//   confidenceEnabled: boolean,
//   confidenceMultiplier: number,
//   visibility: 'public'|'private',
//   pickDeadlineOffset: number, // hours before kickoff picks lock (0 means kickoff)
//   tiebreaker: string,
//   seasonMode: string,
//   showOthersPicks: boolean,
//   original: { ...rawSettings } // preserved raw for debugging/migration
// }
export const normalizeLeagueSettings = (type, rawSettings = {}) => {
  const r = rawSettings || {};

  // Derive lockOffsetMinutes priority order:
  // explicit lockOffsetMinutes > lineLockTime(hours) > default 60
  let lockOffsetMinutes;
  if (typeof r.lockOffsetMinutes === 'number' && !Number.isNaN(r.lockOffsetMinutes)) {
    lockOffsetMinutes = Math.max(0, r.lockOffsetMinutes);
  } else if (typeof r.lineLockTime === 'number' && !Number.isNaN(r.lineLockTime)) {
    lockOffsetMinutes = Math.max(0, Math.round(r.lineLockTime * 60));
  } else if (r.lineLockTime === 'opening') {
    lockOffsetMinutes = 60; // fallback mapping
  } else {
    lockOffsetMinutes = 60; // default 1 hour
  }

  // Scoring weights
  // Moneyline Mania: only winner counts
  let scoring;
  if (type === 'moneylineMania') {
    scoring = { winner: 1, spread: 0, total: 0 };
  } else {
    // Standard defaults (all 1 point). Advanced system could modify later.
    scoring = {
      winner: r.scoring?.winner ?? 1,
      spread: r.scoring?.spread ?? 1,
      total: r.scoring?.total ?? 1,
    };
  }

  // Confidence picks are disabled globally
  const confidenceEnabled = false;
  const confidenceMultiplier = 1;

  const normalized = {
    lockOffsetMinutes,
    scoring,
    confidenceEnabled,
    confidenceMultiplier,
    visibility: r.visibility === 'public' ? 'public' : 'private',
    pickDeadlineOffset: typeof r.pickDeadlineOffset === 'number' ? r.pickDeadlineOffset : 0,
    tiebreaker: r.tiebreaker || 'totalPoints',
    seasonMode: r.seasonMode || 'regular',
    showOthersPicks: !!r.showOthersPicks,
    original: { ...r },
  };

  return normalized;
};

// Backfill function for existing league objects (in-memory)
export const applySettingsNormalization = (league) => {
  if (!league || !league.settings) return league;
  const normalized = normalizeLeagueSettings(league.type, league.settings);
  return { ...league, settings: normalized };
};