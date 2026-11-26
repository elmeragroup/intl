// Type-checks the package, then its source against the runtime's ES2022 floor (tsconfig.floor.json). Flags that
// `pnpm type-check` appends reach the package's run only; a failure of the floor's run prints its fix.
import { spawnSync } from "node:child_process";

function tsrs(args: ReadonlyArray<string>): number {
  const run = spawnSync("tsrs", ["--noEmit", ...args], { stdio: "inherit" });

  if (run.error !== undefined) {
    console.error(`type-check: could not run tsrs: ${run.error.message}`);
  }

  return run.status ?? 1;
}

const packageStatus = tsrs(process.argv.slice(2));
const floorStatus = packageStatus === 0 ? tsrs(["-p", "tsconfig.floor.json"]) : 0;

if (floorStatus !== 0) {
  console.error(
    "The runtime's floor is ES2022 (tsconfig.floor.json): replace the call above with an ES2022 equivalent, such as a copy then sort() for toSorted(), and never raise the lib."
  );
}

process.exitCode = packageStatus === 0 ? floorStatus : packageStatus;
