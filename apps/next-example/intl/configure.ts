// Wires the adapter into getIntl, getT, getFormat and the server <T>. The root layout and every page and server action
// import it for this effect, so it runs before anything reads the request's translator.
import { configureNextIntl } from "@elmeragroup/intl/next/server";

import { adapter } from "./adapter";

configureNextIntl(adapter);
