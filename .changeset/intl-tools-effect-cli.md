---
"@elmeragroup/intl-tools": patch
---

The `elmera-intl` CLI now runs on `effect/cli`, adding a runtime dependency on `@effect/platform-node-shared` (4.1.3, with `ws`). Its arguments, output, exit codes and signal handling are unchanged: SIGINT or SIGTERM stops `extract --watch` with exit 0 and ends `extract` or `check` at once. The CLI starts about 35 ms slower. Neither the Vite plugin nor the Vitest setup loads `effect/cli` or `@effect/platform-node-shared`: they run `check` in-process without the CLI.
