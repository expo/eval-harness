import React from 'react';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../src/AppContext';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="note/[id]" />
        </Stack>
      </AppProvider>
    </SafeAreaProvider>
  );
}
