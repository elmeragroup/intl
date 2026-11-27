---
"@elmeragroup/intl": patch
---

`react` is now an optional peer, so an app that uses only `/core` or `/effect` (an Effect server, for example) no longer gets React installed by npm, or a missing-peer warning (an error with `strictPeerDependencies`) from pnpm with `autoInstallPeers: false`. Every subpath that renders still needs it: install `react` `^19.0.0` with `/react`, `/server`, `/next`, `/next/server` or `/start` (#113).
