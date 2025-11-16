import AsyncStorage from '@react-native-async-storage/async-storage';

const SUBSCRIPTIONS_KEY = '@subscriptions';
const BILLING_HISTORY_KEY = '@billingHistory';
const SUBSCRIPTION_PLANS = {
  FREE: 'free',
  PREMIUM: 'premium',
  PRO: 'pro'
};

export const SUBSCRIPTION_FEATURES = {
  [SUBSCRIPTION_PLANS.FREE]: {
    name: 'Free',
    price: 0,
    features: [
      'Access to your league stats',
      'Basic team statistics',
      'Weekly matchup data',
      'League-specific trends'
    ]
  },
  [SUBSCRIPTION_PLANS.PREMIUM]: {
    name: 'Premium',
    price: 4.99,
    features: [
      'All Free features',
      'League comparison tools',
      'Historical team data',
      'Advanced statistics',
      'Win probability calculator'
    ]
  },
  [SUBSCRIPTION_PLANS.PRO]: {
    name: 'Pro',
    price: 9.99,
    features: [
      'All Premium features',
      'Real-time odds updates',
      'Expert picks and analysis',
      'Custom trend alerts',
      'Priority support',
      'Early access to new features'
    ]
  }
};

export const getUserSubscription = async (userId) => {
  try {
    const subscriptionsJson = await AsyncStorage.getItem(SUBSCRIPTIONS_KEY);
    const subscriptions = subscriptionsJson ? JSON.parse(subscriptionsJson) : {};
    return subscriptions[userId] || {
      plan: SUBSCRIPTION_PLANS.FREE,
      status: 'active',
      startDate: new Date().toISOString(),
      expiryDate: null
    };
  } catch (error) {
    console.error('Error getting subscription:', error);
    return { plan: SUBSCRIPTION_PLANS.FREE };
  }
};

export const updateUserSubscription = async (userId, plan) => {
  try {
    const subscriptionsJson = await AsyncStorage.getItem(SUBSCRIPTIONS_KEY);
    const subscriptions = subscriptionsJson ? JSON.parse(subscriptionsJson) : {};
    
    const now = new Date().toISOString();
    const expiry = plan === SUBSCRIPTION_PLANS.FREE ? null :
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    subscriptions[userId] = {
      plan,
      status: 'active',
      startDate: now,
      expiryDate: expiry
    };

    await AsyncStorage.setItem(SUBSCRIPTIONS_KEY, JSON.stringify(subscriptions));

    // Record billing event for purchases/upgrades (free plan changes are recorded too)
    await recordBillingEvent(userId, {
      type: 'subscription',
      plan,
      amount: SUBSCRIPTION_PLANS.FREE === plan ? 0 : (plan === SUBSCRIPTION_PLANS.PREMIUM ? 4.99 : 9.99),
      date: now
    });

    return true;
  } catch (error) {
    console.error('Error updating subscription:', error);
    return false;
  }
};

export const cancelSubscription = async (userId) => {
  try {
    const subscriptionsJson = await AsyncStorage.getItem(SUBSCRIPTIONS_KEY);
    const subscriptions = subscriptionsJson ? JSON.parse(subscriptionsJson) : {};

    const existing = subscriptions[userId];
    if (!existing || existing.plan === SUBSCRIPTION_PLANS.FREE) {
      // nothing to cancel
      return false;
    }

    // mark as cancelled and set expiry to now
    const now = new Date().toISOString();
    subscriptions[userId] = {
      plan: SUBSCRIPTION_PLANS.FREE,
      status: 'cancelled',
      startDate: existing.startDate || now,
      expiryDate: now
    };

    await AsyncStorage.setItem(SUBSCRIPTIONS_KEY, JSON.stringify(subscriptions));

    await recordBillingEvent(userId, {
      type: 'cancellation',
      plan: existing.plan,
      amount: 0,
      date: now
    });

    return true;
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    return false;
  }
};

const recordBillingEvent = async (userId, event) => {
  try {
    const billingJson = await AsyncStorage.getItem(BILLING_HISTORY_KEY);
    const history = billingJson ? JSON.parse(billingJson) : [];
    history.push({ userId, ...event });
    await AsyncStorage.setItem(BILLING_HISTORY_KEY, JSON.stringify(history));
    return true;
  } catch (error) {
    console.error('Error recording billing event:', error);
    return false;
  }
};

export const getBillingHistory = async (userId) => {
  try {
    const billingJson = await AsyncStorage.getItem(BILLING_HISTORY_KEY);
    const history = billingJson ? JSON.parse(billingJson) : [];
    return history.filter(h => h.userId === userId).sort((a,b)=> new Date(b.date)-new Date(a.date));
  } catch (error) {
    console.error('Error getting billing history:', error);
    return [];
  }
};