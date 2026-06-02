import { RouterProvider } from "@tanstack/react-router";
import { HotkeysProvider } from "react-hotkeys-hook";
import { router } from "@remote/app/router";
import { AppRuntimeProvider } from "@/shared/hooks/useAppRuntime";
import { FlagsProvider } from "@/shared/flags";

export function AppRouter() {
  return (
    <AppRuntimeProvider runtime="remote">
      {/* Feature flags resolve env → org → off. Org flags get threaded in once
          the org-settings query is wired; until then everything defaults off. */}
      <FlagsProvider>
        <HotkeysProvider
          initiallyActiveScopes={["global", "workspace", "kanban", "projects"]}
        >
          <RouterProvider router={router} />
        </HotkeysProvider>
      </FlagsProvider>
    </AppRuntimeProvider>
  );
}
