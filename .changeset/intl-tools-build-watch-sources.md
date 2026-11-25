---
"@elmeragroup/intl-tools": patch
---

`vite build --watch` with `intl()` rebuilds when a source the check read changes, so repairing the source that failed
the check clears the failure on the next rebuild. Before, a check that failed before the build loaded a module left only
the config, the catalogs and the formats module watched, and a source the build never imports was never watched. The
build now watches each source file the check read, and the target of a symlinked one, but none in an output directory
(`build.outDir`, or an output `dir` of `build.rolldownOptions`, `build.rollupOptions` on Vite 6 and 7, resolved against
the bundler's working directory as the bundler resolves it; a bundle the config's `include` may match), so a build
never rebuilds on its own output; a source created later is not watched yet (#64).
