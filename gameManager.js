import AsyncStorage from '@react-native-async-storage/async-storage';

const GAMES_STORAGE_KEY = '@games';
const CURRENT_WEEK_KEY = '@currentWeek';

// Game status constants
export const GAME_STATUS = {
  SCHEDULED: 'scheduled',
  IN_PROGRESS: 'inProgress',
  FINAL: 'final',
  POSTPONED: 'postponed',
};

// Sample game structure
const sampleGame = {
  id: 'game_id',
  week: 1,
  homeTeam: 'Team Name',
  awayTeam: 'Team Name',
  homeScore: 0,
  awayScore: 0,
  spread: -3.5,
  status: GAME_STATUS.SCHEDULED,
  startTime: '2025-09-07T18:00:00Z',
  endTime: null,
  winner: null, // will be homeTeam or awayTeam once game is final
};

export const getCurrentWeek = async () => {
  try {
    const week = await AsyncStorage.getItem(CURRENT_WEEK_KEY);
    return week ? parseInt(week) : 1;
  } catch (error) {
    console.error('Error getting current week:', error);
    return 1;
  }
};

export const setCurrentWeek = async (week) => {
  try {
    await AsyncStorage.setItem(CURRENT_WEEK_KEY, week.toString());
    return true;
  } catch (error) {
    console.error('Error setting current week:', error);
    return false;
  }
};

export const getGamesForWeek = async (week) => {
  try {
    const gamesJson = await AsyncStorage.getItem(GAMES_STORAGE_KEY);
    const allGames = gamesJson ? JSON.parse(gamesJson) : [];
    return allGames.filter(game => game.week === week);
  } catch (error) {
    console.error('Error getting games:', error);
    return [];
  }
};

export const updateGameResults = async (gameId, homeScore, awayScore) => {
  try {
    const gamesJson = await AsyncStorage.getItem(GAMES_STORAGE_KEY);
    const allGames = gamesJson ? JSON.parse(gamesJson) : [];
    
    const updatedGames = allGames.map(game => {
      if (game.id === gameId) {
        const winner = homeScore > awayScore ? game.homeTeam : 
                      awayScore > homeScore ? game.awayTeam : 
                      null;
        return {
          ...game,
          homeScore,
          awayScore,
          status: GAME_STATUS.FINAL,
          endTime: new Date().toISOString(),
          winner
        };
      }
      return game;
    });

    await AsyncStorage.setItem(GAMES_STORAGE_KEY, JSON.stringify(updatedGames));
    return true;
  } catch (error) {
    console.error('Error updating game results:', error);
    return false;
  }
};

// Process weekly results for all leagues
export const processWeeklyResults = async (leagues, setLeagues) => {
  try {
    const currentWeek = await getCurrentWeek();
    const weekGames = await getGamesForWeek(currentWeek);
    
    // Only process if all games are final
    if (!weekGames.every(game => game.status === GAME_STATUS.FINAL)) {
      return { success: false, message: 'Not all games are final' };
    }

    // Process each league
    const updatedLeagues = leagues.map(league => {
      if (!league.settings.isActive) return league;

      const leagueLogic = leagueTypes[league.type];
      if (!leagueLogic) return league;

      return leagueLogic.processWeekResults(league, weekGames);
    });

    // Save updated leagues
    setLeagues(updatedLeagues);
    await AsyncStorage.setItem('leagues', JSON.stringify(updatedLeagues));

    // Advance to next week
    await setCurrentWeek(currentWeek + 1);

    return { 
      success: true, 
      message: 'Weekly results processed successfully',
      updatedLeagues 
    };
  } catch (error) {
    console.error('Error processing weekly results:', error);
    return { 
      success: false, 
      message: 'Error processing results: ' + error.message 
    };
  }
};