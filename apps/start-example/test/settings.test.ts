import { describe, expect, it } from "vitest";

import { draftOf, INITIAL_SETTINGS, parseSettings, settleSave } from "../src/data/settings";
import { SettingsDraftSchema } from "../src/data/settings-draft";

// Unit under test: parseSettings's email field, which the form and the save action both run, the action on whatever a
// client posts. Oracle, stated per row: RFC 5321 §4.5.3.1.3, a forward path of at most 256 octets, so an address of
// at most 254 between its angle brackets, counted in UTF-8 (RFC 6531 §3.3 carries the limit over to addresses outside
// ASCII); the rest is the app's own policy, written in settings.ts: a local part, an
// `@` and a domain of two or more dot-separated labels, nothing empty and no whitespace.
const draft = draftOf(INITIAL_SETTINGS);

function emailParses(email: string): boolean {
  const parsed = parseSettings({ ...draft, email });

  return parsed._tag === "ok" || !parsed.errors.includes("email");
}

// An address of `length` characters: a local part of `a`s, then `@example.com`.
function addressOfLength(length: number): string {
  const domain = "@example.com";

  return `${"a".repeat(length - domain.length)}${domain}`;
}

// An address of `octets` UTF-8 octets, of fewer characters: a local part of `ø`s, two octets each, then one `a` when
// the count is odd, then `@example.com`.
function multibyteAddressOf(octets: number): string {
  const domain = "@example.com";
  const local = octets - domain.length;

  return `${"ø".repeat(Math.floor(local / 2))}${local % 2 === 1 ? "a" : ""}${domain}`;
}

describe("parseSettings: email", () => {
  it.each([
    { email: "name@example.com", parses: true, why: "a local part and a two-label domain" },
    { email: "first.last@mail.example.co", parses: true, why: "dots in the local part, three labels" },
    { email: addressOfLength(254), parses: true, why: "RFC 5321's longest address, 254 characters" },
    { email: addressOfLength(255), parses: false, why: "one character past RFC 5321's limit" },
    { email: multibyteAddressOf(254), parses: true, why: "254 octets in 133 characters, at the limit" },
    {
      email: multibyteAddressOf(255),
      parses: false,
      why: "255 octets in 134 characters, one octet past the limit",
    },
    { email: "name@example", parses: false, why: "a domain of one label" },
    { email: "name@example..com", parses: false, why: "an empty label" },
    { email: "name@.example.com", parses: false, why: "a domain that starts with a dot" },
    { email: "name@example.com.", parses: false, why: "a domain that ends with a dot" },
    { email: "na me@example.com", parses: false, why: "whitespace in the local part" },
    { email: "name@@example.com", parses: false, why: "two `@`s" },
  ])("$why: $parses", ({ email, parses }) => {
    expect(emailParses(email)).toBe(parses);
  });
});

// Unit under test: settleSave, the rule for which save's answer sets the saved settings. Oracle: the rule as the form's
// visitor sees it, stated here per case: the saved settings are those of the latest save to start, whatever order the
// answers arrive in.
describe("settleSave", () => {
  const opened = { settings: INITIAL_SETTINGS, save: 0 };
  const first = { settings: { ...INITIAL_SETTINGS, name: "Kari Nordmann" }, save: 1 };
  const second = { settings: { ...INITIAL_SETTINGS, name: "Ola Nordmann" }, save: 2 };

  it("keeps the second save's settings when the first save answers after it", () => {
    expect(settleSave(settleSave(opened, second), first).settings.name).toBe("Ola Nordmann");
  });

  it("takes each answer when they arrive in order", () => {
    expect(settleSave(settleSave(opened, first), second).settings.name).toBe("Ola Nordmann");
  });
});

// Unit under test: SettingsDraftSchema, which the save runs on whatever a client posts before parseSettings reads its
// fields. Oracle: the draft's shape, SettingsDraft, as the form builds it (draftOf): every field present with its type,
// a string, a finite number or a boolean, stated per row; an array is no draft even when it carries the seven fields.
describe("SettingsDraftSchema", () => {
  it("takes the form's own draft as it is", () => {
    expect(SettingsDraftSchema.safeParse(draft)).toEqual({ success: true, data: draft });
  });

  it.each([
    { input: null, why: "null" },
    { input: "draft", why: "a string" },
    { input: [draft], why: "an array" },
    { input: Object.assign([], draft), why: "an array with the seven properties" },
    { input: { ...draft, name: undefined }, why: "a missing name" },
    { input: { ...draft, alertsOn: "false" }, why: 'the string "false" for a switch' },
    { input: { ...draft, weeklyReport: 0 }, why: "a number for a switch" },
    { input: { ...draft, paymentTerms: "14" }, why: "a number as a string" },
    { input: { ...draft, paymentTerms: Number.NaN }, why: "NaN payment terms" },
    { input: { ...draft, paymentTerms: Number.POSITIVE_INFINITY }, why: "infinite payment terms" },
    { input: { ...draft, threshold: 150 }, why: "a number for a text field" },
  ])("turns back $why", ({ input }) => {
    expect(SettingsDraftSchema.safeParse(input).success).toBe(false);
  });
});
