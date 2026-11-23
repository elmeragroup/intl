import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { CatalogFiles } from "../src/catalog-files";
import type { ExtractOptions } from "../src/commands";
import { extractCatalogs, planCatalogs, writeCatalogs } from "../src/commands";
import type { ProjectConfig } from "../src/project-config";
import type { WatchMode } from "../src/watch";
import type { Project } from "./project-fixture";
import { component, deliveredEvents, it, startWatch, syncing } from "./watch-project";

// The saves the watch keeps: a translator's editor saves a catalog while a sync runs, and the sync never writes over it;
// the next sync merges it. Unit under test: `watchCatalogs` with the real `CatalogSync`, on the test clock, its catalogs
// on Node's files, with a hook after a storage operation where a case saves. Oracle: the contract per case, by hand: a
// msgstr saved during a sync survives and the next sync merges it; every catalog a sync wrote is reported and taken
// for the watch's own write; locales that share one catalog write it in turn, the last locale's text left.
describe("extract --watch keeps a catalog saved during a sync", () => {
  // Native file events, which a test delivers itself through `deliveredEvents`.
  const NATIVE: WatchMode = { _tag: "native" };
  const TWO_LOCALES = `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb", "sv"] }`;

  // Node's catalog files, each operation wrapped by `wrap`: a test's hook after one of a sync's storage operations.
  const wrapped = (
    wrap: (live: CatalogFiles["Service"]) => CatalogFiles["Service"]
  ): Layer.Layer<CatalogFiles> =>
    Layer.effect(
      CatalogFiles,
      CatalogFiles.use((live) => Effect.succeed(wrap(live)))
    ).pipe(Layer.provide(CatalogFiles.layer()));

  // A translator's save of sv's "Hello", as its editor writes it.
  const translateSv = (project: Project) => {
    project.write(
      "messages/sv.po",
      project.read("messages/sv.po").replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "Hej"`)
    );
  };

  // Node's catalog files, saving sv's "Hello" right after the sync writes nb with "Ready" in it.
  const savingAfterNb = (project: Project) => {
    const nb = project.path("messages/nb.po");
    let saved = false;
    const layer = wrapped((live) => ({
      ...live,
      write: (path, text, guard) =>
        live.write(path, text, guard).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              if (!saved && outcome === "written" && path === nb && text.includes(`msgid "Ready"`)) {
                saved = true;
                translateSv(project);
              }
            })
          )
        ),
    }));

    return { layer, saved: () => saved };
  };

  // A save that lands right after the sync's writes, inside the sync step: the next sync merges it rather than writing
  // the PO it read before.
  it.effect("keeps a msgstr saved right after the sync that added its message", ({ project }) =>
    Effect.gen(function* () {
      const po = project.path("messages/nb.po");
      let saved = false;
      yield* startWatch(project, {
        layer: syncing(
          Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
            const result = yield* extractCatalogs(config, options);
            const added = result.written.find(
              ({ path, text }) => path === po && text.includes(`msgid "Ready"`)
            );

            if (!saved && added !== undefined) {
              saved = true;
              project.write(
                "messages/nb.po",
                added.text.replace(`msgid "Ready"\nmsgstr ""`, `msgid "Ready"\nmsgstr "Klar"`)
              );
            }

            return result;
          })
        ),
      });
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"\nmsgstr "Klar"`);

      project.write("src/after.tsx", component("After"));
      yield* TestClock.adjust("1 second");
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"\nmsgstr "Klar"`);
      expect(project.read("messages/nb.po")).toContain(`msgid "After"`);
    })
  );

  // A save that lands after a sync read the PO and before it writes: the sync yields, and the next one merges the save.
  it.effect("keeps a msgstr saved while a sync runs", ({ project }) =>
    Effect.gen(function* () {
      const po = project.path("messages/nb.po");
      let saved = false;
      yield* startWatch(project, {
        layer: syncing(
          Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
            const plan = yield* planCatalogs(config, options);

            if (
              !saved &&
              plan.outputs.some(({ path, text }) => path === po && text.includes(`msgid "Ready"`))
            ) {
              saved = true;
              project.write(
                "messages/nb.po",
                project
                  .read("messages/nb.po")
                  .replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "Hei"`)
              );
            }

            return yield* writeCatalogs(plan, options);
          })
        ),
      });
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");
      expect(project.read("messages/nb.po")).toContain(`msgid "Hello"\nmsgstr "Hei"`);
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"`);
    })
  );

  // The save lands on sv after the sync wrote nb and before it writes sv. Through the real `CatalogSync`: the sync's
  // write of sv finds it changed and stops, nb's write reported, and the next sync merges the save.
  it.effect("keeps a msgstr saved in one catalog while the sync writes another", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", TWO_LOCALES);
      const saving = savingAfterNb(project);
      const { reports } = yield* startWatch(project, { files: saving.layer });
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");

      expect(project.read("messages/sv.po")).toMatch(/msgid "Hello"\nmsgstr "Hej"[\s\S]*msgid "Ready"/u);
      expect({ saved: saving.saved(), reports }).toEqual({
        saved: true,
        reports: ["Written", "Written", "Written"],
      });
    })
  );

  // The runtime yields to another fiber at any step of a sync. One that saves sv just after the sync's last storage
  // operation on it (once nb is written) runs at that yield: it lands after sv's write, never between the check of sv
  // and the write, so it is kept.
  it.effect("keeps a msgstr another fiber saves while the sync yields at a catalog", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", TWO_LOCALES);
      const nb = project.path("messages/nb.po");
      const sv = project.path("messages/sv.po");
      let nbWritten = false;
      let saved = false;
      // After an operation on sv, once nb holds "Ready": another fiber saves sv, and the sync yields to it.
      const yieldingToSave = Effect.suspend(() => {
        if (saved || !nbWritten) {
          return Effect.void;
        }

        saved = true;

        return Effect.forkChild(Effect.sync(() => translateSv(project))).pipe(
          Effect.andThen(Effect.yieldNow)
        );
      });
      const files = wrapped((live) => ({
        read: (path) => live.read(path).pipe(Effect.tap(() => (path === sv ? yieldingToSave : Effect.void))),
        readExisting: live.readExisting,
        write: (path, text, guard) =>
          live.write(path, text, guard).pipe(
            Effect.tap((outcome) =>
              Effect.suspend(() => {
                nbWritten ||= outcome === "written" && path === nb && text.includes(`msgid "Ready"`);

                return path === sv ? yieldingToSave : Effect.void;
              })
            )
          ),
      }));
      yield* startWatch(project, { files });
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");

      expect(saved).toBe(true);
      expect(project.read("messages/sv.po")).toMatch(/msgid "Hello"\nmsgstr "Hej"[\s\S]*msgid "Ready"/u);
    })
  );

  // Every catalog the superseded sync wrote is reported and recorded as the watch's own: nb's own change event,
  // delivered only after the follow-up sync, starts no sync.
  it.effect("reports and records what a superseded sync wrote", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", TWO_LOCALES);
      const events = deliveredEvents();
      const { reports } = yield* startWatch(project, {
        files: savingAfterNb(project).layer,
        mode: NATIVE,
        events: events.layer,
      });
      project.write("src/ready.tsx", component("Ready"));
      events.listener(project.root).change("rename", "src/ready.tsx");
      yield* TestClock.adjust("1 second");
      events.listener(project.root).change("change", "messages/nb.po");
      yield* TestClock.adjust("1 second");

      expect(reports).toEqual(["Written", "Written", "Written"]);
    })
  );

  // Locales whose catalogs are one file: each locale's output is written in turn, each compared with the sync's own
  // write before it, so the sync is not superseded by itself and the last locale's catalog is what the file holds.
  it.effect("writes one catalog that several locales share, in turn", ({ project }) =>
    Effect.gen(function* () {
      project.write(
        "elmera-intl.json",
        `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}/../catalog.po", "locales": ["nb", "sv"] }`
      );
      const { reports } = yield* startWatch(project);
      yield* TestClock.adjust("1 second");

      expect(reports).toEqual(["Written"]);
      expect(project.read("messages/catalog.po")).toContain(String.raw`"Language: sv\n"`);
    })
  );
});
