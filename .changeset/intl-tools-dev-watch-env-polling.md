---
"@elmeragroup/intl-tools": patch
---

During `vite dev`, the in-process `extract --watch` follows the polling option of Vite's watcher
(`server.watcher.options`) whenever `CHOKIDAR_USEPOLLING` (the usual setting on a container's bind mount or WSL) is set,
on or off, and `server.watch.usePolling` when it is not. It polls at the watcher's interval, `CHOKIDAR_INTERVAL`
included. Before, it read only `server.watch`, so with only the variable set the watch waited for native file events,
which on such a mount never came, and a source save added nothing to the catalogs. An interval out of range is
reported under the setting it came from.
