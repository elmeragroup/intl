// The latest value of a prop, for callbacks that must not re-create what they are passed into.
import { useEffect, useRef } from "react";

/**
 * A ref holding the latest committed `value`. Callbacks read `.current` when they run, so an object built once (a
 * switch queue, a translator) calls the newest function without being rebuilt when the caller passes a new one each
 * render. It is set after commit: a call during the render that changed it still sees the previous value.
 *
 * @template T - The value's type.
 * @param value - The value this render passes.
 * @returns A ref whose `current` is the latest committed value.
 */
export function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });

  return ref;
}
