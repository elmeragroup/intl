// The fake server the locale-switch tests hold requests on, and the settlement sweep every switchLocale an adapter
// hands out must pass: the switcher's, the pending-counted one's, and each mounted hook's.
import { expect, vi } from "vitest";

import type { SwitchOutcome } from "@elmeragroup/intl/core";

type HeldRequest = {
  readonly locale: string;
  /** The very promise `persist` returned, so a test can react to its settlement as the switcher does. */
  readonly promise: Promise<void>;
  readonly arrive: () => void;
  readonly drop: () => void;
};

type HeldRefresh = { readonly render: () => void; readonly fail: () => void };

/** How the fake server answers each `refreshServer` call, in call order; calls past the script render at once. */
type RefreshScript = ReadonlyArray<"render" | "fail" | "hold">;

/**
 * A server that stores the locale cookie when a persist request arrives and renders whatever the cookie says on
 * refresh. Requests are held until the test lets them arrive, so it controls the interleaving; refreshes follow the
 * script. `persist` is not async: it returns the held promise itself, so the switcher awaits exactly that promise.
 *
 * @param script - How the server answers each `refreshServer` call, in call order.
 * @returns The port a switcher takes, and the test's handles on held requests and refreshes.
 */
export function fakeServer(script: RefreshScript = []) {
  let cookie = "en";
  let refreshCalls = 0;
  const rendered: Array<string> = [];
  const requests: Array<HeldRequest> = [];
  const refreshes: Array<HeldRefresh> = [];
  const persist = (locale: string): Promise<void> => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    requests.push({
      locale,
      promise,
      arrive: () => {
        cookie = locale;
        resolve();
      },
      drop: () => {
        reject(new Error("offline"));
      },
    });

    return promise;
  };
  const refreshServer = (): void | Promise<void> => {
    const answer = script[refreshCalls] ?? "render";
    refreshCalls += 1;

    switch (answer) {
      case "render":
        rendered.push(cookie);

        return undefined;
      case "fail":
        return Promise.reject(new Error("router gone"));
      case "hold": {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        refreshes.push({
          render: () => {
            rendered.push(cookie);
            resolve();
          },
          fail: () => {
            reject(new Error("router gone"));
          },
        });

        return promise;
      }
    }
  };
  const request = async (index: number): Promise<HeldRequest> => {
    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThan(index);
    });
    const held = requests[index];

    if (!held) {
      throw new Error(`request ${index} never arrived`);
    }

    return held;
  };
  const refresh = async (index: number): Promise<HeldRefresh> => {
    await vi.waitFor(() => {
      expect(refreshes.length).toBeGreaterThan(index);
    });
    const held = refreshes[index];

    if (!held) {
      throw new Error(`refresh ${index} never started`);
    }

    return held;
  };

  return { persist, refreshServer, request, refresh, rendered, requests, cookie: () => cookie };
}

/** The fake server a test drives. */
type FakeServer = ReturnType<typeof fakeServer>;

/** A switchLocale under test, made against a fake server, and how to tear down what made it. */
type SwitchUnderTest = {
  readonly switchLocale: (locale: string) => Promise<SwitchOutcome>;
  readonly dispose: () => void;
};

/** Makes a switchLocale under test that persists through the given server. */
export type MakeSwitch = (server: FakeServer) => SwitchUnderTest | Promise<SwitchUnderTest>;

type Probe = { readonly pending: boolean; readonly tag: string; readonly newer: string };

const PENDING = Symbol("pending");
// Microtask turns a step waits before it starts counting task turns: a switcher that settles within this many turns of
// its persist rejecting is swept turn by turn, and one that settles later (after a task) is reached by the steps past
// it, each one `setImmediate` turn further.
const MICROTASK_TURNS = 32;

// The wait before B starts, which the probe awaits only for a step past 0: `step` microtask turns up to MICROTASK_TURNS
// (each `then` on a settled promise settles one turn after it, and the await resumes one turn after that), then one
// task turn per further step. It returns the chain rather than awaiting it, so no extra turn is added to the count.
function advance(step: number): Promise<void> {
  let turns: Promise<void> = Promise.resolve();
  for (let turn = 1; turn < Math.min(step, MICROTASK_TURNS); turn += 1) {
    turns = turns.then(() => undefined);
  }
  for (let task = MICROTASK_TURNS; task < step; task += 1) {
    turns = turns.then(
      () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        })
    );
  }

  return turns;
}

// One scenario: A's persist rejects, B starts `step` turns later, and the probe records whether A was still pending
// when B started, how A ended and how B ended.
async function probe(make: MakeSwitch, step: number): Promise<Probe> {
  const server = fakeServer();
  const { switchLocale, dispose } = await make(server);
  try {
    const a = switchLocale("nb");
    const held = await server.request(0);
    held.drop();
    if (step > 0) {
      await advance(step);
    }
    // A is listed first, so an A that has already settled wins the race.
    const atB = Promise.race([a, Promise.resolve(PENDING)]);
    const b = switchLocale("sv");
    const outcome = await a;
    (await server.request(1)).arrive();

    return { pending: (await atB) === PENDING, tag: outcome._tag, newer: (await b)._tag };
  } finally {
    dispose();
  }
}

/**
 * The settlement sweep. A settles some number of turns after its persist rejects; whenever B starts before that, A must
 * resolve Superseded, and once A has settled, it keeps PersistFailed. The sweep starts B at step 0 and one step later
 * per fresh scenario until B first sees A settled, so it straddles settlement however many turns, microtask or task,
 * the switch under test takes; the test timeout is the hang guard.
 *
 * @param make - Makes the switchLocale under test against each scenario's fake server.
 * @param step - The step to start at (0 for a whole sweep).
 * @param sawPending - Whether an earlier step saw A pending.
 * @returns Whether any step saw A pending, which a test asserts so the sweep is not vacuous.
 */
export async function sweepSettlement(make: MakeSwitch, step = 0, sawPending = false): Promise<boolean> {
  const { pending, tag, newer } = await probe(make, step);
  expect([tag, newer], `B started at step ${step}, A ${pending ? "pending" : "settled"}`).toEqual([
    pending ? "Superseded" : "PersistFailed",
    "Switched",
  ]);

  return pending ? sweepSettlement(make, step + 1, true) : sawPending;
}
