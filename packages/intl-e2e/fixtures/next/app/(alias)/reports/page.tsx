import { getFormat } from "@elmeragroup/intl/server";

import { requestReports } from "../../../intl/request-reports";

// Per request, on the Node runtime: React.cache keeps the request's array across the await there (Edge drops it).
export const dynamic = "force-dynamic";

// A format name the fixture's formats lack, so the server translator reports it to the request config's onError, then
// the keys that handler received in this request.
export default async function Page() {
  const format = await getFormat();
  format.dateTime(new Date(Date.UTC(2026, 2, 5)), "elmeraMissing");

  return <output id="reports">{requestReports().join(",")}</output>;
}
