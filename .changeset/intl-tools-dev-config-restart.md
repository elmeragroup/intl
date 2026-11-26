---
"@elmeragroup/intl-tools": patch
---

During `vite dev`, an edit to `elmera-intl.json` restarts the in-process `extract --watch` on the edited config (a new
locale, a changed `include` or `catalogs`) and recompiles every PO import, without restarting the dev server, as
`extract --watch` itself does. Before, the watch kept the config it read at startup, and a server that started on an
invalid or missing config never started its watch. The watch reads the config itself, so a config outside the Vite root
(the `config` option), a config symlink's target and a repoint of the link are followed whatever Vite's watcher
reports. The server logs each restart of the watch, which can come before the server has finished starting. Open tabs
are told at least once and never held back: at the change, again once the new watch has written its first sync's
result, and for every PO save or PO the watch creates, as Vite's watcher reports it, during a restart included, whether
or not the restart's watch then starts. A first sync that a PO save supersedes writes a new locale's PO in its retry,
after the second notice, so a PO outside what Vite's watcher covers (outside the Vite root, under `server.watch.ignored`,
or any with `server.watch: null`) is not announced then
([#85](https://github.com/elmeragroup/intl/issues/85)). A restart whose watch
fails to start logs a `WatchFailed` problem, and the next edit retries. The server finishes starting once the watch on
its config as it is then has synced, so a first watch that failed while an edit replaced it does not fail the start.
When the Vite config imports `elmera-intl.json`, Vite's own server restart handles the edit: the new server starts its
own watch before the old one closes, so both may sync the same catalog once, which adds nothing twice. A watch that
fails for good once started ends `vite dev`, as a report that threw always did, with `elmera-intl: the catalog watch
ended` and the failure as its cause; during the server's close it is logged instead of being dropped. That now includes
a logger that throws on a result and again on its `SyncFailed` during a restart, and a watcher that fails to close as
the watch restarts for a config edit, both of which an earlier, unreleased version of this follow logged and moved past.
