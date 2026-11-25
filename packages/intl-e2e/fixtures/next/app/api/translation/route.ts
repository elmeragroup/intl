// A route handler that loads no layout and imports nothing but `/server`: withIntl's alias alone gives getT the
// request's locale.
import { getT } from "@elmeragroup/intl/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const t = await getT();

  return new Response(t("Route handler text"));
}
