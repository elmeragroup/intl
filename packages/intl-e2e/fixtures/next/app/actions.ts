"use server";
import { getIntl } from "@elmeragroup/intl/server";

import "../intl/configure";

export async function runAction(): Promise<string> {
  const intl = await getIntl();

  return intl.t("Action result");
}
