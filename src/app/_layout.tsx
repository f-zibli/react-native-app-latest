
// import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
// import * as SplashScreen from 'expo-splash-screen';
// import { useColorScheme } from 'react-native';

// import { AnimatedSplashOverlay } from '@/components/animated-icon';
// import AppTabs from '@/components/app-tabs';
// import { AuthProvider } from '@/contexts/AuthContext';

// SplashScreen.preventAutoHideAsync();

// export default function TabLayout() {
//   const colorScheme = useColorScheme();

//   return (
//     <AuthProvider>
//       <ThemeProvider
//         value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}
//       >
//         <AnimatedSplashOverlay />
//         <AppTabs />
//       </ThemeProvider>
//     </AuthProvider>
//   );
// }



import { DarkTheme, DefaultTheme, ThemeProvider, Redirect, Stack, useSegments } from 'expo-router';
import { useColorScheme } from 'react-native';

import { AuthProvider, useAuth } from '@/contexts/AuthContext';

function RootNavigator() {
  const { user, loading } = useAuth();
  const segments = useSegments();

  if (loading) {
    return null;
  }

  const inAuthGroup = segments[0] === '(auth)';

  // Not logged in: show login/register
  if (!user && !inAuthGroup) {
    return <Redirect href="/(auth)/login" />;
  }

  // Already logged in: go to dashboard
  if (user && inAuthGroup) {
    return <Redirect href="/(tabs)" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <AuthProvider>
      <ThemeProvider
        value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}
      >
        <RootNavigator />
      </ThemeProvider>
    </AuthProvider>
  );
}
