import React from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';

/**
 * Weekly Recap Component
 * Shows summary of user's weekly performance
 */
export const WeeklyRecap = ({ 
  currentWeekPoints, 
  previousWeekPoints, 
  correctPicks, 
  totalPicks,
  streak,
  theme,
  onViewDetails 
}) => {
  const delta = currentWeekPoints - (previousWeekPoints || 0);
  const deltaSign = delta > 0 ? '+' : '';
  const correctPercentage = totalPicks > 0 ? Math.round((correctPicks / totalPicks) * 100) : 0;
  
  return (
    <View style={[styles.container, { backgroundColor: theme?.colors?.card }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme?.colors?.text }]}>
          📊 Weekly Recap
        </Text>
        {onViewDetails && (
          <Pressable onPress={onViewDetails}>
            <Text style={[styles.viewDetails, { color: theme?.colors?.primary }]}>
              View Details →
            </Text>
          </Pressable>
        )}
      </View>

      {/* Stats Grid */}
      <View style={styles.statsGrid}>
        {/* Total Points */}
        <View style={[styles.statBox, { backgroundColor: theme?.colors?.background }]}>
          <Text style={[styles.statValue, { color: theme?.colors?.primary }]}>
            {currentWeekPoints}
          </Text>
          <Text style={[styles.statLabel, { color: theme?.colors?.muted }]}>
            Points This Week
          </Text>
          {previousWeekPoints !== null && previousWeekPoints !== undefined && (
            <Text style={[
              styles.delta, 
              { color: delta >= 0 ? theme?.colors?.success : theme?.colors?.error }
            ]}>
              {deltaSign}{delta} vs last week
            </Text>
          )}
        </View>

        {/* Correctness */}
        <View style={[styles.statBox, { backgroundColor: theme?.colors?.background }]}>
          <Text style={[styles.statValue, { color: theme?.colors?.success }]}>
            {correctPicks}/{totalPicks}
          </Text>
          <Text style={[styles.statLabel, { color: theme?.colors?.muted }]}>
            Correct Picks
          </Text>
          <Text style={[styles.delta, { color: theme?.colors?.text }]}>
            {correctPercentage}% accuracy
          </Text>
        </View>

        {/* Streak */}
        {streak !== null && streak !== undefined && streak > 0 && (
          <View style={[styles.statBox, { backgroundColor: theme?.colors?.background }]}>
            <Text style={[styles.statValue, { color: '#FF9500' }]}>
              {streak} 🔥
            </Text>
            <Text style={[styles.statLabel, { color: theme?.colors?.muted }]}>
              Win Streak
            </Text>
          </View>
        )}
      </View>

      {/* Breakdown */}
      {correctPicks > 0 || (totalPicks - correctPicks) > 0 ? (
        <View style={styles.breakdown}>
          <Text style={[styles.breakdownTitle, { color: theme?.colors?.text }]}>
            Pick Breakdown
          </Text>
          <View style={styles.breakdownBar}>
            {correctPicks > 0 && (
              <View 
                style={[
                  styles.breakdownSegment, 
                  { 
                    backgroundColor: theme?.colors?.success, 
                    flex: correctPicks 
                  }
                ]} 
              />
            )}
            {(totalPicks - correctPicks) > 0 && (
              <View 
                style={[
                  styles.breakdownSegment, 
                  { 
                    backgroundColor: theme?.colors?.error, 
                    flex: totalPicks - correctPicks 
                  }
                ]} 
              />
            )}
          </View>
          <View style={styles.breakdownLegend}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: theme?.colors?.success }]} />
              <Text style={[styles.legendText, { color: theme?.colors?.muted }]}>
                Correct ({correctPicks})
              </Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: theme?.colors?.error }]} />
              <Text style={[styles.legendText, { color: theme?.colors?.muted }]}>
                Incorrect ({totalPicks - correctPicks})
              </Text>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  viewDetails: {
    fontSize: 14,
    fontWeight: '600',
  },
  statsGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  statBox: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 11,
    textAlign: 'center',
    marginBottom: 4,
  },
  delta: {
    fontSize: 12,
    fontWeight: '600',
  },
  breakdown: {
    marginTop: 8,
  },
  breakdownTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  breakdownBar: {
    height: 8,
    borderRadius: 4,
    flexDirection: 'row',
    overflow: 'hidden',
    marginBottom: 8,
  },
  breakdownSegment: {
    height: '100%',
  },
  breakdownLegend: {
    flexDirection: 'row',
    gap: 16,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 12,
  },
});
