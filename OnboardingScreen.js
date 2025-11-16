import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const slides = [
  {
    key: 'welcome',
    emoji: '🏈',
    title: "Welcome to Pick 'Em Pro",
    body: 'Create or join leagues with friends and make weekly NFL picks.'
  },
  {
    key: 'leagues_picks',
    emoji: '📝',
    title: 'Leagues → Picks → Lock',
    body: 'Join or create a league, then make your picks each week. Lines lock before kickoff based on league settings.'
  },
  {
    key: 'how',
    emoji: '🧠',
    title: 'How it works',
    body: 'Pick spreads and totals before lock. Earn points for correct picks. Track standings each week.'
  },
  {
    key: 'tips',
    emoji: '🔔',
    title: 'Reminders & Results',
    body: 'Enable notifications for game reminders and weekly results. You can manage these in Profile → Notifications.'
  },
];

export default function OnboardingScreen({ theme, styles, onDone, onEnableNotifications }) {
  const [index, setIndex] = useState(0);
  const slide = slides[index];
  const isLast = index === slides.length - 1;

  const finish = async () => {
    try { await AsyncStorage.setItem('ONBOARDING_COMPLETE', '1'); } catch {}
    onDone?.();
  };

  return (
    <View style={[styles.modalOverlay, { backgroundColor: theme.colors.background }] }>
      <View style={[styles.modal, { backgroundColor: theme.colors.card, width: '88%', maxWidth: 520 }] }>
        <View style={{ alignItems: 'center', marginBottom: 12 }}>
          <Text style={{ fontSize: 56, marginBottom: 8 }}>{slide.emoji}</Text>
          <Text style={[styles.h2, { textAlign: 'center', color: theme.colors.text }]}>{slide.title}</Text>
        </View>
        <ScrollView style={{ maxHeight: 260 }}>
          <Text style={{ color: theme.colors.muted, fontSize: 16, textAlign: 'center' }}>{slide.body}</Text>
        </ScrollView>

        {/* Dots */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 16 }}>
          {slides.map((s, i) => (
            <View key={s.key} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: i === index ? theme.colors.primary : theme.colors.border }} />
          ))}
        </View>

        {/* Actions */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 }}>
          <Pressable onPress={finish}>
            <Text style={{ color: theme.colors.muted }}>Skip</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {slide.key === 'tips' && (
              <Pressable style={[styles.btnBlue, { paddingHorizontal: 12, paddingVertical: 10, marginRight: 8 }]} onPress={async () => {
                try { await onEnableNotifications?.(); } catch {}
              }}>
                <Text style={styles.btnTxt}>Enable Notifications</Text>
              </Pressable>
            )}
            {isLast ? (
              <Pressable style={[styles.btnGreen, { paddingHorizontal: 16, paddingVertical: 10 }]} onPress={finish}>
                <Text style={styles.btnTxt}>Get Started</Text>
              </Pressable>
            ) : (
              <Pressable style={[styles.btnBlue, { paddingHorizontal: 16, paddingVertical: 10 }]} onPress={() => setIndex(i => Math.min(i + 1, slides.length - 1))}>
                <Text style={styles.btnTxt}>Next</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}
