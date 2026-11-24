import { useSyncExternalStore } from "react";

function subscribeNever(): () => void {
  return () => undefined;
}

/**
 * Whether the visitor is on an Apple platform, whose command key is ⌘. The server assumes so.
 *
 * @returns `true` on macOS, iOS and iPadOS, and in the server render.
 */
export function useApplePlatform(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => /Mac|iPhone|iPad/u.test(navigator.userAgent),
    () => true
  );
}
