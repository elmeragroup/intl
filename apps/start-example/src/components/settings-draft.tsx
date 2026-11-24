// The settings form's draft and its saved baseline, held above the page. A locale switch re-runs the root loader, and
// when that reload fails the router renders its error component (src/components/load-error.tsx) in place of the page,
// which unmounts the form. The shell mounts this provider around the page slot instead, keyed by the page as the slot
// is, so the draft lives as long as the visitor stays on /settings: through a failed reload and its retry, gone once
// they leave.
import { createContext, use, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { draftOf, INITIAL_SETTINGS, isSameDraft, settleSave } from "../data/settings";
import type { SavedSettings, Settings, SettingsDraft } from "../data/settings";

/**
 * What a started save calls with the settings the server saved. They become the saved baseline unless a later save
 * already set one (`settleSave` in src/data/settings.ts). The draft takes the saved values' form only while it is still
 * as it was sent; edits made since stay.
 */
export type SettleSave = (settings: Settings) => void;

/** The settings draft, its saved baseline and the operations on them. */
export type SettingsDraftState = {
  /** The settings as last saved. */
  readonly saved: Settings;
  /** The form's fields as typed. */
  readonly draft: SettingsDraft;
  /** Change some fields of the draft. */
  readonly edit: (change: Partial<SettingsDraft>) => void;
  /** Return the draft to the saved settings. */
  readonly discard: () => void;
  /** Start a save of `submitted`, the draft as the form sends it. */
  readonly startSave: (submitted: SettingsDraft) => SettleSave;
};

const SettingsDraftContext = createContext<SettingsDraftState | undefined>(undefined);

/**
 * Holds the settings draft for the pages inside it. The shell mounts one around its page slot.
 *
 * @param props - The page.
 */
export function SettingsDraftProvider({ children }: { readonly children: ReactNode }) {
  const [saved, setSaved] = useState<Settings>(INITIAL_SETTINGS);
  const [draft, setDraft] = useState<SettingsDraft>(() => draftOf(INITIAL_SETTINGS));
  // How many saves have started, and the saved settings with the save that set them, which every answer folds into.
  const started = useRef(0);
  const baseline = useRef<SavedSettings>({ settings: INITIAL_SETTINGS, save: 0 });

  const state = useMemo<SettingsDraftState>(
    () => ({
      saved,
      draft,
      edit: (change) => {
        setDraft((previous) => ({ ...previous, ...change }));
      },
      discard: () => {
        setDraft(draftOf(saved));
      },
      startSave: (submitted) => {
        started.current += 1;
        const save = started.current;

        return (settings) => {
          const next = settleSave(baseline.current, { settings, save });
          if (next === baseline.current) {
            return;
          }
          baseline.current = next;
          const savedDraft = draftOf(next.settings);
          setSaved(next.settings);
          setDraft((latest) => (isSameDraft(latest, submitted) ? savedDraft : latest));
        };
      },
    }),
    [saved, draft]
  );

  return <SettingsDraftContext value={state}>{children}</SettingsDraftContext>;
}

/**
 * The settings draft of the nearest provider.
 *
 * @returns The draft, its saved baseline and the operations on them.
 * @throws When no `SettingsDraftProvider` is above the caller: a wiring defect.
 */
export function useSettingsDraft(): SettingsDraftState {
  const state = use(SettingsDraftContext);
  if (state === undefined) {
    throw new Error("useSettingsDraft needs a SettingsDraftProvider above it: the shell mounts one.");
  }

  return state;
}
