// The settings save's network boundary. The save's server function receives the draft as the network delivers it: any JSON,
// whatever the caller's types said, since anyone can post to it. Its shape is parsed here, then parseSettings
// (settings.ts) parses its fields, as the form did.
import * as z from "zod";

/**
 * The draft a save receives, as the form builds it (draftOf): every field there with the form's type, a string, a
 * finite number, or a flag that is `true` or `false`, never the string `"false"`. An array is no draft, and a field
 * the draft does not name is dropped from the parsed value. `SettingsDraftSchema.safeParse(input)` parses a save's
 * argument; `SettingsDraft` (settings.ts) is its output.
 */
export const SettingsDraftSchema = z.object({
  name: z.string(),
  email: z.string(),
  defaultContract: z.string(),
  // Zod 4's number is finite: NaN and the infinities fail.
  paymentTerms: z.number(),
  alertsOn: z.boolean(),
  threshold: z.string(),
  weeklyReport: z.boolean(),
});
