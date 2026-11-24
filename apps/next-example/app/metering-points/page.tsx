// Metering points: a client component renders the whole page, its header included, since the header's export button
// counts the rows the search and the filters leave.
import type { Metadata } from "next";

import { getT } from "@elmeragroup/intl/server";

import { APP_PAGE_BY_ID } from "../../components/app-config";
import { MeteringPointsTable } from "../../components/metering-points-table";

/**
 * The document's title, in the request's language.
 *
 * @returns The page's name, which the layout's template follows with the app's.
 */
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).from(APP_PAGE_BY_ID["metering-points"].label) };
}

/** The metering points page. */
export default function MeteringPointsPage() {
  return <MeteringPointsTable />;
}
