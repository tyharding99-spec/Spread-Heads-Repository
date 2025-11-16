import AsyncStorage from '@react-native-async-storage/async-storage';

// Keys for AsyncStorage
const USERS_KEY = '@users';
const CURRENT_USER_KEY = '@currentUser';

// Helper function to get all users
export const getUsers = async () => {
  try {
    const usersJson = await AsyncStorage.getItem(USERS_KEY);
    return usersJson ? JSON.parse(usersJson) : [];
  } catch (error) {
    console.error('Error getting users:', error);
    return [];
  }
};

// Helper function to save all users
const saveUsers = async (users) => {
  try {
    await AsyncStorage.setItem(USERS_KEY, JSON.stringify(users));
  } catch (error) {
    console.error('Error saving users:', error);
  }
};

// Sign up new user
export const signUp = async ({ username, email, password }) => {
  try {
    // Defensive programming - ensure we have valid inputs
    if (!username || !email || !password) {
      console.error('Missing required fields:', { username, email, password });
      throw new Error('All fields are required');
    }

    // Input validation
    if (!username.trim()) throw new Error('Username is required');
    if (!email.trim()) throw new Error('Email is required');
    if (!password.trim()) throw new Error('Password is required');
    if (password.length < 6) throw new Error('Password must be at least 6 characters');
    if (!email.includes('@')) throw new Error('Invalid email format');

    const users = await getUsers();
    
    // Check if username or email already exists
    if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('Username already taken');
    }
    if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
      throw new Error('Email already registered');
    }

    // Create new user
    const newUser = {
      id: Date.now().toString(),
      username: username.trim(),
      email: email.toLowerCase().trim(),
      password, // In a real app, this should be hashed
      createdAt: new Date().toISOString(),
    };

    // Save user
    await saveUsers([...users, newUser]);
    
    // Save as current user
    await AsyncStorage.setItem(CURRENT_USER_KEY, JSON.stringify(newUser));

    return { user: newUser, error: null };
  } catch (error) {
    return { user: null, error: error.message };
  }
};

// Login user
export const login = async ({ username, password }) => {
  try {
    if (!username?.trim()) throw new Error('Username is required');
    if (!password?.trim()) throw new Error('Password is required');

    const users = await getUsers();
    const user = users.find(
      u => u.username.toLowerCase() === username.toLowerCase() && u.password === password
    );

    if (!user) {
      throw new Error('Invalid username or password');
    }

    // Save as current user
    await AsyncStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));

    return { user, error: null };
  } catch (error) {
    return { user: null, error: error.message };
  }
};

// Get current logged in user
export const getCurrentUser = async () => {
  try {
    const userJson = await AsyncStorage.getItem(CURRENT_USER_KEY);
    return userJson ? JSON.parse(userJson) : null;
  } catch (error) {
    console.error('Error getting current user:', error);
    return null;
  }
};

// Update username
export const updateUsername = async (userId, newUsername) => {
  try {
    if (!newUsername?.trim()) throw new Error('Username is required');
    
    const users = await getUsers();
    
    // Check if username is already taken by another user
    if (users.some(u => u.id !== userId && u.username.toLowerCase() === newUsername.toLowerCase())) {
      throw new Error('Username already taken');
    }

    // Update username in users list
    const updatedUsers = users.map(user => {
      if (user.id === userId) {
        return { ...user, username: newUsername.trim() };
      }
      return user;
    });

    // Save updated users
    await saveUsers(updatedUsers);

    // Update current user if this is them
    const currentUser = await getCurrentUser();
    if (currentUser && currentUser.id === userId) {
      const updatedUser = { ...currentUser, username: newUsername.trim() };
      await AsyncStorage.setItem(CURRENT_USER_KEY, JSON.stringify(updatedUser));
      return { user: updatedUser, error: null };
    }

    return { user: null, error: null };
  } catch (error) {
    return { user: null, error: error.message };
  }
};

// Logout user
export const logout = async () => {
  try {
    await AsyncStorage.removeItem(CURRENT_USER_KEY);
    return true;
  } catch (error) {
    console.error('Error logging out:', error);
    return false;
  }
};