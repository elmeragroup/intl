// The keys the request config's onError received while this request rendered: one array per request, through
// React.cache, read inside the handler (fixture-request.ts) and by the page that shows them (app/(alias)/reports).
import { cache } from "react";

export const requestReports = cache((): Array<string> => []);
