// The React side of one switch queue per router, shared by the Next and Start `useLocaleSwitch`.
import { useInsertionEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { QueuedSwitch, SwitchOutcome } from "./locale-switch";
import { isPendingOn, queueFor, subscribeTo } from "./locale-switch";

/**
 * What a host's `useLocaleSwitch` returns (each host's `LocaleSwitch` maps it), and what `useRouterSwitch` gives it: the
 * switch function, and the queue's part of its `isPending`.
 */
export type RouterSwitch = {
  /**
   * Persist `locale`, then refresh the server data, as a switch queued on the router's queue; resolves to how that
   * switch ended (latest switch wins), and never rejects. Callable from the commit of the render that returned it (an
   * effect or an event handler); called from a render that never committed, it throws, since nothing was committed for
   * it to run.
   */
  readonly switchLocale: (locale: string) => Promise<SwitchOutcome>;
  /**
   * True at least while a switch under the router is in flight, from whichever mount it started; `LocaleSwitch` says
   * what else counts and until when.
   */
  readonly isPending: boolean;
};

/**
 * What a switch runs with, made from one render's persist and options when the switch starts.
 *
 * @template Router - The host's router.
 * @param router - The router that admitted the switch, which it refreshes.
 * @returns The port and mode the switch runs with.
 */
export type PrepareSwitch<Router> = (router: Router) => QueuedSwitch;

// What one mount last committed under one router key.
type Box<Router> = { current: PrepareSwitch<Router> };

// A mount's boxes by router key, held weakly: a box lives as long as a handle or a queued switch holds it, and a mount
// returning to a key whose box a queued switch still holds gets that box back, so the switch reads what the mount
// commits there.
type Boxes<Router> = WeakMap<WeakKey, WeakRef<Box<Router>>>;

// What one switch handle switches through: its key and router, and the box of its key from the first commit under
// them.
type Slot<Router> = { readonly key: WeakKey; readonly router: Router; box: Box<Router> | null };

const serverSnapshot = (): boolean => false;

const newBoxes = <Router>(): Boxes<Router> => new WeakMap();

// The callbacks a mount keeps past its render (subscribe, getSnapshot, switchLocale) are module-level functions
// (`subscribeTo` and `isPendingOn` from ./locale-switch, `switchThrough` below) bound to exactly the values each reads.
// A closure made in the hook's body would share its scope with the insertion effect's, which holds the render's
// `prepare`, and a minifier inlining the hook's helpers can merge any two such scopes; a bound function carries only
// its bound arguments.
function switchThrough<Router>(slot: Slot<Router>, locale: string): Promise<SwitchOutcome> {
  const { key, router, box } = slot;
  if (box === null) {
    throw new Error("useLocaleSwitch: switchLocale was called before the render that returned it committed.");
  }

  // The queued switch holds the box, so it reads what the mount last commits under this key, wherever it is now.
  return queueFor(key).switch(locale, () => box.current(router));
}

// Runs in the commit's mutation phase: the render's `prepare` becomes its key's box's, and its handle's slot holds
// that box.
function publish<Router>(boxes: Boxes<Router>, slot: Slot<Router>, prepare: PrepareSwitch<Router>): void {
  const { key } = slot;
  const existing = boxes.get(key)?.deref();
  if (existing) {
    existing.current = prepare;
    slot.box = existing;

    return;
  }
  const created: Box<Router> = { current: prepare };
  boxes.set(key, new WeakRef(created));
  slot.box = created;
}

/**
 * Join the switch queue of the router `key` names, and keep what this mount commits, per router, for the switches it
 * queues.
 *
 * A switch calls the `prepare` this mount committed under the router that admitted it, with that router, when the
 * switch starts: a switch queued before the mount moved to another router keeps that router's last committed one, and
 * a switch queued before a re-render under the same router uses the new one. It is published in the commit's mutation
 * phase (an insertion effect, which, unlike layout and passive effects, also runs inside a hidden Activity), so a
 * switch released from any layout or passive effect of that commit reads it, and a render that never commits
 * publishes nothing.
 *
 * `isPending` reads a queue only if one exists, so a client-rendered mount's first commit shows a switch another mount
 * holds. A hydration commit uses the server snapshot (`false`), and shows it from the commit after.
 *
 * @template Router - The router a switch refreshes.
 * @param key - The identity of the router this render is under, which the queue is keyed on.
 * @param router - The router this render is under, which a switch it admits refreshes.
 * @param prepare - What this render would commit for its switches; a new function each render is fine.
 * @returns The switch function and the router-wide pending state.
 */
export function useRouterSwitch<Router>(
  key: WeakKey,
  router: Router,
  prepare: PrepareSwitch<Router>
): RouterSwitch {
  const [boxes] = useState<Boxes<Router>>(newBoxes);
  const slot = useMemo((): Slot<Router> => ({ key, router, box: null }), [key, router]);
  useInsertionEffect(() => {
    publish(boxes, slot, prepare);
  });
  const subscribe = useMemo(() => subscribeTo.bind(null, key), [key]);
  const getSnapshot = useMemo(() => isPendingOn.bind(null, key), [key]);
  const isPending = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
  const switchLocale = useMemo(
    (): RouterSwitch["switchLocale"] => (switchThrough<Router>).bind(null, slot),
    [slot]
  );

  return { switchLocale, isPending };
}
