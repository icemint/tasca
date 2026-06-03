import { RouterProvider } from "@tanstack/react-router";
import { HotkeysProvider } from "react-hotkeys-hook";
import { router } from "@remote/app/router";
import { AppRuntimeProvider } from "@/shared/hooks/useAppRuntime";
import { OrgFlagsProvider } from "@/shared/flags";

export function AppRouter() {
  return (
    <AppRuntimeProvider runtime="remote">
      {/* Feature flags resolve org → env → off. OrgFlagsProvider threads the
          selected org's feature_flags in (sits inside QueryClient + auth, so
          the org hooks resolve); signed-out → env/default-off. */}
      <OrgFlagsProvider>
        <HotkeysProvider
          initiallyActiveScopes={["global", "workspace", "kanban", "projects"]}
        >
          <RouterProvider router={router} />
        </HotkeysProvider>
      </OrgFlagsProvider>
    </AppRuntimeProvider>
  );
}
