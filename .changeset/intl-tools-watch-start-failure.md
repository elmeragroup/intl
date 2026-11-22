---
"@elmeragroup/intl-tools": patch
---

A watch that fails to start closes the watches it had already started: `elmera-intl extract --watch` exits 2 after
printing the crash (for example, an unreadable directory on Linux) instead of staying alive on them, and the Vite
plugin's dev-server watch leaves no file watcher behind when its start throws.
