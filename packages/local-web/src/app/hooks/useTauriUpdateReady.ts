/**
 * Auto-update machinery severed: the Tauri updater plugin was removed, so the
 * `update-installed` event is never emitted. This hook is now a no-op, retained
 * so existing call sites compile unchanged. The app makes no update checks.
 */
export function useTauriUpdateReady() {}
