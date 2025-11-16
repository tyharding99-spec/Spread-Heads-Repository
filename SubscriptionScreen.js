import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { getUserSubscription, updateUserSubscription, SUBSCRIPTION_FEATURES, cancelSubscription, getBillingHistory } from './subscriptionManager';

export const SubscriptionScreen = ({ currentUser, setTab }) => {
  const [currentSubscription, setCurrentSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [billingHistory, setBillingHistory] = useState([]);
  const userId = currentUser?.id;

  useEffect(() => {
    loadSubscription();
  }, []);

  const loadSubscription = async () => {
    const subscription = await getUserSubscription(userId);
    setCurrentSubscription(subscription);
    const history = await getBillingHistory(userId);
    setBillingHistory(history);
    setLoading(false);
  };

  const handleUpgrade = async (plan) => {
    // In a real app, this would integrate with a payment processor
    Alert.alert(
      'Confirm Subscription',
      `Would you like to upgrade to ${SUBSCRIPTION_FEATURES[plan].name} for $${SUBSCRIPTION_FEATURES[plan].price}/month?`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Subscribe',
          onPress: async () => {
            setProcessing(true);
            try {
              const success = await updateUserSubscription(userId, plan);
              if (success) {
                await loadSubscription();
                Alert.alert(
                  'Success!',
                  `You are now a ${SUBSCRIPTION_FEATURES[plan].name} subscriber!`,
                  [{ text: 'OK', onPress: () => setTab('Trends') }]
                );
              } else {
                Alert.alert('Error', 'Failed to process subscription');
              }
            } catch (error) {
              Alert.alert('Error', 'An unexpected error occurred');
            } finally {
              setProcessing(false);
            }
          },
        },
      ]
    );
  };

  const handleCancel = async () => {
    Alert.alert(
      'Cancel Subscription',
      'Are you sure you want to cancel your subscription? You will lose premium access.',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes, Cancel',
          onPress: async () => {
            setProcessing(true);
            const success = await cancelSubscription(userId);
            if (success) {
              await loadSubscription();
              Alert.alert('Cancelled', 'Your subscription was cancelled.');
            } else {
              Alert.alert('Error', 'Unable to cancel subscription.');
            }
            setProcessing(false);
          }
        }
      ]
    );
  }

  const renderFeatureList = (features) => (
    <View style={styles.featureList}>
      {features.map((feature, index) => (
        <View key={index} style={styles.featureItem}>
          <Text style={styles.featureIcon}>✓</Text>
          <Text style={styles.featureText}>{feature}</Text>
        </View>
      ))}
    </View>
  );

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.h1}>Subscription Plans</Text>
      
      {/* Current Plan Card */}
      <View style={styles.currentPlanCard}>
        <Text style={styles.currentPlanTitle}>Current Plan</Text>
        <Text style={styles.planName}>
          {SUBSCRIPTION_FEATURES[currentSubscription.plan].name}
        </Text>
        {currentSubscription.expiryDate && (
          <Text style={styles.expiryDate}>
            Expires: {new Date(currentSubscription.expiryDate).toLocaleDateString()}
          </Text>
        )}
      </View>

      {/* Subscription Plans */}
      {Object.entries(SUBSCRIPTION_FEATURES).map(([planId, plan]) => (
        <View 
          key={planId}
          style={[
            styles.planCard,
            currentSubscription.plan === planId && styles.currentPlanCard
          ]}
        >
          <View style={styles.planHeader}>
            <Text style={styles.planName}>{plan.name}</Text>
            <Text style={styles.planPrice}>
              ${plan.price.toFixed(2)}
              <Text style={styles.monthly}>/month</Text>
            </Text>
          </View>

          {renderFeatureList(plan.features)}

          {currentSubscription.plan !== planId && (
            <Pressable
              style={[styles.upgradeButton, processing && styles.buttonDisabled]}
              onPress={() => handleUpgrade(planId)}
              disabled={processing}
            >
              <Text style={styles.upgradeButtonText}>
                {processing ? 'Processing...' : 'Upgrade'}
              </Text>
            </Pressable>
          )}
        </View>
      ))}

      {/* Benefits Section */}
      <View style={styles.benefitsSection}>
        <Text style={styles.benefitsTitle}>Why Subscribe?</Text>
        <View style={styles.benefitsList}>
          <View style={styles.benefitItem}>
            <Text style={styles.benefitTitle}>Enhanced Analysis</Text>
            <Text style={styles.benefitDesc}>
              Get deep insights into team performance and trends
            </Text>
          </View>
          <View style={styles.benefitItem}>
            <Text style={styles.benefitTitle}>Exclusive Content</Text>
            <Text style={styles.benefitDesc}>
              Access expert picks and analysis not available to free users
            </Text>
          </View>
          <View style={styles.benefitItem}>
            <Text style={styles.benefitTitle}>Advanced Stats</Text>
            <Text style={styles.benefitDesc}>
              Dive deep into situational statistics and historical data
            </Text>
          </View>
        </View>
      </View>

      {/* FAQ Section */}
      <View style={styles.faqSection}>
        <Text style={styles.faqTitle}>Frequently Asked Questions</Text>
        <View style={styles.faqItem}>
          <Text style={styles.faqQuestion}>Can I cancel anytime?</Text>
          <Text style={styles.faqAnswer}>
            Yes, you can cancel your subscription at any time. Your benefits will continue until the end of your billing period.
          </Text>
        </View>
        <View style={styles.faqItem}>
          <Text style={styles.faqQuestion}>What payment methods do you accept?</Text>
          <Text style={styles.faqAnswer}>
            We accept all major credit cards and PayPal.
          </Text>
        </View>
        <View style={styles.faqItem}>
          <Text style={styles.faqQuestion}>How do I access premium features?</Text>
          <Text style={styles.faqAnswer}>
            Premium features are automatically unlocked as soon as your subscription is processed.
          </Text>
        </View>
      </View>

      {/* Billing History */}
      <View style={{ marginTop: 24 }}>
        <Text style={[styles.h2, { marginBottom: 12 }]}>Billing History</Text>
        {billingHistory.length === 0 ? (
          <Text style={styles.muted}>No billing history available.</Text>
        ) : (
          billingHistory.map((h, idx) => (
            <View key={idx} style={[styles.planCard, { padding: 12, marginBottom: 8 }]}>
              <Text style={{ fontWeight: '700' }}>{h.type === 'subscription' ? 'Subscription' : 'Cancellation'}</Text>
              <Text style={styles.muted}>{h.plan}</Text>
              <Text style={styles.muted}>${h.amount?.toFixed ? h.amount.toFixed(2) : h.amount} • {new Date(h.date).toLocaleString()}</Text>
            </View>
          ))
        )}
      </View>

      {/* Cancel Button (if subscribed to paid plan) */}
      {currentSubscription.plan !== 'free' && (
        <View style={{ marginTop: 16, alignItems: 'center' }}>
          <Pressable style={[styles.upgradeButton, { backgroundColor: '#dc2626' }]} onPress={handleCancel} disabled={processing}>
            <Text style={styles.upgradeButtonText}>{processing ? 'Processing...' : 'Cancel Subscription'}</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    backgroundColor: '#f3f4f6',
  },
  h1: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 20,
  },
  currentPlanCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    elevation: 2,
    borderWidth: 2,
    borderColor: '#2563eb',
  },
  currentPlanTitle: {
    fontSize: 14,
    color: '#2563eb',
    fontWeight: '600',
    marginBottom: 4,
  },
  expiryDate: {
    color: '#6b7280',
    marginTop: 8,
  },
  planCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    elevation: 2,
  },
  planHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  planName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1f2937',
  },
  planPrice: {
    fontSize: 24,
    fontWeight: '700',
    color: '#2563eb',
  },
  monthly: {
    fontSize: 14,
    color: '#6b7280',
  },
  featureList: {
    marginBottom: 16,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  featureIcon: {
    color: '#16a34a',
    marginRight: 8,
    fontWeight: '700',
  },
  featureText: {
    color: '#4b5563',
    flex: 1,
  },
  upgradeButton: {
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  upgradeButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  benefitsSection: {
    marginTop: 24,
    marginBottom: 32,
  },
  benefitsTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 16,
  },
  benefitsList: {
    gap: 16,
  },
  benefitItem: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    elevation: 2,
  },
  benefitTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 4,
  },
  benefitDesc: {
    color: '#6b7280',
  },
  faqSection: {
    marginBottom: 32,
  },
  faqTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 16,
  },
  faqItem: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    elevation: 2,
  },
  faqQuestion: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 8,
  },
  faqAnswer: {
    color: '#6b7280',
  },
});