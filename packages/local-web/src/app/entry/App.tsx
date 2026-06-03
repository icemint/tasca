import { RouterProvider } from '@tanstack/react-router';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { UserSystemProvider } from '@web/app/providers/ConfigProvider';
import { ClickedElementsProvider } from '@web/app/providers/ClickedElementsProvider';
import { localAppNavigation } from '@web/app/navigation/AppNavigation';
import { LocalAuthProvider } from '@/shared/providers/auth/LocalAuthProvider';
import { AppRuntimeProvider } from '@/shared/hooks/useAppRuntime';
import { AppNavigationProvider } from '@/shared/hooks/useAppNavigation';
import { OrgFlagsProvider } from '@/shared/flags';
import { useTauriNotificationNavigation } from '@web/app/hooks/useTauriNotificationNavigation';
import { useTauriUpdateReady } from '@web/app/hooks/useTauriUpdateReady';
import { AppSystemNotifications } from '@web/app/notifications/AppSystemNotifications';
import { router } from '@web/app/router';

function TauriListeners() {
  useTauriNotificationNavigation();
  useTauriUpdateReady();
  return null;
}

function App() {
  return (
    <AppRuntimeProvider runtime="local">
      {/* Flags resolve org → env → off. A signed-in desktop user now honors
          their selected org's feature_flags; offline/signed-out falls through
          to env (.env.development) and the all-off default. */}
      <OrgFlagsProvider>
        <AppNavigationProvider value={localAppNavigation}>
          <TauriListeners />
          <UserSystemProvider>
            <LocalAuthProvider>
              <AppSystemNotifications />
              <ClickedElementsProvider>
                <HotkeysProvider
                  initiallyActiveScopes={[
                    'global',
                    'workspace',
                    'kanban',
                    'projects',
                  ]}
                >
                  <RouterProvider router={router} />
                </HotkeysProvider>
              </ClickedElementsProvider>
            </LocalAuthProvider>
          </UserSystemProvider>
        </AppNavigationProvider>
      </OrgFlagsProvider>
    </AppRuntimeProvider>
  );
}

export default App;
