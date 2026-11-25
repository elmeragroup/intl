---
"@elmeragroup/intl-tools": patch
---

During `vite dev`, an edit to `elmera-intl.json` restarts the in-process `extract --watch` on the edited config (a new
locale, a changed `include` or `catalogs`) and recompiles every PO import, without restarting the dev server. Before,
the watch kept the config it read at startup, and a server that started on an invalid or missing config never started
its watch. The watch always runs on the config as last saved, however the saves interleave with a restart; open tabs are
told once, when the new watch has written its catalogs (a PO save during the restart tells them nothing before then, and
a restart whose watch fails to start tells them nothing); and the server finishes starting only once the watch on the
config as it is then has synced, so a first watch that failed while an edit replaced it does not fail the start. A
config outside the Vite root (the `config` option) is followed too, and so are edits of a config symlink's target
outside the root and a symlink repoint of the config, including later edits of its new target (as the watcher reports
them: with `server.watch.followSymlinks` left on, polling does not report a repoint to a same-size target with an older
modification time). When the Vite config imports `elmera-intl.json`, Vite's own server restart handles the edit; a
repoint of a config symlink, which Vite reports at the link, is followed by the watch even when the Vite config imports
the new target. The server logs each restart of the watch, and a step of it that fails is logged without stopping the
next edit from being followed.
