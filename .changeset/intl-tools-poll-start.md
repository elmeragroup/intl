---
"@elmeragroup/intl-tools": patch
---

`elmera-intl extract --watch --poll` (and `vite dev` when it polls) starts in about one walk of the watched files plus
the first sync, whatever the interval. Before, once a walk of a large tree took longer than the interval, the walks ran
back to back and took the turns the first sync's reads needed, so a tree of 15,000 sources at `--poll 100` took
minutes to start, or never did. Now no walk runs during the first sync, and the next walk of the watched trees starts
the interval after it; the first sync's result and the ready line are queued before that interval starts, so a prompt
writer writes them first. The trees are walked one after another, each walk of them all starting the interval after
the previous one ends, and in the later rounds the host's timers and I/O run between one tree's walk and the next, so
slow walks, of one large tree or of several, no longer starve the syncs or a dev server sharing the process. A change
is seen within one interval plus two walks of them all, when the event loop is free to run the poll; the catalog is
updated once any sync already running, the debounce (restarted by each further save) and the sync are done.
