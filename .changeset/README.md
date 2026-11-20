# Changesets

[CONTRIBUTING.md](../CONTRIBUTING.md#release-impact) says when a pull request needs a changeset
and when it carries the `no-changeset` label instead.

`@elmeragroup/intl` and `@elmeragroup/intl-tools` are fixed together: the tools compile the catalogs
the runtime decodes, so every release bumps both to the same version. Private workspaces (the e2e fixtures,
tooling, apps) take no changeset.

The `fixed` group in `config.json` arrives with the two packages: Changesets rejects a group that
names a package the workspace does not have.
