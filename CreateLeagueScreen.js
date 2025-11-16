import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import { LEAGUE_TYPES, LEAGUE_TYPE_DETAILS } from './leagueTypes';
import { createLeague as supabaseCreateLeague } from './supabaseLeague';
import { normalizeLeagueSettings } from './leagueSettingsUtil';
import { createUserProfile, getUserProfile } from './supabaseProfile';
import { LeagueSettings } from './LeagueSettings';

export const CreateLeagueScreen = ({ leagues, setLeagues, currentUser, setTab, theme, styles: appStyles }) => {
  const [form, setForm] = useState({
    name: '',
    type: null,
    settings: {
      // Default settings that will be overridden based on league type
      startDate: new Date().toISOString(),
      scoringSystem: 'standard', // standard: 1 point per correct pick
      tiebreaker: 'totalPoints', // Default tiebreaker: most total points
      lineLockTime: 1, // Lock lines 1 hour before game time by default
      // Head to Head specific
      playoffTeams: 4,
      playoffStartWeek: 15,
      // Survivor specific
      eliminationCount: 1, // number of players eliminated per week
      allowTieBreaker: true,
      // Free for All specific
      weeklyPrizes: false,
      showOthersPicks: false,
      // Individual specific
      privateMode: false,
    }
  });
  const [step, setStep] = useState(1); // 1: Type Selection, 2: Settings

  const generateLeagueCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding similar looking characters
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };

  const handleTypeSelect = (type) => {
    setForm(f => ({ ...f, type }));
    setStep(2);
  };

  const handleCreateLeague = () => {
    if (!form.type) {
      Alert.alert('Error', 'Please select a league type');
      return;
    }
    if (!form.name.trim()) {
      Alert.alert('Error', 'Please enter a league name');
      return;
    }

    const code = generateLeagueCode();
    const userId = currentUser?.id;

    // Derive lock offset minutes from settings.lineLockTime (in hours)
    const deriveLockMinutes = (settings) => {
      const v = settings?.lineLockTime;
      if (typeof v === 'number' && !Number.isNaN(v)) return Math.max(0, Math.round(v * 60));
      if (v === 'opening') return 60; // temporary mapping; can be refined later
      return 60; // default 1 hour
    };
    const lockOffsetMinutes = deriveLockMinutes(form.settings);

    const normalizedSettings = normalizeLeagueSettings(form.type, {
      ...form.settings,
    });

    const newLeague = {
      name: form.name.trim(),
      code,
      type: form.type,
      description: '',
      creator: userId,
      members: [userId],
      createdAt: new Date().toISOString(),
      settings: {
        // Canonical normalized settings
        ...normalizedSettings,
        // Keep min/max players and status outside canonical block
        minPlayers: LEAGUE_TYPE_DETAILS[form.type].minPlayers,
        maxPlayers: LEAGUE_TYPE_DETAILS[form.type].maxPlayers,
        isActive: false,
      },
      picks: {},
      standings: [],
      // For Survivor leagues
      eliminatedUsers: [],
      // For Head to Head leagues
      schedule: [],
      records: {},
    };

    // Ensure user profile exists before creating league
    const ensureProfileExists = async () => {
      const { data: existingProfile, error: profileError } = await getUserProfile(userId);
      
      if (profileError && profileError.code !== 'PGRST116') {
        // Real error (not just "no rows")
        Alert.alert('Error', 'Failed to verify user profile: ' + profileError.message);
        return false;
      }
      
      if (!existingProfile) {
        // Profile doesn't exist, create it
        const { error: createError } = await createUserProfile({
          id: userId,
          email: currentUser?.email || '',
          username: currentUser?.username || currentUser?.email?.split('@')[0] || 'user',
          display_name: currentUser?.displayName || currentUser?.username || 'User'
        });
        
        if (createError) {
          Alert.alert('Error', 'Failed to create user profile: ' + createError.message);
          return false;
        }
      }
      
      return true;
    };

    // Save league to Supabase
    ensureProfileExists().then(profileReady => {
      if (!profileReady) return;
      
      supabaseCreateLeague({
        name: newLeague.name,
        code: newLeague.code,
        created_by: newLeague.creator,
        members: newLeague.members,
        settings: newLeague.settings,
        description: newLeague.description,
        type: newLeague.type
      }).then(({ data, error }) => {
        if (error) {
          Alert.alert('Error', 'Failed to create league: ' + error.message);
        } else {
          setLeagues([...leagues, data]);
          Alert.alert(
            'Success!',
            `League created! Your league code is: ${code}`,
            [{ text: 'OK', onPress: () => setTab('Home') }]
          );
        }
      });
    });
  };

  const renderStep = () => {
    switch (step) {
      case 1: // League Type Selection
        return (
          <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
            <Text style={[styles.h1, { color: theme?.colors?.text }]}>Create a League</Text>
            <Text style={[styles.h2, { color: theme?.colors?.text }]}>Select League Type</Text>
            
            {Object.entries(LEAGUE_TYPE_DETAILS).map(([type, details]) => (
              <Pressable
                key={type}
                style={[styles.typeCard, { backgroundColor: theme?.colors?.card, borderColor: theme?.colors?.border }]}
                onPress={() => handleTypeSelect(type)}
              >
                <Text style={[styles.typeName, { color: theme?.colors?.text }]}>{details.name}</Text>
                <Text style={[styles.typeDescription, { color: theme?.colors?.muted }]}>{details.description}</Text>
                <View style={styles.features}>
                  {details.features.map((feature, index) => (
                    <Text key={index} style={[styles.feature, { color: theme?.colors?.text }]}>• {feature}</Text>
                  ))}
                </View>
                <Text style={[styles.playerCount, { color: theme?.colors?.muted }]}>
                  {details.minPlayers === details.maxPlayers
                    ? `${details.minPlayers} player`
                    : `${details.minPlayers}-${details.maxPlayers} players`}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        );

      case 2: // League Settings
        return (
          <ScrollView style={[styles.container, { backgroundColor: theme?.colors?.background }]}>
            <Text style={[styles.h1, { color: theme?.colors?.text }]}>Create {LEAGUE_TYPE_DETAILS[form.type].name} League</Text>
            
            <View style={styles.formGroup}>
              <Text style={[styles.label, { color: theme?.colors?.text }]}>League Name:</Text>
              <TextInput
                style={[styles.input, { backgroundColor: theme?.colors?.card, color: theme?.colors?.text, borderColor: theme?.colors?.border }]}
                value={form.name}
                onChangeText={(text) => setForm(f => ({ ...f, name: text }))}
                placeholder="Enter league name"
                placeholderTextColor={theme?.colors?.muted}
              />
            </View>

            <LeagueSettings
              type={form.type}
              settings={form.settings}
              onSettingsChange={(newSettings) => setForm(f => ({ ...f, settings: newSettings }))}
            />
            <View style={styles.buttonGroup}>
              <Pressable
                style={[styles.button, styles.secondaryButton]}
                onPress={() => setStep(1)}
              >
                <Text style={styles.secondaryButtonText}>Back</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.primaryButton]}
                onPress={handleCreateLeague}
              >
                <Text style={styles.buttonText}>Create League</Text>
              </Pressable>
            </View>
          </ScrollView>
        );
    }
  };

  return renderStep();
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  h1: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 16,
  },
  h2: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  typeCard: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
  typeName: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  typeDescription: {
    fontSize: 14,
    marginBottom: 8,
  },
  features: {
    marginTop: 8,
  },
  feature: {
    fontSize: 14,
    marginBottom: 4,
  },
  playerCount: {
    marginTop: 8,
    fontSize: 14,
    color: '#2563eb',
    fontWeight: '600',
  },
  formGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  textArea: {
    height: 100,
    textAlignVertical: 'top',
  },
  buttonGroup: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
  },
  button: {
    flex: 1,
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginHorizontal: 8,
  },
  primaryButton: {
    backgroundColor: '#2563eb',
  },
  secondaryButton: {
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButtonText: {
    color: '#374151',
    fontSize: 16,
    fontWeight: '600',
  },
});