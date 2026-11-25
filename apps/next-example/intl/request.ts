// The app's request config, at the path withIntl aliases by default: getIntl, getT, getFormat and the server <T> read
// each request through it, so no page, layout or action imports setup code.
import { createRequestConfig } from "@elmeragroup/intl/next/server";

import { adapter } from "./adapter";

export default createRequestConfig(adapter);
