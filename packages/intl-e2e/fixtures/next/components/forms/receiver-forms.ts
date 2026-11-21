// The `.t` call forms on an IntlInstance bound in this file.
import { getIntl } from "@elmeragroup/intl/server";

export async function receiverForms(): Promise<ReadonlyArray<string>> {
  const intl = await getIntl();

  // oxfmt-ignore
  // oxlint-disable-next-line typescript/dot-notation, typescript/no-unnecessary-condition -- the computed key and the optional call are forms under test
  return [intl.t("Form dot"), intl.t?.("Form optional"), (intl.t)("Form paren"), intl["t"]("Form computed")];
}
