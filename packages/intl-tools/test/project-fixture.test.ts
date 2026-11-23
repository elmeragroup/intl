import { expect, test } from "vitest";

import { openProject } from "./project-fixture";

const it = test.extend("project", ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-fixture-", task.timeout);
  onCleanup(close);

  return project;
});

// Unit under test: `Project.within`, the hang guard of an awaited promise. Oracle: the event loop's order: a promise
// that settles on the next turn settles `within` on that turn, before a callback two turns later, so a guarded await
// costs no polling interval.
it("settles on the turn the awaited promise settles", async ({ project }) => {
  const nextTurn = new Promise<string>((done) => {
    setImmediate(() => {
      done("in time");
    });
  });
  const twoTurnsLater = new Promise<string>((done) => {
    setImmediate(() => {
      setImmediate(() => {
        done("two turns later");
      });
    });
  });

  expect(await Promise.race([project.within(nextTurn, "a promise settling next turn"), twoTurnsLater])).toBe(
    "in time"
  );
});

// Oracle: the guard's contract: a promise that never settles fails with the guard's message at the deadline, not on
// the test's own timeout.
it("fails at the deadline when the awaited promise never settles", { timeout: 1000 }, async ({ project }) => {
  await expect(
    project.within(
      new Promise<never>(() => {
        // Never settles.
      }),
      "a promise that never settles"
    )
  ).rejects.toThrow("hang guard: a promise that never settles did not settle before the deadline");
});
