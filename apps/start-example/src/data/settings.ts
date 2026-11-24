// The settings form's domain, ported from Fuse's app-shell block (settings-page.tsx at Fuse 9be80460): what the form
// holds while the user edits (a draft, every field as typed) and what a save commits (the settings, parsed). Pure: the
// form parses to show each field's problem, and the save's server function parses again, since its argument crossed
// the network.
import { CONTRACT_TYPES } from "./market";
import type { ContractType } from "./market";
import { SIGNED_IN } from "./signed-in";

/** How many days a new customer has to pay an invoice. */
export const PAYMENT_TERMS = [14, 21, 30] as const;

/** One of the payment terms. */
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];

/** When price alerts go out: never, or above a price in øre per kWh. */
export type PriceAlerts = { readonly _tag: "Off" } | { readonly _tag: "Above"; readonly ore: number };

/** The saved settings: what the app runs on until the next save. */
export type Settings = {
  readonly name: string;
  readonly email: string;
  readonly defaultContract: ContractType;
  readonly paymentTerms: PaymentTerms;
  readonly alerts: PriceAlerts;
  readonly weeklyReport: boolean;
};

/** What the form holds while the user edits: every field, the text ones as typed. */
export type SettingsDraft = {
  readonly name: string;
  readonly email: string;
  readonly defaultContract: string;
  readonly paymentTerms: number;
  readonly alertsOn: boolean;
  readonly threshold: string;
  readonly weeklyReport: boolean;
};

/** A field of the draft that can fail to parse. */
export type SettingsField = "name" | "email" | "threshold";

/** The draft's fields that do not parse, in the form's order. */
export type SettingsErrors = ReadonlyArray<SettingsField>;

/** A parsed draft: the settings, or the fields to fix. */
export type ParsedSettings =
  | { readonly _tag: "ok"; readonly value: Settings }
  | { readonly _tag: "err"; readonly errors: SettingsErrors };

/** What a save answered: the settings it saved, or that the draft it received does not parse, each with its sentence. */
export type SaveOutcome =
  | { readonly _tag: "Saved"; readonly settings: Settings; readonly message: string }
  | { readonly _tag: "Invalid"; readonly message: string };

/** The settings the page opens with. An app loads them from its API. */
export const INITIAL_SETTINGS: Settings = {
  name: SIGNED_IN.name,
  email: SIGNED_IN.email,
  defaultContract: "spot",
  paymentTerms: 14,
  alerts: { _tag: "Above", ore: 150 },
  weeklyReport: false,
};

// The threshold an alert that is off offers when it is turned back on.
const DEFAULT_THRESHOLD = "150";

// The longest email address the form takes, in octets: RFC 5321's limit on a forward path, 256 less its angle
// brackets.
const MAX_EMAIL_LENGTH = 254;

// An address: a local part, then a domain of two or more labels. Each part stops at a character the next part starts
// with (the local part holds no `@`, a label no dot), so a failing match gives up at once at each boundary and the
// pattern runs in linear time over the input, whatever a client sends: no repetition nests over one that can match the
// same text. The length is bounded before it runs.
const EMAIL = /^[^\s@]+@(?:[^\s@.]+\.)+[^\s@.]+$/u;

// Counts an address's octets: RFC 5321 limits octets, and a character outside ASCII takes two to four of them in UTF-8.
const UTF8 = new TextEncoder();

// The cheap check first: a string of more UTF-16 code units than the limit has at least as many octets, so it is too
// long without being encoded.
function isEmail(email: string): boolean {
  return (
    email.length <= MAX_EMAIL_LENGTH && UTF8.encode(email).byteLength <= MAX_EMAIL_LENGTH && EMAIL.test(email)
  );
}

/**
 * A draft that shows `settings`, for opening the form and for Discard.
 *
 * @param settings - The saved settings.
 * @returns The draft the form starts from.
 */
export function draftOf(settings: Settings): SettingsDraft {
  return {
    name: settings.name,
    email: settings.email,
    defaultContract: settings.defaultContract,
    paymentTerms: settings.paymentTerms,
    alertsOn: settings.alerts._tag === "Above",
    threshold: settings.alerts._tag === "Above" ? String(settings.alerts.ore) : DEFAULT_THRESHOLD,
    weeklyReport: settings.weeklyReport,
  };
}

/**
 * Parse the whole draft into settings, or name every field that does not parse.
 *
 * @param draft - The form's fields as typed.
 * @returns The settings, or the fields to fix.
 */
export function parseSettings(draft: SettingsDraft): ParsedSettings {
  const name = draft.name.trim();
  const email = draft.email.trim();
  const threshold = Number(draft.threshold.trim());
  const defaultContract = CONTRACT_TYPES.find((contract) => contract === draft.defaultContract);
  const paymentTerms = PAYMENT_TERMS.find((days) => days === draft.paymentTerms);
  const thresholdValid =
    !draft.alertsOn || (Number.isInteger(threshold) && threshold >= 1 && threshold <= 999);
  const checks = [
    ["name", name !== ""],
    ["email", isEmail(email)],
    ["threshold", thresholdValid],
  ] as const satisfies ReadonlyArray<readonly [SettingsField, boolean]>;
  const errors = checks.filter(([, valid]) => !valid).map(([field]) => field);

  // A contract or payment term the form never offers is a draft no form made.
  if (errors.length > 0 || defaultContract === undefined || paymentTerms === undefined) {
    return { _tag: "err", errors };
  }

  return {
    _tag: "ok",
    value: {
      name,
      email,
      defaultContract,
      paymentTerms,
      alerts: draft.alertsOn ? { _tag: "Above", ore: threshold } : { _tag: "Off" },
      weeklyReport: draft.weeklyReport,
    },
  };
}

/**
 * Whether two drafts hold the same fields, as typed.
 *
 * @param left - One draft.
 * @param right - The other.
 * @returns `true` when every field is the same.
 */
export function isSameDraft(left: SettingsDraft, right: SettingsDraft): boolean {
  return (
    left.name === right.name &&
    left.email === right.email &&
    left.defaultContract === right.defaultContract &&
    left.paymentTerms === right.paymentTerms &&
    left.alertsOn === right.alertsOn &&
    left.threshold === right.threshold &&
    left.weeklyReport === right.weeklyReport
  );
}

/**
 * Whether the draft shows exactly the saved settings.
 *
 * @param draft - The form's fields as typed.
 * @param settings - The saved settings.
 * @returns `true` when saving would change nothing.
 */
export function isUnchanged(draft: SettingsDraft, settings: Settings): boolean {
  return isSameDraft(draft, draftOf(settings));
}

/**
 * The fields of the draft that do not parse, as the draft stands: a field the visitor has fixed since is not among them.
 *
 * @param draft - The form's fields as typed.
 * @returns The fields to fix, in the form's order; none when the draft parses.
 */
export function settingsErrors(draft: SettingsDraft): SettingsErrors {
  const parsed = parseSettings(draft);

  return parsed._tag === "err" ? parsed.errors : [];
}

/** The saved settings, and the save that set them: a form numbers its saves from 1, and 0 is the settings it opened with. */
export type SavedSettings = { readonly settings: Settings; readonly save: number };

/**
 * Fold a save's answer into the saved settings. Saves can answer out of order (a language switch remounts the Save
 * button, so a second save can start before the first answers): an answer replaces the saved settings only when its
 * save started after the one that set them, so an older answer arriving last leaves the newer one's settings.
 *
 * @param current - The saved settings as they stand.
 * @param answer - The settings a save's answer says it saved, with that save's number.
 * @returns The saved settings after the answer: `answer` when it is newer, `current` itself otherwise.
 */
export function settleSave(current: SavedSettings, answer: SavedSettings): SavedSettings {
  return answer.save > current.save ? answer : current;
}
