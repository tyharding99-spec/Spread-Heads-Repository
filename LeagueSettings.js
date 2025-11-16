import React from 'react';
import {
  View,
  Text,
  Switch,
  TextInput,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import { LEAGUE_TYPES } from './leagueTypes';

export const LeagueSettings = ({ type, settings, onSettingsChange }) => {
  const updateSetting = (key, value) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  // Render settings based on league type
  const renderSettingsByType = () => {
    switch (type) {
      case LEAGUE_TYPES.INDIVIDUAL:
        return <IndividualSettings />;
      case LEAGUE_TYPES.FREE_FOR_ALL:
        return <FreeForAllSettings />;
      case LEAGUE_TYPES.SURVIVOR:
        return <SurvivorSettings />;
      case LEAGUE_TYPES.HEAD_TO_HEAD:
        return <HeadToHeadSettings />;
      case LEAGUE_TYPES.MONEYLINE_MANIA:
        return <MoneylineManiaSettings />;
      default:
        return <CommonSettings />;
    }
  };

  // Individual League Settings - simplified, no competition
  const IndividualSettings = () => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>League Settings</Text>
      
      <View style={styles.settingItem}>
        <Text style={styles.label}>Line Lock Time</Text>
      </View>
      <View style={styles.settingItemColumn}>
        <Text style={styles.helpText}>When do spreads and totals lock before game time?</Text>
        <View style={styles.buttonGrid}>
          {[
            { label: '1 Hour', value: 1 },
            { label: '2 Hours', value: 2 },
            { label: '3 Hours', value: 3 },
            { label: '6 Hours', value: 6 },
            { label: '12 Hours', value: 12 },
            { label: '24 Hours', value: 24 },
          ].map(option => (
            <Pressable
              key={option.value}
              style={[
                styles.gridOptionButton,
                settings.lineLockTime === option.value && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('lineLockTime', option.value)}
            >
              <Text style={settings.lineLockTime === option.value ? styles.optionTextSelected : styles.optionText}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Pick Deadline</Text>
      </View>
      <View style={styles.settingItemColumn}>
        <Text style={styles.helpText}>Lock picks X hours before each game starts</Text>
        <View style={styles.buttonGroup}>
          {[0, 0.5, 1, 2, 3, 6].map(hours => (
            <Pressable
              key={hours}
              style={[
                styles.optionButton,
                settings.pickDeadlineOffset === hours && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('pickDeadlineOffset', hours)}
            >
              <Text style={settings.pickDeadlineOffset === hours ? styles.optionTextSelected : styles.optionText}>
                {hours === 0 ? 'Kickoff' : `${hours}h`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );

  // Free For All & Moneyline Mania Settings - competitive, need tiebreakers
  const FreeForAllSettings = () => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>League Settings</Text>
      
      <View style={styles.settingItem}>
        <Text style={styles.label}>Line Lock Time</Text>
      </View>
      <View style={styles.settingItemColumn}>
        <Text style={styles.helpText}>When do spreads and totals lock before game time?</Text>
        <View style={styles.buttonGrid}>
          {[
            { label: '1 Hour', value: 1 },
            { label: '2 Hours', value: 2 },
            { label: '3 Hours', value: 3 },
            { label: '6 Hours', value: 6 },
            { label: '12 Hours', value: 12 },
            { label: '24 Hours', value: 24 },
          ].map(option => (
            <Pressable
              key={option.value}
              style={[
                styles.gridOptionButton,
                settings.lineLockTime === option.value && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('lineLockTime', option.value)}
            >
              <Text style={settings.lineLockTime === option.value ? styles.optionTextSelected : styles.optionText}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.settingItemColumn}>
        <Text style={styles.label}>Tiebreaker Rules</Text>
        <Text style={styles.helpText}>How should ties be broken on the leaderboard?</Text>
        <View style={styles.buttonGrid}>
          {[
            { label: 'Total Points', value: 'totalPoints', desc: 'Most total points wins' },
            { label: 'Win Percentage', value: 'winPercentage', desc: 'Highest win % wins' },
            { label: 'Best Week', value: 'bestWeek', desc: 'Highest single week score' },
            { label: 'Fewest Missed', value: 'fewestMissed', desc: 'Least missed picks' },
          ].map(option => (
            <Pressable
              key={option.value}
              style={[
                styles.tiebreakerButton,
                settings.tiebreaker === option.value && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('tiebreaker', option.value)}
            >
              <Text style={[
                styles.tiebreakerLabel,
                settings.tiebreaker === option.value && styles.optionTextSelected
              ]}>
                {option.label}
              </Text>
              <Text style={[
                styles.tiebreakerDesc,
                settings.tiebreaker === option.value && { color: 'rgba(255,255,255,0.8)' }
              ]}>
                {option.desc}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Show Other Players' Picks</Text>
        <Switch
          value={settings.showOthersPicks}
          onValueChange={(value) => updateSetting('showOthersPicks', value)}
        />
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Pick Deadline</Text>
      </View>
      <View style={styles.settingItemColumn}>
        <Text style={styles.helpText}>Lock picks X hours before each game starts</Text>
        <View style={styles.buttonGroup}>
          {[0, 0.5, 1, 2, 3, 6].map(hours => (
            <Pressable
              key={hours}
              style={[
                styles.optionButton,
                settings.pickDeadlineOffset === hours && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('pickDeadlineOffset', hours)}
            >
              <Text style={settings.pickDeadlineOffset === hours ? styles.optionTextSelected : styles.optionText}>
                {hours === 0 ? 'Kickoff' : `${hours}h`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {type === LEAGUE_TYPES.FREE_FOR_ALL && (
        <View style={styles.settingItem}>
          <Text style={styles.label}>Weekly Prizes</Text>
          <Switch
            value={settings.weeklyPrizes}
            onValueChange={(value) => updateSetting('weeklyPrizes', value)}
          />
        </View>
      )}
    </View>
  );

  // Moneyline Mania uses same settings as Free For All
  const MoneylineManiaSettings = () => <FreeForAllSettings />;

  // Survivor Settings
  const SurvivorSettings = () => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>League Settings</Text>
      
      <View style={styles.settingItem}>
        <Text style={styles.label}>Line Lock Time</Text>
      </View>
      <View style={styles.settingItemColumn}>
        <Text style={styles.helpText}>When do spreads and totals lock before game time?</Text>
        <View style={styles.buttonGrid}>
          {[
            { label: '1 Hour', value: 1 },
            { label: '2 Hours', value: 2 },
            { label: '3 Hours', value: 3 },
            { label: '6 Hours', value: 6 },
            { label: '12 Hours', value: 12 },
            { label: '24 Hours', value: 24 },
          ].map(option => (
            <Pressable
              key={option.value}
              style={[
                styles.gridOptionButton,
                settings.lineLockTime === option.value && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('lineLockTime', option.value)}
            >
              <Text style={settings.lineLockTime === option.value ? styles.optionTextSelected : styles.optionText}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Players Eliminated Per Week</Text>
        <View style={styles.buttonGroup}>
          {[1, 2, 3].map(num => (
            <Pressable
              key={num}
              style={[
                styles.optionButton,
                settings.eliminationCount === num && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('eliminationCount', num)}
            >
              <Text style={settings.eliminationCount === num ? styles.optionTextSelected : styles.optionText}>
                {num}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Allow Tiebreaker Games</Text>
        <Switch
          value={settings.allowTieBreaker}
          onValueChange={(value) => updateSetting('allowTieBreaker', value)}
        />
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Show Other Players' Picks</Text>
        <Switch
          value={settings.showOthersPicks}
          onValueChange={(value) => updateSetting('showOthersPicks', value)}
        />
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Pick Deadline</Text>
      </View>
      <View style={styles.settingItemColumn}>
        <Text style={styles.helpText}>Lock picks X hours before each game starts</Text>
        <View style={styles.buttonGroup}>
          {[0, 0.5, 1, 2, 3, 6].map(hours => (
            <Pressable
              key={hours}
              style={[
                styles.optionButton,
                settings.pickDeadlineOffset === hours && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('pickDeadlineOffset', hours)}
            >
              <Text style={settings.pickDeadlineOffset === hours ? styles.optionTextSelected : styles.optionText}>
                {hours === 0 ? 'Kickoff' : `${hours}h`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );

  // Head to Head Settings
  const HeadToHeadSettings = () => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>League Settings</Text>
      
      <View style={styles.settingItem}>
        <Text style={styles.label}>Line Lock Time</Text>
      </View>
      <View style={styles.settingItemColumn}>
        <Text style={styles.helpText}>When do spreads and totals lock before game time?</Text>
        <View style={styles.buttonGrid}>
          {[
            { label: '1 Hour', value: 1 },
            { label: '2 Hours', value: 2 },
            { label: '3 Hours', value: 3 },
            { label: '6 Hours', value: 6 },
            { label: '12 Hours', value: 12 },
            { label: '24 Hours', value: 24 },
          ].map(option => (
            <Pressable
              key={option.value}
              style={[
                styles.gridOptionButton,
                settings.lineLockTime === option.value && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('lineLockTime', option.value)}
            >
              <Text style={settings.lineLockTime === option.value ? styles.optionTextSelected : styles.optionText}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Number of Playoff Teams</Text>
        <View style={styles.buttonGroup}>
          {[4, 6, 8].map(num => (
            <Pressable
              key={num}
              style={[
                styles.optionButton,
                settings.playoffTeams === num && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('playoffTeams', num)}
            >
              <Text style={settings.playoffTeams === num ? styles.optionTextSelected : styles.optionText}>
                {num}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Playoff Start Week</Text>
        <View style={styles.buttonGroup}>
          {[14, 15, 16].map(week => (
            <Pressable
              key={week}
              style={[
                styles.optionButton,
                settings.playoffStartWeek === week && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('playoffStartWeek', week)}
            >
              <Text style={settings.playoffStartWeek === week ? styles.optionTextSelected : styles.optionText}>
                Week {week}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Show Other Players' Picks</Text>
        <Switch
          value={settings.showOthersPicks}
          onValueChange={(value) => updateSetting('showOthersPicks', value)}
        />
      </View>

      <View style={styles.settingItem}>
        <Text style={styles.label}>Pick Deadline</Text>
      </View>
      <View style={styles.settingItemColumn}>
        <Text style={styles.helpText}>Lock picks X hours before each game starts</Text>
        <View style={styles.buttonGroup}>
          {[0, 0.5, 1, 2, 3, 6].map(hours => (
            <Pressable
              key={hours}
              style={[
                styles.optionButton,
                settings.pickDeadlineOffset === hours && styles.optionButtonSelected
              ]}
              onPress={() => updateSetting('pickDeadlineOffset', hours)}
            >
              <Text style={settings.pickDeadlineOffset === hours ? styles.optionTextSelected : styles.optionText}>
                {hours === 0 ? 'Kickoff' : `${hours}h`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );

  // Common settings removed - now each type has its own settings
  
  return (
    <ScrollView style={styles.container}>
      {renderSettingsByType()}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  section: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 16,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  settingItemColumn: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  helpText: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 12,
  },
  label: {
    fontSize: 16,
    color: '#374151',
    flex: 1,
  },
  buttonGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  buttonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  gridOptionButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: 'white',
    minWidth: 80,
    alignItems: 'center',
  },
  optionButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: 'white',
  },
  optionButtonSelected: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  optionText: {
    color: '#374151',
    fontSize: 14,
  },
  optionTextSelected: {
    color: 'white',
    fontSize: 14,
  },
  tiebreakerButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: 'white',
    minWidth: '48%',
    marginBottom: 8,
  },
  tiebreakerLabel: {
    color: '#374151',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  tiebreakerDesc: {
    color: '#6b7280',
    fontSize: 12,
  },
});