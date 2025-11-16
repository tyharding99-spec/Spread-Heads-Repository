import { LEAGUE_TYPES } from './leagueTypes';

// Helper function to calculate weekly scores
const calculateWeeklyScore = (picks, weekGames) => {
    let score = 0;
    Object.entries(picks).forEach(([gameId, pick]) => {
        const game = weekGames.find(g => g.id === gameId);
        if (game && game.isComplete) {
            // Simple scoring: +1 for correct pick
            const winningTeam = game.homeScore > game.awayScore ? game.homeTeam : game.awayTeam;
            if (pick === winningTeam) score++;
        }
    });
    return score;
};

export const leagueLogic = {
    // Individual League Logic
    [LEAGUE_TYPES.INDIVIDUAL]: {
        canJoin: (league) => false, // Individual leagues are solo only
        
        processWeekResults: (league, weekGames) => {
            const userId = league.members[0];
            const weekScore = calculateWeeklyScore(league.picks[userId] || {}, weekGames);
            
            return {
                ...league,
                standings: [
                    ...league.standings,
                    {
                        week: league.standings.length + 1,
                        score: weekScore,
                        picks: league.picks[userId] || {}
                    }
                ]
            };
        },

        getPlayerStats: (league) => ({
            totalScore: league.standings.reduce((sum, week) => sum + week.score, 0),
            weeklyScores: league.standings.map(week => week.score),
            averageScore: league.standings.length > 0 
                ? league.standings.reduce((sum, week) => sum + week.score, 0) / league.standings.length 
                : 0
        })
    },

    // Free for All League Logic
    [LEAGUE_TYPES.FREE_FOR_ALL]: {
        canJoin: (league) => league.members.length < league.settings.maxPlayers,
        
        processWeekResults: (league, weekGames) => {
            const weekScores = league.members.map(userId => ({
                userId,
                score: calculateWeeklyScore(league.picks[userId] || {}, weekGames)
            }));

            return {
                ...league,
                standings: [
                    ...league.standings,
                    {
                        week: league.standings.length + 1,
                        scores: weekScores,
                        weekGames: weekGames.map(g => g.id)
                    }
                ]
            };
        },

        getPlayerStats: (league, userId) => {
            const allWeekScores = league.standings.map(week => 
                week.scores.find(s => s.userId === userId)?.score || 0
            );
            
            return {
                totalScore: allWeekScores.reduce((sum, score) => sum + score, 0),
                weeklyScores: allWeekScores,
                rank: league.standings.length > 0 
                    ? league.standings[league.standings.length - 1].scores
                        .sort((a, b) => b.score - a.score)
                        .findIndex(s => s.userId === userId) + 1
                    : 0
            };
        }
    },

    // Survivor League Logic
    [LEAGUE_TYPES.SURVIVOR]: {
        canJoin: (league) => {
            // Can only join before league starts
            return league.standings.length === 0 && league.members.length < league.settings.maxPlayers;
        },
        
        processWeekResults: (league, weekGames) => {
            // Get active players (not eliminated)
            const activePlayers = league.members.filter(
                userId => !league.eliminatedUsers.includes(userId)
            );

            // Calculate scores for active players
            const weekScores = activePlayers.map(userId => ({
                userId,
                score: calculateWeeklyScore(league.picks[userId] || {}, weekGames)
            }));

            // Find player(s) with lowest score
            const minScore = Math.min(...weekScores.map(s => s.score));
            const eliminatedThisWeek = weekScores
                .filter(s => s.score === minScore)
                .map(s => s.userId);

            return {
                ...league,
                standings: [
                    ...league.standings,
                    {
                        week: league.standings.length + 1,
                        scores: weekScores,
                        eliminated: eliminatedThisWeek
                    }
                ],
                eliminatedUsers: [...league.eliminatedUsers, ...eliminatedThisWeek]
            };
        },

        getPlayerStats: (league, userId) => {
            const isEliminated = league.eliminatedUsers.includes(userId);
            const eliminationWeek = isEliminated 
                ? league.standings.findIndex(week => week.eliminated.includes(userId)) + 1
                : null;
            
            return {
                isEliminated,
                eliminationWeek,
                placement: isEliminated 
                    ? league.members.length - league.eliminatedUsers.findIndex(id => id === userId)
                    : 1,
                totalPlayers: league.members.length
            };
        }
    },

    // Head to Head League Logic
    [LEAGUE_TYPES.HEAD_TO_HEAD]: {
        canJoin: (league) => {
            // Must have even number of players
            return league.standings.length === 0 && 
                   league.members.length < league.settings.maxPlayers &&
                   league.members.length % 2 === 0;
        },

        generateSchedule: (league) => {
            const teams = [...league.members];
            const rounds = [];
            
            // Generate round-robin schedule
            for (let round = 0; round < teams.length - 1; round++) {
                const roundMatches = [];
                for (let i = 0; i < teams.length / 2; i++) {
                    roundMatches.push({
                        home: teams[i],
                        away: teams[teams.length - 1 - i]
                    });
                }
                rounds.push(roundMatches);
                
                // Rotate teams (keep first team fixed)
                teams.splice(1, 0, teams.pop());
            }

            return rounds;
        },
        
        processWeekResults: (league, weekGames) => {
            const weekNumber = league.standings.length + 1;
            const weekMatches = league.schedule[weekNumber - 1] || [];
            
            const matchResults = weekMatches.map(match => {
                const homeScore = calculateWeeklyScore(league.picks[match.home] || {}, weekGames);
                const awayScore = calculateWeeklyScore(league.picks[match.away] || {}, weekGames);
                
                return {
                    ...match,
                    homeScore,
                    awayScore,
                    winner: homeScore > awayScore ? match.home : 
                           awayScore > homeScore ? match.away : 'tie'
                };
            });

            // Update records
            const newRecords = { ...league.records };
            matchResults.forEach(match => {
                ['home', 'away'].forEach(side => {
                    const userId = match[side];
                    newRecords[userId] = newRecords[userId] || { wins: 0, losses: 0, ties: 0 };
                    
                    if (match.winner === userId) newRecords[userId].wins++;
                    else if (match.winner === 'tie') newRecords[userId].ties++;
                    else newRecords[userId].losses++;
                });
            });

            return {
                ...league,
                standings: [
                    ...league.standings,
                    {
                        week: weekNumber,
                        matches: matchResults
                    }
                ],
                records: newRecords
            };
        },

        getPlayerStats: (league, userId) => {
            const record = league.records[userId] || { wins: 0, losses: 0, ties: 0 };
            const winPercentage = (record.wins + record.ties * 0.5) / 
                                (record.wins + record.losses + record.ties) || 0;
            
            // Calculate position in standings
            const standings = Object.entries(league.records)
                .map(([id, rec]) => ({
                    userId: id,
                    percentage: (rec.wins + rec.ties * 0.5) / (rec.wins + rec.losses + rec.ties) || 0
                }))
                .sort((a, b) => b.percentage - a.percentage);

            return {
                ...record,
                winPercentage,
                rank: standings.findIndex(s => s.userId === userId) + 1,
                totalPlayers: league.members.length,
                isPlayoffBound: league.settings.playoffTeams ? 
                    standings.findIndex(s => s.userId === userId) < league.settings.playoffTeams :
                    false
            };
        }
    }
};