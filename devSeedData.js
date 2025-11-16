// =====================================================
// DEV SEED DATA UTILITY
// =====================================================
// Creates test data for development and testing
// Only runs in __DEV__ mode
// Can be safely deleted before production
// =====================================================

import { supabase } from './supabaseClient';
import { createUserProfile } from './supabaseProfile';
import { createLeague } from './supabaseLeague';
import { savePick } from './supabasePicks';

// =====================================================
// TEST DATA CONFIGURATION
// =====================================================

const TEST_USERS = [
  { email: 'test1@test.com', password: 'test123', username: 'TestUser1', display_name: 'Test User 1' },
  { email: 'test2@test.com', password: 'test123', username: 'TestUser2', display_name: 'Test User 2' },
  { email: 'test3@test.com', password: 'test123', username: 'TestUser3', display_name: 'Test User 3' },
];

const TEST_LEAGUE_NAME = 'Dev Test League';

// Sample NFL games for Week 11 (Nov 14, 2024)
const WEEK_11_GAMES = [
  {
    gameId: 'test-game-1',
    week: 11,
    homeTeam: 'Kansas City',
    awayTeam: 'Buffalo',
    spread: -2.5,
    overUnder: 45.5,
    gameTime: '2024-11-14T20:20:00Z',
  },
  {
    gameId: 'test-game-2',
    week: 11,
    homeTeam: 'Baltimore',
    awayTeam: 'Pittsburgh',
    spread: -3,
    overUnder: 47,
    gameTime: '2024-11-14T18:00:00Z',
  },
  {
    gameId: 'test-game-3',
    week: 11,
    homeTeam: 'Green Bay',
    awayTeam: 'Chicago',
    spread: -7,
    overUnder: 41,
    gameTime: '2024-11-14T13:00:00Z',
  },
];

// =====================================================
// SEED FUNCTIONS
// =====================================================

/**
 * Create test users (or get existing)
 */
async function createTestUsers() {
  const createdUsers = [];
  
  for (const testUser of TEST_USERS) {
    try {
      // Try to sign in first (user might already exist)
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email: testUser.email,
        password: testUser.password,
      });
      
      if (!signInError && signInData.user) {
        console.log(`✓ User exists: ${testUser.email}`);
        createdUsers.push(signInData.user);
        continue;
      }
      
      // Create new user if sign in failed
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: testUser.email,
        password: testUser.password,
        options: {
          data: {
            username: testUser.username,
            display_name: testUser.display_name,
          },
        },
      });
      
      if (signUpError) {
        console.warn(`✗ Failed to create user ${testUser.email}:`, signUpError);
        continue;
      }
      
      if (signUpData.user) {
        // Create profile
        await createUserProfile({
          id: signUpData.user.id,
          email: testUser.email,
          username: testUser.username,
          display_name: testUser.display_name,
        });
        
        console.log(`✓ Created user: ${testUser.email}`);
        createdUsers.push(signUpData.user);
      }
    } catch (error) {
      console.warn(`✗ Error with user ${testUser.email}:`, error);
    }
  }
  
  return createdUsers;
}

/**
 * Create test league with all test users
 */
async function createTestLeague(users) {
  try {
    const creatorId = users[0].id;
    const memberIds = users.map(u => u.id);
    
    // Check if test league already exists
    const { data: existing } = await supabase
      .from('leagues')
      .select('*')
      .eq('name', TEST_LEAGUE_NAME)
      .single();
    
    if (existing) {
      console.log(`✓ Test league already exists: ${existing.code}`);
      return existing;
    }
    
    // Create new league
    const code = 'TEST' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const { data: league, error } = await createLeague({
      name: TEST_LEAGUE_NAME,
      code: code,
      type: 'nfl-spread',
      created_by: creatorId,
      members: memberIds,
      settings: {
        lockOffsetMinutes: 60,
        scoringType: 'confidence',
        weeklyPickLimit: 16,
      },
    });
    
    if (error) {
      console.warn('✗ Failed to create league:', error);
      return null;
    }
    
    console.log(`✓ Created test league: ${league.code}`);
    return league;
  } catch (error) {
    console.warn('✗ Error creating test league:', error);
    return null;
  }
}

/**
 * Seed picks for all users in the league
 */
async function seedTestPicks(league, users) {
  if (!league) return;
  
  let pickCount = 0;
  
  for (const user of users) {
    for (const game of WEEK_11_GAMES) {
      try {
        // Randomize picks for variety
        const pickSpread = Math.random() > 0.5 ? 'home' : 'away';
        const pickTotal = Math.random() > 0.5 ? 'over' : 'under';
        
        const { error } = await savePick({
          league_code: league.code,
          user_id: user.id,
          game_id: game.gameId,
          week: game.week,
          spread: pickSpread,
          total: pickTotal,
          winner: null,
        });
        
        if (!error) {
          pickCount++;
        }
      } catch (error) {
        console.warn(`✗ Failed to create pick for ${user.email} on ${game.gameId}`);
      }
    }
  }
  
  console.log(`✓ Created ${pickCount} test picks`);
}

// =====================================================
// MAIN SEED FUNCTION
// =====================================================

/**
 * Seed all test data
 * Call this from a dev button in the app
 */
export async function seedTestData() {
  console.log('🌱 Starting seed process...');
  
  try {
    // Step 1: Create/get test users
    console.log('\n📝 Creating test users...');
    const users = await createTestUsers();
    
    if (users.length === 0) {
      console.error('✗ No users created, aborting seed');
      return { success: false, message: 'Failed to create test users' };
    }
    
    // Step 2: Create test league
    console.log('\n🏈 Creating test league...');
    const league = await createTestLeague(users);
    
    if (!league) {
      console.error('✗ League creation failed, aborting seed');
      return { success: false, message: 'Failed to create test league' };
    }
    
    // Step 3: Seed picks
    console.log('\n🎯 Seeding picks...');
    await seedTestPicks(league, users);
    
    console.log('\n✅ Seed complete!');
    return {
      success: true,
      message: `Test data created!\n\nLeague: ${TEST_LEAGUE_NAME}\nCode: ${league.code}\nUsers: ${users.length}\nPicks: ${users.length * WEEK_11_GAMES.length}`,
      leagueCode: league.code,
    };
  } catch (error) {
    console.error('✗ Seed error:', error);
    return { success: false, message: 'Seed failed: ' + error.message };
  }
}

/**
 * Clean up test data
 * Removes test league and users
 */
export async function cleanupTestData() {
  console.log('🧹 Cleaning up test data...');
  
  try {
    // Delete test league
    const { error: leagueError } = await supabase
      .from('leagues')
      .delete()
      .eq('name', TEST_LEAGUE_NAME);
    
    if (!leagueError) {
      console.log('✓ Deleted test league');
    }
    
    // Note: We don't delete test users for safety
    // They can be deleted manually from Supabase dashboard if needed
    
    console.log('✅ Cleanup complete!');
    return { success: true, message: 'Test data cleaned up' };
  } catch (error) {
    console.error('✗ Cleanup error:', error);
    return { success: false, message: 'Cleanup failed: ' + error.message };
  }
}

// =====================================================
// HELPER: Check if test data exists
// =====================================================

export async function checkTestDataExists() {
  try {
    const { data } = await supabase
      .from('leagues')
      .select('code')
      .eq('name', TEST_LEAGUE_NAME)
      .single();
    
    return !!data;
  } catch {
    return false;
  }
}

// =====================================================
// EXPORTS
// =====================================================

export default {
  seedTestData,
  cleanupTestData,
  checkTestDataExists,
};
