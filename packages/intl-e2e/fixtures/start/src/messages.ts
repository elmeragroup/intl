// A .ts module declaring a message with msg(); the route translates it with t.from.
import { msg } from "@elmeragroup/intl/core";

export const DESCRIPTOR = msg("Declared message");

// 00:30 on Mar 5 in Oslo, the fixture's zone; Mar 4 in UTC.
export const DUE = new Date("2026-03-04T23:30:00Z");
