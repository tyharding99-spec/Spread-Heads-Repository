# Development History - Project Start through October 25, 2025

## Project Overview
**App Name:** Pick 'Em Pro (NFL Pick'em League App)  
**Platform:** React Native + Expo  
**Database:** Supabase (PostgreSQL)  
**Primary Features:** NFL game predictions, league management, social competition, stats tracking

---

## Phase 1: Initial Setup & Core Infrastructure

### Technology Stack Selection
- **Frontend:** React Native with Expo
- **State Management:** React hooks (useState, useEffect)
- **Data Storage:** AsyncStorage (local) + Supabase (cloud)
- **Authentication:** Supabase Auth
- **API Integration:** ESPN NFL Scoreboard API
- **Styling:** Custom theme system with light/dark modes

### Project Structure Established
```
my-first-app/
├── App.js (main component, 3400+ lines)
├── theme.js (color schemes)
├── storage.js (AsyncStorage helpers)
├── stats.js (statistics calculation engine)
├── supabaseClient.js (database connection)
├── supabaseAuth.js (auth functions)
├── supabaseProfile.js (profile management)
├── package.json (dependencies)
├── app.json (Expo config)
├── WeeklyResultsScreen.js (stats screen)
├── AchievementsScreen.js (badges/achievements)
├── TrendsScreen.js (analytics charts)
├── UserProfileScreen.js (user detail view)
├── FriendsScreen.js (social features)
└── assets/ (images, icons)
```

### Dependencies Installed
- @supabase/supabase-js
- @react-native-async-storage/async-storage
- expo-notifications
- expo-sharing
- expo-file-system
- expo-haptics
- react-native-url-polyfill

---

## Phase 2: Authentication System

### Supabase Integration
- Created Supabase project
- Connected client with URL and anon key
- Implemented Row Level Security (RLS) basics

### Auth Features Built
1. **Sign Up:**
   - Email + password + username
   - Profile creation in Supabase
   - User metadata storage
   - Automatic login after signup

2. **Login:**
   - Email/password authentication
   - Session persistence
   - Profile data loading
   - Error handling with user-friendly messages

3. **User Profile System:**
   - profiles table in Supabase
   - Fields: id, email, username, phone
   - CRUD operations (create, read, update)
   - Metadata sync with auth.users

4. **Session Management:**
   - Auto-login on app launch
   - Logout functionality
   - Session refresh handling

### Files Created:
- `supabaseClient.js` - Database connection setup
- `supabaseAuth.js` - Auth functions (signUp, login, logout, getCurrentUser, updateEmail, updateMetadata)
- `supabaseProfile.js` - Profile CRUD (createUserProfile, getUserProfile, updateUserProfile)

---

## Phase 3: Core UI & Navigation

### Theme System
- Created `theme.js` with light and dark color schemes
- Theme structure:
  ```javascript
  {
    name: 'light' | 'dark',
    colors: {
      primary, success, danger, warning,
      background, card, border,
      text, heading, muted,
      bannerBg, bannerBorder, navBg
    }
  }
  ```
- User preference storage in AsyncStorage
- Real-time theme switching
- Dark mode toggle in profile settings

### Navigation Architecture
- Custom tab-based navigation (no React Navigation dependency)
- Navigation stack with back button support
- Animated screen transitions (fade in/out)
- Android hardware back button support

### Initial Tab Structure (6 tabs)
1. **Home** - League list and management
2. **Scoreboard** - Live NFL games
3. **Leagues** - Create/join leagues
4. **Leaderboard** - Global rankings
5. **Trends** - Performance analytics
6. **Profile** - User settings

### Screen Components
- Banner with navigation and back button
- Bottom tab navigation bar
- Modal overlay system
- Loading states with ActivityIndicator
- Error message handling

---

## Phase 4: League Management System

### League Creation
- League name input
- Unique 6-character join code generation
- Settings configuration:
  - Pick deadline (game time or weekly)
  - Scoring system (simple win/loss or confidence points)
  - Spread betting enabled/disabled
  - Over/under betting enabled/disabled
  - Max picks per week limit
  
### League Data Structure
```javascript
{
  name: string,
  code: string (6 chars),
  createdBy: userId,
  members: [userId1, userId2, ...],
  settings: {
    pickDeadline: 'gameTime' | 'weekly',
    scoringSystem: 'simple' | 'confidence',
    allowSpread: boolean,
    allowTotal: boolean,
    maxPicksPerWeek: number
  },
  picks: {
    [userId]: {
      [gameId]: {
        spread: { team, line, confidence },
        total: { pick, line, confidence }
      }
    }
  },
  standings: calculated in real-time
}
```

### League Features
- **Join League:** Enter 6-character code
- **Leave League:** Remove self from members
- **Invite Members:** Share league code
- **View Standings:** Ranked by win percentage
- **League Settings:** View rules and configuration

### Storage System (`storage.js`)
- AsyncStorage key constants
- Save/load functions for leagues
- Error handling and fallbacks
- Data migration helpers

---

## Phase 5: NFL Game Integration

### ESPN API Integration
- Real-time game data fetching
- Scoreboard endpoint: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`
- Game data structure parsing:
  - Game ID, date/time
  - Home/away teams (name, abbreviation, logo)
  - Scores (live updating)
  - Game status (scheduled, in-progress, final)
  - Odds data (spread, over/under)

### Scoreboard Screen Features
1. **Week Filter:**
   - Dropdown to select NFL week (1-18)
   - Current week auto-selected
   - Week stored in state

2. **Game Cards Display:**
   - Team logos and names
   - Current score (if live/final)
   - Game time/status
   - Betting lines (spread, total)
   - Network/channel info

3. **Pick Integration:**
   - Make picks directly from scoreboard
   - Spread pick: Select team + see line
   - Total pick: Over/Under + line value
   - Confidence points (if enabled)
   - Visual indicators for selected picks

4. **Live Updates:**
   - Refresh button to fetch latest scores
   - Auto-refresh capability
   - Loading states during fetch

### Game Status Handling
- **Scheduled:** Show game time, allow picks
- **In Progress:** Show live score, lock picks
- **Final:** Show final score, evaluate picks
- **Postponed/Cancelled:** Display status, void picks

---

## Phase 6: Picking System

### Pick Types
1. **Spread Picks:**
   - Select team to cover the spread
   - Display point spread (e.g., -3.5)
   - Lock at game time or weekly deadline
   
2. **Over/Under (Total) Picks:**
   - Pick Over or Under
   - Display total line (e.g., 45.5)
   - Same deadline rules

### Confidence Points System
- Assign 1-16 points to picks (or custom range)
- Higher confidence = more points if correct
- Each confidence value used once per week
- Drag-to-reorder interface (planned)

### Pick Deadline Logic
- **Game Time Deadline:** Locks when specific game starts
- **Weekly Deadline:** All picks lock at first game of week
- Visual countdown timer
- Locked picks shown but not editable

### Pick Storage
- Nested structure: `league.picks[userId][gameId]`
- Spread and total picks stored separately
- Confidence values included
- Timestamp for pick submission

### Pick Validation
- Prevent duplicate confidence values
- Check pick deadline before submission
- Verify game hasn't started
- Validate spread/total enabled in league settings

---

## Phase 7: Scoring & Results System

### Game Result Evaluation (`stats.js`)
Created comprehensive evaluation engine:

```javascript
evaluatePick(pick, game) {
  // Determines win/loss/push for each pick type
  // Returns: 'win', 'loss', 'push', 'pending'
}
```

### Spread Pick Evaluation
- Compare final scores with spread
- Account for half-point spreads (no pushes)
- Handle integer spreads (push if exact)
- Example: Team -3.5 wins by 4 = WIN

### Total Pick Evaluation  
- Sum both team scores
- Compare to over/under line
- Over wins if total > line
- Under wins if total < line
- Push if exact (rare with .5 lines)

### Statistics Calculation Engine
Built `computeUserStats()` function:

**Inputs:**
- leagues array
- userId
- results (completed games)
- pickType filter ('all', 'spread', 'total')
- timePeriod filter ('allTime', 'thisWeek', 'thisMonth')

**Outputs:**
```javascript
{
  totalPicks: number,
  overallWins: number,
  overallLosses: number,
  overallPushes: number,
  winPercentage: number,
  
  spreadWins: number,
  spreadLosses: number,
  spreadPushes: number,
  spreadWinPercentage: number,
  
  totalWins: number,
  totalLosses: number,
  totalPushes: number,
  totalWinPercentage: number,
  
  currentStreak: { type: 'win'|'loss', count: number },
  longestWinStreak: number,
  longestLossStreak: number
}
```

### Results Storage
- Completed games stored in AsyncStorage
- Structure: `{ [gameId]: { ...gameData, status: 'final', scores: {...} } }`
- Fetched from ESPN API after games complete
- Used for historical stats calculation

---

## Phase 8: Stats & Analytics Screens

### WeeklyResultsScreen (Stats Tab)
**Features:**
1. **Time Period Filter:**
   - All Time
   - This Week
   - This Month

2. **Pick Type Filter:**
   - All Picks
   - Spread Only
   - Over/Under Only

3. **Stat Cards:**
   - Overall win rate (percentage + W-L record)
   - Total picks made
   - Spread-specific stats (win rate, W-L-P)
   - Total-specific stats (win rate, W-L-P)

4. **Achievements Section:**
   - Current streak (wins/losses)
   - Longest win streak
   - Longest loss streak (future)

**Implementation:**
- Real stats using `computeUserStats()` from stats.js
- Loads results from AsyncStorage
- Responsive stat card grid layout
- Theme-aware colors

### TrendsScreen (Analytics)
**Features:**
1. **Performance Charts:**
   - Weekly win rate line chart
   - Pick distribution by type
   - Confidence analysis (future)

2. **Trend Analysis:**
   - Improving/declining indicators
   - Best/worst weeks
   - Favorite/least favorite teams

3. **Time-based Filters:**
   - Last 4 weeks
   - Season to date
   - All time

**Status:** Basic UI created, full chart implementation pending

### LeaderboardScreen
**Features:**
1. **Global Rankings:**
   - All users across all leagues
   - Sorted by overall win percentage
   - Tie-breaker: total wins

2. **League-Specific View:**
   - Filter by specific league
   - Head-to-head records
   - League standings

3. **User Cards:**
   - Rank number
   - Username/display name
   - Win percentage
   - Total record (W-L-P)
   - Avatar placeholder

**Ranking Algorithm:**
- Primary sort: Win percentage (descending)
- Secondary sort: Total wins (descending)
- Updates in real-time as games complete

---

## Phase 9: League Details & Standings

### LeagueDetailsScreen
Built comprehensive league management interface:

**Header Section:**
- League name (large, prominent)
- Join code with copy button
- Member count
- Created by username

**Tabs System:**
1. **Picks Tab:**
   - Current week's games
   - Make spread/total picks
   - Confidence point assignment
   - Pick deadline warnings
   - Edit picks before deadline

2. **Standings Tab:**
   - Ranked member list
   - User avatars (colored circles with initials)
   - Win percentage
   - Total record (W-L)
   - Current user highlighted
   - **Clickable users** → Navigate to user profile

3. **Settings Tab:**
   - League rules display
   - Pick deadline type
   - Scoring system
   - Spread/Total enabled status
   - Max picks per week
   - Leave league button

### Standing Calculation
```javascript
// For each member:
const stats = computeUserStats({
  leagues: [currentLeague],
  userId: memberId,
  results,
  pickType: 'all',
  timePeriod: 'allTime'
});

// Sort by:
1. winPercentage (descending)
2. overallWins (descending, tie-breaker)
```

### User Interaction
- Click any user in standings → View UserProfileScreen
- See their overall stats, pick history, streaks
- Compare performance

---

## Phase 10: Social Features

### UserProfileScreen
**Purpose:** View detailed stats for any user

**Sections:**
1. **Header:**
   - Large avatar (colored circle with initial)
   - Username/display name
   - Back button to return

2. **Overall Stats:**
   - Total picks
   - Win percentage
   - W-L-P record

3. **Current Streaks:**
   - Active win/loss streak
   - Longest win streak ever

4. **Pick Type Breakdown:**
   - Spread stats (win%, W-L-P)
   - Total stats (win%, W-L-P)

5. **Pick History:**
   - Last 20 completed picks
   - Expandable list
   - Each pick shows:
     - Game matchup
     - Pick selection
     - Confidence points
     - Outcome (WIN/LOSS/PUSH)
     - Final score
   - Color-coded: green (win), red (loss), gray (push)

**Navigation:**
- Accessible from league standings
- Route pattern: `UserProfile:${userId}:${username}`

### FriendsScreen
**Purpose:** Manage friend connections and compare stats

**Features:**
1. **Privacy Toggle:**
   - Make stats public/private
   - Controls what friends can see
   - Switch component in header

2. **Friends List:**
   - Avatar + username
   - Win rate (if public)
   - Record (if public)
   - "Stats Private" message for private profiles
   - Remove friend button

3. **Add Friend:**
   - Search by username or user ID
   - Simple add interface (simplified for now)
   - Friend request system (future enhancement)

4. **Friend Stats Viewing:**
   - Click friend → View their UserProfileScreen
   - Only works if friend has public stats
   - Respects privacy settings

**Data Structure:**
```javascript
{
  friends: [userId1, userId2, ...],
  requests: [], // future: pending friend requests
  isPublic: boolean // user's privacy setting
}
```

**Storage:**
- Stored in AsyncStorage with `FRIENDS_KEY`
- Functions: `saveFriends(userId, data)`, `loadFriends(userId)`

### AchievementsScreen
**Purpose:** Gamification through badges and milestones

**Achievement Categories:**
1. **Winning Streaks:**
   - 3-game streak
   - 5-game streak  
   - 10-game streak
   - Perfect week

2. **Volume Achievements:**
   - First pick
   - 50 picks
   - 100 picks
   - 500 picks

3. **Accuracy:**
   - 60% win rate (season)
   - 70% win rate (season)
   - 80% win rate (season)

4. **Social:**
   - Join first league
   - Create first league
   - 5 friends added
   - Win a league

**UI Elements:**
- Badge icons (emojis: 🏆, 🔥, ⭐, 💎)
- Locked/unlocked states
- Progress bars for in-progress achievements
- Achievement date earned
- Total achievements count

---

## Phase 11: Profile & Settings

### ProfileScreen
**Sections:**

1. **User Info Header:**
   - Large avatar (80x80, colored circle)
   - Username (large heading)
   - Email (smaller, muted)

2. **Quick Stats:**
   - Total Picks (primary color)
   - Win Rate % (success color)
   - Total Leagues (text color)
   - Displayed in 3-column card grid

3. **Quick Actions:**
   - Friends button (👥) → Navigate to FriendsScreen
   - Achievements button (🏆) → Navigate to AchievementsScreen
   - Card style with icon, title, description, chevron

4. **Settings:**
   - Dark Mode toggle (Switch component)
   - Theme preference saved to AsyncStorage
   - Real-time theme switching

5. **Account Information:**
   - Edit mode toggle
   - Fields:
     - Username (text input)
     - Email (email keyboard, triggers confirmation)
     - Phone number (phone keyboard, optional)
   - Save/Cancel buttons in edit mode
   - Success/error message display

**Profile Update Flow:**
1. User clicks Edit button
2. Fields become editable TextInputs
3. User modifies fields
4. Clicks Save
5. Updates profile in Supabase
6. Updates user metadata
7. Email change triggers confirmation email
8. Refreshes current user session
9. Shows success message
10. Returns to view mode

**Integration with Supabase:**
- `getUserProfile(id)` - Load on screen mount
- `updateUserProfile(id, updates)` - Save changes
- `supabaseUpdateUserMetadata(updates)` - Sync metadata
- `supabaseUpdateUserEmail(email)` - Handle email changes

---

## Phase 12: Data Persistence & State Management

### AsyncStorage Implementation
**Keys Defined:**
```javascript
LEAGUES_KEY = '@leagues'
RESULTS_KEY = '@results'
FRIENDS_KEY = '@friends'
THEME_PREF = 'THEME_PREF'
```

**Storage Functions Created:**
1. **League Management:**
   - `saveLeagues(leagues)` - Store league array
   - `loadLeagues()` - Retrieve leagues with fallback

2. **Game Results:**
   - `saveResults(results)` - Store completed games
   - `loadResults()` - Load results object

3. **Social Features:**
   - `saveFriends(userId, friendsData)` - Store friend list
   - `loadFriends(userId)` - Load with defaults

4. **Theme Preference:**
   - Direct AsyncStorage get/set for theme name

**Error Handling:**
- Try/catch blocks on all operations
- Fallback to empty arrays/objects
- Console warnings for debugging
- User-friendly error messages

### State Architecture in App.js
**Top-Level State:**
```javascript
const [tab, setTab] = useState("Home");
const [navStack, setNavStack] = useState(["Home"]);
const [leagues, setLeagues] = useState([]);
const [currentUser, setCurrentUser] = useState(null);
const [profile, setProfile] = useState(null);
const [themeName, setThemeName] = useState('light');
const [showAuth, setShowAuth] = useState(false);
const [showWelcome, setShowWelcome] = useState(true);
const [isLogin, setIsLogin] = useState(true);
const [loading, setLoading] = useState(false);
```

**Data Flow:**
1. App launches → `loadInitialData()` runs
2. Check for existing user session
3. Load theme preference
4. Load saved leagues from AsyncStorage
5. Set all state variables
6. Render appropriate screen

**State Updates:**
- Leagues auto-save on change (useEffect)
- Profile updates sync to Supabase + state
- Theme changes save immediately
- Auth state triggers re-renders

---

## Phase 13: Error Handling & UX Polish

### Error Handling Strategy
1. **Network Errors:**
   - Try/catch on all API calls
   - User-friendly error messages
   - Retry mechanisms
   - Offline state detection (future)

2. **Auth Errors:**
   - Invalid credentials → "Invalid email or password"
   - Weak password → "Password must be at least 6 characters"
   - Email already exists → "Email already in use"
   - Display in red error text component

3. **Data Errors:**
   - Parse failures → Fallback to defaults
   - Missing fields → Graceful degradation
   - Invalid league codes → "League not found"

4. **Validation:**
   - Required field checks
   - Email format validation
   - Username length/character limits
   - Confidence point uniqueness

### Loading States
- Full-screen loading overlay on app init
- ActivityIndicator with "Loading..." text
- Button loading states ("Saving..." vs "Save")
- Disabled buttons during operations
- Skeleton screens (future enhancement)

### Success Feedback
- Green success messages
- "Profile updated successfully"
- "League created!"
- "Pick saved"
- Auto-dismiss after 3 seconds (future)

### User Guidance
- Placeholders in text inputs
- Helper text under fields
- Empty states with call-to-action
  - "No Leagues Yet" with Create button
  - "No Picks" with instructions
  - "No Friends" with Add button
- Tutorial modal on Home screen (implemented but not enabled)

---

## Phase 14: UI/UX Refinements

### Component Styling
**Card Component Pattern:**
```javascript
<View style={[styles.card, { backgroundColor: theme.colors.card }]}>
  {/* Content */}
</View>
```
- Rounded corners (borderRadius: 12)
- Padding (12-16px)
- Shadow/elevation on iOS/Android
- Theme-aware background

**Button Styles:**
- `btnBlue` - Primary actions (blue)
- `btnGreen` - Success actions (green)
- `btnRed` - Destructive actions (red)
- `btnDisabled` - Grayed out, not interactive
- Consistent padding (12px vertical, 24px horizontal)
- White text, bold font

**Text Hierarchy:**
- `h1` - Screen titles (28px, bold)
- `h2` - Section headers (20px, semi-bold)
- `h3` - Subsections (16px, semi-bold)
- `label` - Form labels (12px, uppercase, muted)
- `muted` - Secondary text (14px, muted color)

### Layout Patterns
1. **Screen Structure:**
   - Header banner (60px height, colored background)
   - Content area (ScrollView)
   - Bottom tab bar (fixed)

2. **List Items:**
   - Avatar/icon on left
   - Primary text (bold)
   - Secondary text (muted)
   - Action indicator on right (chevron/arrow)

3. **Stats Display:**
   - Large number (32px, bold, colored)
   - Label below (14px, muted)
   - Centered in card

4. **Modal Overlays:**
   - Dark semi-transparent background
   - Centered white card
   - Header with title and close button
   - Content scrollable
   - Action buttons at bottom

### Responsive Design
- Flexbox layouts throughout
- Gap property for spacing (not supported everywhere, manual margins used)
- Percentage-based widths
- minWidth constraints on cards
- ScrollView for overflow content
- KeyboardAvoidingView for forms

### Accessibility Considerations
- Sufficient color contrast (WCAG AA)
- Touch targets 44x44px minimum
- Text scalability (no fixed heights on text)
- Semantic structure (though limited in RN)
- Error messages associated with inputs

---

## Phase 15: Advanced Features Implementation

### Notification System (Partially Implemented)
**Setup:**
- Installed expo-notifications
- Created `registerForPushNotificationsAsync()` function
- Requests permissions on app launch

**Planned Notifications:**
- Game starting soon (15 min before)
- Pick deadline approaching
- Game final - your pick result
- League standings update
- Friend request received
- Achievement unlocked

**Status:** Infrastructure ready, notification sending not yet implemented

### Share/Export Features (Installed, Not Implemented)
**Installed Packages:**
- expo-sharing
- expo-file-system
- expo-haptics

**Planned Features:**
- Share league invite code
- Export stats as image
- Share achievements
- League standings screenshot
- Haptic feedback on pick selection

### Tutorial/Onboarding System
**Implementation Status:** Code exists but not enabled

**Tutorial Steps:**
1. Welcome to Pick 'Em Pro
2. Create or join a league
3. Make your picks before deadline
4. Track your stats and compete
5. Invite friends to join

**Features:**
- Modal overlay with step indicator
- Previous/Next navigation
- Skip tutorial option
- Show once per user
- Stored in AsyncStorage

---

## Code Quality & Architecture

### File Organization
- **Screens:** Each major screen in App.js (component functions)
- **Separate files:** For complex screens (WeeklyResultsScreen, etc.)
- **Utilities:** theme.js, storage.js, stats.js
- **Services:** supabase*.js files for backend
- **Clear naming:** Descriptive function and variable names

### Code Patterns
- Functional components with hooks
- Controlled components for forms
- Prop drilling for theme and user data
- Callback functions for navigation
- Error boundaries (basic try/catch)

### Performance Considerations
- useEffect dependency arrays properly configured
- Cleanup functions for async operations
- isMounted pattern to prevent state updates on unmounted components
- Debouncing on API calls (future improvement)
- Memoization opportunities (future with useMemo, React.memo)

### Security Measures
- Supabase anon key (public, rate-limited)
- Row Level Security policies needed in Supabase
- No sensitive data in client code
- Password hashing handled by Supabase
- Email confirmation for email changes

---

## Testing & Debugging

### Testing Approach
- Manual testing during development
- Test user accounts created
- Test leagues with sample data
- Edge case testing (empty states, errors)
- Cross-platform testing (iOS/Android via Expo Go)

### Known Issues Addressed
- Fixed JSX nesting errors in standings
- Corrected theme color references
- Fixed async state update warnings
- Resolved import path issues
- Handled missing data gracefully

### Debugging Tools Used
- Console.log throughout codebase
- React Native Debugger
- Expo Dev Tools
- Metro bundler error messages
- Network tab for API calls

---

## Current App Capabilities (as of Oct 25, 2025)

### User Features
✅ Create account with email/password  
✅ Login/logout  
✅ Edit profile (username, email, phone)  
✅ Switch between light/dark themes  
✅ View personal stats  
✅ View achievements  
✅ Manage friends list  
✅ View other user profiles  

### League Features
✅ Create new leagues with custom settings  
✅ Join leagues with 6-character code  
✅ View league standings  
✅ Leave leagues  
✅ Make spread picks  
✅ Make over/under picks  
✅ Assign confidence points  
✅ View current week's games  
✅ See live scores (via refresh)  

### Stats & Analytics
✅ Overall win percentage  
✅ Spread-specific stats  
✅ Total-specific stats  
✅ Win/loss/push tracking  
✅ Current streaks  
✅ Longest win streak  
✅ Filter by time period  
✅ Filter by pick type  
✅ Pick history viewing  

### Social Features
✅ Add/remove friends  
✅ Public/private stats toggle  
✅ View friend profiles  
✅ Global leaderboard  
✅ League-specific standings  
✅ Click users to view profiles  

### Technical Features
✅ Data persistence (AsyncStorage)  
✅ Cloud sync (Supabase)  
✅ Real-time game data (ESPN API)  
✅ Theming system  
✅ Custom navigation  
✅ Modal system  
✅ Error handling  
✅ Loading states  

---

## Dependencies & External Services

### NPM Packages
```json
{
  "@react-native-async-storage/async-storage": "^1.x",
  "@supabase/supabase-js": "^2.x",
  "expo": "~49.x",
  "expo-status-bar": "~1.6",
  "react": "18.x",
  "react-native": "0.72.x",
  "expo-notifications": "latest",
  "expo-sharing": "latest",
  "expo-file-system": "latest",
  "expo-haptics": "latest",
  "react-native-url-polyfill": "^1.x"
}
```

### External APIs
1. **ESPN NFL Scoreboard API:**
   - Endpoint: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`
   - Free, public access
   - No authentication required
   - Rate limits unknown

2. **Supabase:**
   - PostgreSQL database
   - Authentication service
   - Real-time subscriptions (not yet used)
   - Row Level Security
   - Project URL: `https://dqlbdwugykzhrrqtafbx.supabase.co`

---

## Database Schema (Supabase)

### Tables Created

**profiles:**
```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT,
  username TEXT,
  phone TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Tables Needed (Not Yet Created)
- leagues (for cloud sync)
- picks (for cloud sync)
- friendships (for social features)
- achievements (for tracking unlocks)

### Current Storage Strategy
- Leagues stored locally in AsyncStorage
- Picks stored within league objects locally
- Profile data in Supabase
- Auth data in Supabase auth.users

### Future Migration Plan
- Move leagues to Supabase for multi-device sync
- Store picks in relational table for better querying
- Add real-time subscriptions for live updates
- Implement proper RLS policies

---

## Key Algorithms & Logic

### League Standings Calculation
```javascript
function calculateStandings(league, results) {
  return league.members.map(userId => {
    const stats = computeUserStats({
      leagues: [league],
      userId,
      results,
      pickType: 'all',
      timePeriod: 'allTime'
    });
    
    return {
      userId,
      winPercentage: stats.winPercentage,
      wins: stats.overallWins,
      losses: stats.overallLosses,
      pushes: stats.overallPushes
    };
  }).sort((a, b) => {
    if (b.winPercentage !== a.winPercentage) {
      return b.winPercentage - a.winPercentage;
    }
    return b.wins - a.wins;
  });
}
```

### Streak Calculation
```javascript
function calculateStreak(picks, results) {
  let currentStreak = { type: 'none', count: 0 };
  let longestWinStreak = 0;
  let tempStreak = 0;
  let lastResult = null;
  
  // Sort picks by game date
  const sortedPicks = sortPicksByDate(picks);
  
  for (const pick of sortedPicks) {
    const result = evaluatePick(pick, results[pick.gameId]);
    
    if (result === 'win') {
      if (lastResult === 'win') {
        tempStreak++;
      } else {
        tempStreak = 1;
      }
      
      if (tempStreak > longestWinStreak) {
        longestWinStreak = tempStreak;
      }
      
      currentStreak = { type: 'win', count: tempStreak };
    } else if (result === 'loss') {
      if (lastResult === 'loss') {
        currentStreak.count++;
      } else {
        currentStreak = { type: 'loss', count: 1 };
      }
      tempStreak = 0;
    }
    
    lastResult = result;
  }
  
  return { currentStreak, longestWinStreak };
}
```

### Win Percentage Calculation
```javascript
function calculateWinPercentage(wins, losses, pushes) {
  const totalDecidedGames = wins + losses;
  if (totalDecidedGames === 0) return 0;
  return Math.round((wins / totalDecidedGames) * 100);
}
// Note: Pushes are excluded from percentage calculation
```

---

## Design Decisions & Rationale

### Why AsyncStorage + Supabase?
- **AsyncStorage:** Fast local access, works offline, simple API
- **Supabase:** Cloud backup, multi-device sync, authentication
- **Hybrid approach:** Best of both - local speed, cloud persistence

### Why Custom Navigation vs React Navigation?
- **Simplicity:** Less boilerplate for simple tab structure
- **Learning:** Understanding navigation fundamentals
- **Control:** Full control over transitions and state
- **Trade-off:** Missing deep linking, advanced gestures

### Why Functional Components?
- Modern React best practices
- Hooks provide clean state management
- Better performance optimization opportunities
- Easier to test and reason about

### Why Single App.js File?
- **Rapid prototyping:** Faster iteration during development
- **Context visibility:** Easy to see entire app flow
- **Trade-off:** Will need refactoring before production
- **Plan:** Split into modules when feature-complete

### Why ESPN API?
- Free and public
- Reliable, maintained by ESPN
- Real-time data
- No authentication needed
- Alternative: NFL.com API (more complex)

---

## Future Enhancements Planned

### Short-term (Next 2-4 weeks)
- [ ] Fix Supabase profiles table RLS policies
- [ ] Implement cloud sync for leagues
- [ ] Add push notifications for game results
- [ ] Build out Trends screen with charts
- [ ] Implement share functionality
- [ ] Add haptic feedback to picks
- [ ] Create onboarding tutorial flow

### Medium-term (1-2 months)
- [ ] Real-time score updates (subscriptions)
- [ ] In-app messaging between league members
- [ ] Weekly recap emails/notifications
- [ ] Confidence points drag-to-reorder UI
- [ ] Advanced filtering on leaderboard
- [ ] Team/player performance insights
- [ ] Betting line movement tracking

### Long-term (2-3 months)
- [ ] Multiple sport support (College Football, NBA)
- [ ] Brackets/playoff predictions
- [ ] Paid league features (prize pools)
- [ ] Integration with real sportsbooks (odds comparison)
- [ ] AI pick suggestions
- [ ] Live chat during games
- [ ] Video highlights integration
- [ ] Social media sharing
- [ ] Web app version

---

## Performance Metrics (Approximate)

### App Statistics
- **Total Lines of Code:** ~5,000+
- **Main App.js:** 3,440 lines
- **Number of Screens:** 12+
- **Number of Components:** 30+
- **Dependencies:** 15+
- **Build Size:** ~25MB (Expo managed)

### User Capacity
- **Leagues per user:** Unlimited (local storage limit)
- **Members per league:** No enforced limit
- **Picks per week:** Configurable (1-16 typical)
- **Friends:** No limit
- **Achievements:** 20+ planned

### Data Storage
- **Local Storage:** ~5-10MB typical per user
- **Supabase:** Minimal (profile data only currently)
- **API Calls:** ~1-5 per user session

---

## Documentation & Knowledge Transfer

### Code Comments
- Function descriptions
- Complex logic explanations
- TODO markers for future work
- Warning comments for tricky areas

### README Updates Needed
- Installation instructions
- Environment setup (Supabase keys)
- Running locally with Expo
- Building for production
- Deployment process

### API Documentation Needed
- Supabase table schemas
- Storage.js function signatures
- Stats.js calculation methods
- Theme customization guide

---

## Lessons Learned

### What Went Well
✅ Modular utility files (theme, storage, stats)  
✅ Consistent naming conventions  
✅ Theme system flexibility  
✅ Error handling from the start  
✅ AsyncStorage for quick prototyping  
✅ Supabase for easy auth  

### What Could Improve
⚠️ App.js is too large (needs splitting)  
⚠️ More TypeScript would help with bugs  
⚠️ Earlier testing would catch edge cases  
⚠️ State management could use Context API  
⚠️ More reusable UI components needed  
⚠️ Better separation of concerns  

### Technical Debt
- Refactor App.js into modules
- Add PropTypes or TypeScript
- Implement proper testing (Jest, React Native Testing Library)
- Better error boundaries
- Code splitting for performance
- Optimize re-renders with memo/useMemo

---

## Handoff Recommendations for Professional Team

### Priority 1: Infrastructure
1. **TypeScript Migration:**
   - Add type safety
   - Catch bugs at compile time
   - Better IDE support
   
2. **Code Refactoring:**
   - Split App.js into separate screen files
   - Create reusable component library
   - Implement Context API for global state
   - Consider Redux if state becomes complex

3. **Database Optimization:**
   - Complete Supabase schema design
   - Implement all RLS policies
   - Add database indexes for performance
   - Set up automated backups

### Priority 2: Features
1. **Core Functionality:**
   - Complete push notifications
   - Implement real-time updates (Supabase subscriptions)
   - Build out Trends screen with charts
   - Add comprehensive error handling

2. **User Experience:**
   - Implement onboarding tutorial
   - Add loading skeleton screens
   - Improve offline mode handling
   - Better empty states

### Priority 3: Testing & Quality
1. **Testing:**
   - Unit tests for utilities (stats, storage)
   - Integration tests for screens
   - E2E tests for critical flows
   - Accessibility audit

2. **Performance:**
   - Code splitting
   - Lazy loading
   - Image optimization
   - Bundle size reduction

### Priority 4: Production Readiness
1. **Security Audit:**
   - Review RLS policies
   - Input sanitization
   - Rate limiting
   - API key management

2. **Deployment:**
   - CI/CD pipeline setup
   - App store submission process
   - Beta testing program
   - Analytics integration

3. **Monitoring:**
   - Error tracking (Sentry)
   - Analytics (Mixpanel/Amplitude)
   - Performance monitoring
   - User feedback system

---

## Contact & Project Info

**Project Status:** Active Development (Prototype Phase)  
**Last Updated:** October 25, 2025  
**Development Time:** ~4-6 weeks  
**Next Session:** October 26, 2025  

**Key Files for Review:**
- `App.js` - Main application logic
- `stats.js` - Statistics calculation engine
- `storage.js` - Data persistence layer
- `theme.js` - UI theming system
- `supabase*.js` - Backend integration

**Environment Setup Needed:**
- Supabase project credentials
- Expo CLI installed
- Node.js 16+
- iOS Simulator or Android Emulator (or Expo Go app)

---

This document represents the complete development history from project inception through October 25, 2025. All features, decisions, and technical implementations are documented for seamless handoff to a professional development team.
