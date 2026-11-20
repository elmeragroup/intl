# Changesets

[CONTRIBUTING.md](../CONTRIBUTING.md#release-impact) says when a pull request needs a changeset
and when it carries the `no-changeset` label instead.

`@elmeragroup/intl` and `@elmeragroup/intl-tools` are one `fixed` group in `config.json`: the tools
compile the catalogs the runtime decodes, so every release bumps both to the same version. Private
workspaces (the e2e fixtures, tooling, apps) take no changeset; `@elmeragroup/intl-e2e` is also listed
under `ignore`.

`snapshot` shapes canary versions as `x.y.z-canary.<UTC datetime>`, where `x.y.z` is the version the
pending changesets plan. A changeset whose entries are all `none` plans no bump and publishes no
canary. [CONTRIBUTING.md](../CONTRIBUTING.md#releases) describes the release path.
