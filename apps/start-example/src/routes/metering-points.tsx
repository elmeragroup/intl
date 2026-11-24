// Metering points: one component renders the whole page, its header included, since the header's export button counts
// the rows the search and the filters leave.
import { createFileRoute } from "@tanstack/react-router";

import { MeteringPointsTable } from "../components/metering-points-table";

/** `/metering-points`: every point the retailer supplies. */
export const Route = createFileRoute("/metering-points")({
  component: MeteringPointsTable,
});
