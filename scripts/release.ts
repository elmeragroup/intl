/**
 * Releases `@elmeragroup/intl` and `@elmeragroup/intl-tools` from a checked commit on `main`, run by
 * `.github/workflows/publish-release.yml` in two steps around the build:
 *
 *   node scripts/release.ts prepare [output]   # picks the channel; for canary, writes snapshot versions
 *   node scripts/release.ts publish <channel>  # publishes the built packages on that channel
 *
 * `version-packages.yml` runs `plan [output]` (whether the changesets bump the fixed group), and a
 * maintainer repairs split channel tags from their own npm session with
 * `promote <version> <canary|latest>`.
 *
 * The channel comes from the commit itself, so a rerun of a run picks the same one, in this order:
 *
 * - stable: the commit raised the fixed group's version over `HEAD^`, which only the merged Version
 *   Packages PR does. If changesets still plan a bump, that PR was merged stale (behind `main`) and its
 *   version can be too low, a patch for a breaking change, so the job fails instead of publishing. A
 *   lowered version (a reverted version commit) fails too: npm never takes a version twice. Only the
 *   commit that adds the packages, whose parent has neither manifest, skips the comparison.
 * - canary: pending changesets bump the fixed group, and the commit is still `origin/main`'s head.
 *   `changeset version --snapshot canary` writes `x.y.z-canary.<UTC datetime>` (x.y.z is the planned
 *   version) into this disposable checkout only. A run for an older commit skips, so a delayed run or
 *   a rerun cannot move `canary` back to older code.
 * - none: anything else.
 *
 * Both channels publish under the staging dist-tag `pending`, then promote both packages to `canary` or
 * `latest`, so a channel tag never points at one package of a pair whose other upload failed. `latest`
 * only moves forward, so rerunning an older stable run cannot roll it back; `canary` relies on the head
 * check. `promote` moves either tag only forward, ordering canaries by their snapshot datetime, refuses
 * any move that would leave the pair split, and refuses while a Merge run on `main` could publish.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES = [
  { name: "@elmeragroup/intl", directory: "packages/intl" },
  { name: "@elmeragroup/intl-tools", directory: "packages/intl-tools" },
] as const;
const STATUS_FILE = ".artifacts/release/status.json";
/** The dist-tag both packages publish under before either channel tag moves. */
const STAGING_TAG = "pending";
const REPOSITORY = "elmeragroup/intl";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const BUMP_TYPES: ReadonlySet<unknown> = new Set(["major", "minor", "patch"]);
/** The workflow whose runs on `main` publish (it calls publish-release.yml). */
const RELEASE_WORKFLOW = "merge.yml";
/** Every run status that is not `completed`: such a run can still publish. */
const ACTIVE_RUN_STATUSES = ["queued", "in_progress", "requested", "waiting", "pending"] as const;
/** A canary version as `.changeset/config.json`'s `{tag}.{datetime}` snapshot template writes it. */
const CANARY_VERSION = /^\d+\.\d+\.\d+-canary\.(\d{14})$/u;

/** Where a run publishes: a canary of pending changesets, the stable version on `main`, or nothing. */
type Channel = "canary" | "stable" | "none";

/** A channel that publishes. */
type PublishChannel = Exclude<Channel, "none">;

/** The npm dist-tag a channel moves. */
type ChannelTag = "canary" | "latest";

/** A command the release ran exited non-zero or could not start. */
class CommandFailed extends Error {
  readonly _tag = "CommandFailed" as const;
  readonly command: string;

  constructor(command: string, cause: unknown) {
    super(`${command} failed`, { cause });
    this.command = command;
  }
}

/** A manifest, `changeset status` file or command output did not have the shape the release reads. */
class UnexpectedFile extends Error {
  readonly _tag = "UnexpectedFile" as const;
  readonly file: string;

  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.file = file;
  }
}

/** The two packages carry different versions, or a canary version lacks its `-canary.` part. */
class VersionMismatch extends Error {
  readonly _tag = "VersionMismatch" as const;
  readonly versions: ReadonlyArray<string>;

  constructor(versions: ReadonlyArray<string>, detail: string) {
    super(`${detail}, found ${versions.join(", ")}`);
    this.versions = versions;
  }
}

/** Why the release refuses to go on. */
type RefusalReason =
  | "stale-release-pr"
  | "version-lowered"
  | "tag-elsewhere"
  | "tag-missing"
  | "draft-release"
  | "not-on-npm"
  | "tags-split"
  | "release-running"
  | "canary-took-latest";

/** Publishing now would ship the wrong thing; the message says what the maintainer does next. */
class ReleaseRefused extends Error {
  readonly _tag = "ReleaseRefused" as const;
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

type ReleaseError = CommandFailed | UnexpectedFile | VersionMismatch | ReleaseRefused;

type Result<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: ReleaseError };

function ok<T>(value: T): Result<T> {
  return { _tag: "ok", value };
}

function err<T>(error: ReleaseError): Result<T> {
  return { _tag: "err", error };
}

/** Runs a command whose output the release reads; stderr still streams to the log. */
function capture(command: string, args: ReadonlyArray<string>): Result<string> {
  try {
    return ok(
      execFileSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
    );
  } catch (cause) {
    return err(new CommandFailed([command, ...args].join(" "), cause));
  }
}

/**
 * Runs a command with its whole output streamed to the log, so a failure keeps its diagnostics. Stdin is
 * inherited so `promote`, run by a maintainer, can answer npm's one-time-password prompt.
 */
function stream(command: string, args: ReadonlyArray<string>): Result<void> {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });

    return ok(undefined);
  } catch (cause) {
    return err(new CommandFailed([command, ...args].join(" "), cause));
  }
}

function parseJson(file: string, text: string): Result<unknown> {
  try {
    return ok(JSON.parse(text));
  } catch (cause) {
    return err(new UnexpectedFile(file, `unreadable JSON (${String(cause)})`));
  }
}

function readText(file: string): Result<string> {
  try {
    return ok(readFileSync(resolve(ROOT, file), "utf8"));
  } catch (cause) {
    return err(new UnexpectedFile(file, `unreadable (${String(cause)})`));
  }
}

/** Where a manifest is read from: the working tree (which a snapshot rewrites) or a commit. */
type ManifestSource =
  | { readonly _tag: "WorkingTree" }
  | { readonly _tag: "Commit"; readonly revision: string };

const WORKING_TREE: ManifestSource = { _tag: "WorkingTree" };

function manifestVersion(directory: string, source: ManifestSource): Result<string> {
  const file = `${directory}/package.json`;
  const text =
    source._tag === "WorkingTree" ? readText(file) : capture("git", ["show", `${source.revision}:${file}`]);

  if (text._tag === "err") {
    return text;
  }

  const manifest = parseJson(file, text.value);

  if (manifest._tag === "err") {
    return manifest;
  }

  const { value } = manifest;

  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    return err(new UnexpectedFile(file, "no string version"));
  }

  return ok(value.version);
}

/** The one version both packages carry. */
function releaseVersion(source: ManifestSource): Result<string> {
  const versions: Array<string> = [];

  for (const { directory } of PACKAGES) {
    const version = manifestVersion(directory, source);

    if (version._tag === "err") {
      return version;
    }

    versions.push(version.value);
  }

  const distinct = [...new Set(versions)];
  const [version] = distinct;

  if (distinct.length !== 1 || version === undefined) {
    return err(new VersionMismatch(distinct, "the packages must share one version"));
  }

  return ok(version);
}

/** Whether the pending changesets bump the fixed group; a changeset of only `none` entries does not. */
function plansBump(): Result<boolean> {
  mkdirSync(dirname(resolve(ROOT, STATUS_FILE)), { recursive: true });
  const ran = stream("pnpm", ["exec", "changeset", "status", "--output", STATUS_FILE]);

  if (ran._tag === "err") {
    return ran;
  }

  const text = readText(STATUS_FILE);

  if (text._tag === "err") {
    return text;
  }

  const status = parseJson(STATUS_FILE, text.value);

  if (status._tag === "err") {
    return status;
  }

  const { value } = status;

  if (
    typeof value !== "object" ||
    value === null ||
    !("releases" in value) ||
    !Array.isArray(value.releases)
  ) {
    return err(new UnexpectedFile(STATUS_FILE, "no releases array"));
  }

  const releases: ReadonlyArray<unknown> = value.releases;

  return ok(
    releases.some(
      (release) =>
        typeof release === "object" && release !== null && "type" in release && BUMP_TYPES.has(release.type)
    )
  );
}

/** The checked commit, as git reports it. */
function checkedCommit(): Result<string> {
  const checked = capture("git", ["rev-parse", "HEAD"]);

  return checked._tag === "err" ? checked : ok(checked.value.trim());
}

/** The checked commit and `origin/main`'s head as the remote reports it now, not the fetched ref. */
function mainHead(): Result<{ readonly checked: string; readonly head: string }> {
  const checked = checkedCommit();

  if (checked._tag === "err") {
    return checked;
  }

  const listed = capture("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"]);

  if (listed._tag === "err") {
    return listed;
  }

  const [head] = listed.value.split("\t");

  if (head === undefined || !/^[0-9a-f]{40}$/u.test(head)) {
    return err(
      new UnexpectedFile("git ls-remote origin refs/heads/main", `no commit in "${listed.value.trim()}"`)
    );
  }

  return ok({ checked: checked.value, head });
}

function prepareCanary(): Result<Channel> {
  const commits = mainHead();

  if (commits._tag === "err") {
    return commits;
  }

  const { checked, head } = commits.value;

  if (checked !== head) {
    process.stdout.write(
      `skipping canary: ${checked} is no longer origin/main's head (${head}); that commit's run publishes instead\n`
    );

    return ok("none");
  }

  const versioned = stream("pnpm", ["exec", "changeset", "version", "--snapshot", "canary"]);

  if (versioned._tag === "err") {
    return versioned;
  }

  const version = releaseVersion(WORKING_TREE);

  if (version._tag === "err") {
    return version;
  }

  if (!version.value.includes("-canary.")) {
    return err(new VersionMismatch([version.value], "the snapshot must write a -canary. version"));
  }

  process.stdout.write(`canary ${version.value}\n`);

  return ok("canary");
}

/** A version's numeric core and prerelease, enough to order the versions this release writes. */
type ParsedVersion = {
  readonly core: readonly [number, number, number];
  readonly prerelease: string | undefined;
};

function parseVersion(text: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(text);

  if (match === null) {
    return undefined;
  }

  const [, major, minor, patch, prerelease] = match;

  return { core: [Number(major), Number(minor), Number(patch)], prerelease };
}

/** Whether `candidate` orders after `current` (semver precedence for the versions released here). */
function isAfter(candidate: ParsedVersion, current: ParsedVersion): boolean {
  for (const [index, part] of candidate.core.entries()) {
    const other = current.core[index] ?? 0;

    if (part !== other) {
      return part > other;
    }
  }

  // Same core: a release orders after its prereleases.
  if (candidate.prerelease === undefined || current.prerelease === undefined) {
    return candidate.prerelease === undefined && current.prerelease !== undefined;
  }

  return candidate.prerelease > current.prerelease;
}

/** How `next` orders against `previous`; an unparsable version is an error naming `source`. */
function compareVersions(
  next: string,
  previous: string,
  source: string
): Result<"after" | "same" | "before"> {
  if (next === previous) {
    return ok("same");
  }

  const parsedNext = parseVersion(next);
  const parsedPrevious = parseVersion(previous);

  if (parsedNext === undefined || parsedPrevious === undefined) {
    return err(new UnexpectedFile(source, `cannot order ${next} against ${previous}`));
  }

  return ok(isAfter(parsedNext, parsedPrevious) ? "after" : "before");
}

/**
 * Whether this commit raised the packages' version over `HEAD^`, as the merged Version Packages PR
 * does. A lowered version is refused rather than treated as "no version change": a revert of a version
 * commit also restores its changesets, and a canary planned from the lowered version would order below
 * the stable version npm already has.
 */
function raisesVersion(): Result<boolean> {
  const version = releaseVersion(WORKING_TREE);

  if (version._tag === "err") {
    return version;
  }

  // A root commit has no HEAD^ to read, so `git ls-tree HEAD^` would fail: it adds the packages.
  const parents = capture("git", ["rev-list", "--parents", "--max-count=1", "HEAD"]);

  if (parents._tag === "err") {
    return parents;
  }

  if (parents.value.trim().split(" ").length === 1) {
    process.stdout.write("HEAD is a root commit: this commit adds the packages\n");

    return ok(false);
  }

  // `git ls-tree` lists only the paths that exist and fails only when git does, so an absent manifest
  // is not mistaken for a failed lookup.
  const parentManifests = capture("git", [
    "ls-tree",
    "--name-only",
    "HEAD^",
    "--",
    ...PACKAGES.map(({ directory }) => `${directory}/package.json`),
  ]);

  if (parentManifests._tag === "err") {
    return parentManifests;
  }

  // The commit that adds the packages has nothing to compare against. Any other commit is compared, so
  // a revert back to the unreleased version is refused like every other lowered version.
  if (parentManifests.value.trim() === "") {
    process.stdout.write("HEAD^ has no package manifests: this commit adds the packages\n");

    return ok(false);
  }

  const previous = releaseVersion({ _tag: "Commit", revision: "HEAD^" });

  if (previous._tag === "err") {
    return previous;
  }

  const order = compareVersions(version.value, previous.value, "HEAD^ and HEAD package.json");

  if (order._tag === "err") {
    return order;
  }

  if (order.value === "before") {
    return err(
      new ReleaseRefused(
        "version-lowered",
        `this commit lowers the packages' version from ${previous.value} to ${version.value}, as a revert of a version commit does; npm never takes a version twice, so the next release must come after ${previous.value}: in one commit, revert this revert (restoring ${previous.value} and dropping the restored changesets) and add a changeset for the fix; the stable job refuses that commit too, and the Version Packages PR it regenerates releases the next version`
      )
    );
  }

  if (order.value === "after") {
    process.stdout.write(`stable ${version.value} (was ${previous.value})\n`);
  }

  return ok(order.value === "after");
}

function prepare(): Result<Channel> {
  const raised = raisesVersion();

  if (raised._tag === "err") {
    return raised;
  }

  const bump = plansBump();

  if (bump._tag === "err") {
    return bump;
  }

  if (raised.value) {
    return bump.value
      ? err(
          new ReleaseRefused(
            "stale-release-pr",
            "this commit versions the packages, but changesets still plan a bump: the Version Packages PR was merged while behind main, so its version can be too low (a patch for a breaking change). Nothing was published. The Version Packages job on this push regenerates the release PR from the pending changesets; merge that PR to release"
          )
        )
      : ok("stable");
  }

  if (!bump.value) {
    process.stdout.write("nothing to release: no pending bump, and this commit versioned nothing\n");

    return ok("none");
  }

  return prepareCanary();
}

/** The GitHub release body: each package's changelog at the release tag. */
function releaseNotes(tag: string): string {
  return PACKAGES.map(
    ({ name, directory }) =>
      `- [\`${name}\` changelog](${REPOSITORY_URL}/blob/${tag}/${directory}/CHANGELOG.md)`
  ).join("\n");
}

/** A dist-tag's version for one package; `undefined` when npm has no such tag yet. */
function distTag(name: string, tag: ChannelTag): Result<string | undefined> {
  const listed = capture("npm", ["view", name, `dist-tags.${tag}`]);

  if (listed._tag === "err") {
    return listed;
  }

  const current = listed.value.trim();

  return ok(current === "" ? undefined : current);
}

/**
 * How `next` orders against `current` on a channel tag.
 *
 * - `canary`: by snapshot UTC datetime, the canary's real order and the one CI's head check keeps.
 *   After a reverted minor changeset, `0.1.1-canary.<later>` is newer than `0.2.0-canary.<earlier>`.
 * - `latest`: semver order, except that a release always displaces a prerelease. npm gives `latest` to
 *   a package's first upload even under another tag (npm/cli#8490), so `latest` can start on a canary
 *   (or the `0.0.0-stage` placeholder) whose core is above the first stable.
 */
function channelOrder(next: string, current: string, tag: ChannelTag): Result<"after" | "same" | "before"> {
  const source = `dist-tag ${tag}`;

  if (next === current) {
    return ok("same");
  }

  if (tag === "canary") {
    const nextTime = CANARY_VERSION.exec(next)?.[1];
    const currentTime = CANARY_VERSION.exec(current)?.[1];

    if (nextTime === undefined || currentTime === undefined) {
      return err(
        new UnexpectedFile(
          source,
          `cannot order ${next} against ${current}: canary needs x.y.z-canary.<datetime>`
        )
      );
    }

    // Same datetime with different versions cannot come from one snapshot run; refuse to guess.
    if (nextTime === currentTime) {
      return err(new UnexpectedFile(source, `${next} and ${current} share a snapshot datetime`));
    }

    return ok(nextTime > currentTime ? "after" : "before");
  }

  const parsedNext = parseVersion(next);
  const parsedCurrent = parseVersion(current);

  if (
    parsedNext !== undefined &&
    parsedCurrent !== undefined &&
    parsedNext.prerelease === undefined &&
    parsedCurrent.prerelease !== undefined
  ) {
    return ok("after");
  }

  return compareVersions(next, current, source);
}

/** Every version npm has of `name`. `npm view --json` prints a bare string when there is only one. */
function publishedVersions(name: string): Result<ReadonlySet<string>> {
  const command = `npm view ${name} versions --json`;
  const listed = capture("npm", ["view", name, "versions", "--json"]);

  if (listed._tag === "err") {
    return listed;
  }

  const parsed = parseJson(command, listed.value);

  if (parsed._tag === "err") {
    return parsed;
  }

  const { value } = parsed;

  if (typeof value === "string") {
    return ok(new Set([value]));
  }

  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return err(new UnexpectedFile(command, "not a version list"));
  }

  return ok(new Set(value));
}

/** The packages missing `version` on npm; empty when both have it. */
function missingOnNpm(version: string): Result<ReadonlyArray<string>> {
  const missing: Array<string> = [];

  for (const { name } of PACKAGES) {
    const versions = publishedVersions(name);

    if (versions._tag === "err") {
      return versions;
    }

    if (!versions.value.has(version)) {
      missing.push(name);
    }
  }

  return ok(missing);
}

/** One package's tag before a promotion, and how the promoted version orders against it. */
type TagState = {
  readonly name: string;
  readonly current: string | undefined;
  readonly order: "after" | "same" | "before";
};

/**
 * The refusal for a promotion that would leave the pair split: the tags differ and `ahead`, the newest
 * tag, is ahead of `version`. It names `ahead` when both packages have it on npm, because promoting
 * that one aligns both.
 */
function splitRefusal(
  version: string,
  tag: ChannelTag,
  states: ReadonlyArray<TagState>,
  ahead: string
): ReleaseError {
  const tags = states.map(({ name, current }) => `${name} ${tag} is ${current ?? "unset"}`).join(", ");
  const missing = missingOnNpm(ahead);

  if (missing._tag === "err") {
    return missing.error;
  }

  const remedy =
    missing.value.length === 0
      ? `run promote ${ahead} ${tag} instead, which aligns both`
      : `${ahead} would align both, but ${missing.value.join(" and ")} lacks it on npm; publish a newer pair, or move the tags with npm dist-tag add`;

  return new ReleaseRefused(
    "tags-split",
    `${tags}: promoting ${version} would leave the pair split, so no tag moved; ${remedy}`
  );
}

/** The newest of `first` and `rest` on `tag`; versions it cannot order keep the earlier pick. */
function newestOn(tag: ChannelTag, first: string, rest: ReadonlyArray<string>): string {
  return rest.reduce((newest, candidate) => {
    const order = channelOrder(candidate, newest, tag);

    return order._tag === "ok" && order.value === "after" ? candidate : newest;
  }, first);
}

/**
 * How a promotion orders against the tags' current versions. A CI canary is `head-checked`: the head
 * check already keeps it from moving back, so it moves both tags unconditionally.
 */
type PromotionOrder = "forward-only" | "head-checked";

/**
 * Moves `tag` to `version` for both packages. Forward-only reads both tags and decides for the pair
 * before writing either: each tag moves forward or stays at `version`; when one is ahead, the pair is
 * kept as it is if it already matches, and refused if the move would leave it split.
 */
function promote(version: string, tag: ChannelTag, order: PromotionOrder): Result<void> {
  const moving: Array<string> = [];

  if (order === "head-checked") {
    moving.push(...PACKAGES.map(({ name }) => name));
  } else {
    const states: Array<TagState> = [];

    for (const { name } of PACKAGES) {
      const current = distTag(name, tag);

      if (current._tag === "err") {
        return current;
      }

      if (current.value === undefined) {
        states.push({ name, current: undefined, order: "after" });
        continue;
      }

      const ordered = channelOrder(version, current.value, tag);

      if (ordered._tag === "err") {
        return ordered;
      }

      states.push({ name, current: current.value, order: ordered.value });
    }

    const [first, ...rest] = states.flatMap(({ current, order: ordered }) =>
      ordered === "before" && current !== undefined ? [current] : []
    );

    if (first !== undefined) {
      if (new Set(states.map((state) => state.current)).size > 1) {
        return err(splitRefusal(version, tag, states, newestOn(tag, first, rest)));
      }

      process.stdout.write(`keeping ${tag} at ${first} for both: ${version} is not newer\n`);

      return ok(undefined);
    }

    for (const state of states) {
      if (state.order === "same") {
        process.stdout.write(`${state.name} ${tag} is already ${version}\n`);
      } else {
        moving.push(state.name);
      }
    }
  }

  for (const name of moving) {
    const promoted = stream("npm", ["dist-tag", "add", `${name}@${version}`, tag]);

    if (promoted._tag === "err") {
      return promoted;
    }
  }

  return ok(undefined);
}

/** The commit tag `name` points at on `origin` (peeled, for an annotated tag), or undefined when absent. */
function remoteTagCommit(name: string): Result<string | undefined> {
  const ref = `refs/tags/${name}`;
  const listed = capture("git", ["ls-remote", "origin", ref, `${ref}^{}`]);

  if (listed._tag === "err") {
    return listed;
  }

  const commits = new Map(
    listed.value
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [commit = "", listedRef = ""] = line.split("\t");

        return [listedRef, commit] as const;
      })
  );

  return ok(commits.get(`${ref}^{}`) ?? commits.get(ref));
}

/** Refuses when tag `name` already exists on `origin` at a commit other than the one built here. */
function requireTagFree(name: string, commit: string): Result<void> {
  const tagged = remoteTagCommit(name);

  if (tagged._tag === "err") {
    return tagged;
  }

  if (tagged.value !== undefined && tagged.value !== commit) {
    return err(
      new ReleaseRefused(
        "tag-elsewhere",
        `tag ${name} points at ${tagged.value}, not the built commit ${commit}; find out which commit ${name} should mark, and delete or move the wrong tag before rerunning`
      )
    );
  }

  return ok(undefined);
}

/**
 * Requires tag `name` on `origin` at `commit`. GitHub attaches a release to an existing tag and ignores
 * `--target`, so a tag created at another commit between the preflight and the create would otherwise
 * mark the release on the wrong code.
 */
function requireTagAt(name: string, commit: string): Result<void> {
  const tagged = remoteTagCommit(name);

  if (tagged._tag === "err") {
    return tagged;
  }

  if (tagged.value === undefined) {
    return err(
      new ReleaseRefused(
        "tag-missing",
        `the GitHub release ${name} exists but tag ${name} is not on origin; check the release, then rerun`
      )
    );
  }

  if (tagged.value !== commit) {
    return err(
      new ReleaseRefused(
        "tag-elsewhere",
        `the GitHub release ${name} is attached to tag ${name} at ${tagged.value}, not the built commit ${commit}; find out which commit ${name} should mark, delete the release and the wrong tag, then rerun`
      )
    );
  }

  return ok(undefined);
}

/** Whether GitHub has a release for `tag`, and whether it is still a draft. */
function releaseState(tag: string): Result<"missing" | "draft" | "published"> {
  const listed = capture("gh", [
    "release",
    "list",
    "--limit",
    "1000",
    "--json",
    "tagName,isDraft",
    "--jq",
    `.[] | select(.tagName == "${tag}") | .isDraft`,
  ]);

  if (listed._tag === "err") {
    return listed;
  }

  const isDraft = listed.value.split("\n").find((line) => line !== "");

  if (isDraft === undefined) {
    return ok("missing");
  }

  return ok(isDraft === "true" ? "draft" : "published");
}

/** Shell-quotes one argument for the recovery command a maintainer pastes. */
function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

/** Creates the GitHub release `tag` at `commit`, or confirms the one that exists there is published. */
function recordRelease(tag: string, commit: string): Result<void> {
  const state = releaseState(tag);

  if (state._tag === "err") {
    return state;
  }

  if (state.value === "draft") {
    return err(
      new ReleaseRefused(
        "draft-release",
        `the GitHub release ${tag} is a draft; check that it marks ${commit}, publish it (or delete it), then rerun`
      )
    );
  }

  if (state.value === "published") {
    return requireTagAt(tag, commit);
  }

  const notes = releaseNotes(tag);
  const created = stream("gh", [
    "release",
    "create",
    tag,
    "--target",
    commit,
    "--title",
    tag,
    "--notes",
    notes,
  ]);

  if (created._tag === "err") {
    // The job's GITHUB_TOKEN cannot create a release whose target changes .github/workflows relative
    // to the default branch, which a later workflow edit on main causes; a maintainer can. Creating the
    // ref first fails if the tag exists, and --verify-tag then attaches the release to that ref only,
    // so the command cannot attach to a tag at another commit.
    const createRef = [
      "api",
      `repos/${REPOSITORY}/git/refs`,
      "-f",
      `ref=refs/tags/${tag}`,
      "-f",
      `sha=${commit}`,
    ];
    const createRelease = ["release", "create", tag, "--verify-tag", "--title", tag, "--notes", notes];
    process.stderr.write(
      [
        "To record the release from a maintainer session with workflow write access, run:",
        `  gh ${createRef.map((arg) => shellQuote(arg)).join(" ")} && gh ${createRelease.map((arg) => shellQuote(arg)).join(" ")} --repo ${REPOSITORY}`,
        `If the ref already exists, check it marks ${commit} (gh api repos/${REPOSITORY}/git/ref/tags/${tag} --jq .object.sha) before running the release create alone.`,
        "",
      ].join("\n")
    );

    return created;
  }

  return requireTagAt(tag, commit);
}

function publish(channel: PublishChannel): Result<void> {
  const version = releaseVersion(WORKING_TREE);

  if (version._tag === "err") {
    return version;
  }

  // The checkout is the checked commit, so the tag lands on what was built and published.
  const commit = checkedCommit();

  if (commit._tag === "err") {
    return commit;
  }

  const tag = `v${version.value}`;

  if (channel === "stable") {
    const free = requireTagFree(tag, commit.value);

    if (free._tag === "err") {
      return free;
    }
  }

  // changeset publish skips a version npm already has, so a rerun after a partial failure uploads only the rest.
  const published = stream("pnpm", ["exec", "changeset", "publish", "--tag", STAGING_TAG, "--no-git-tag"]);

  if (published._tag === "err") {
    return published;
  }

  const promoted =
    channel === "canary"
      ? promote(version.value, "canary", "head-checked")
      : promote(version.value, "latest", "forward-only");

  if (promoted._tag === "err") {
    return promoted;
  }

  return channel === "canary" ? requireLatestNotOn(version.value) : recordRelease(tag, commit.value);
}

/**
 * Fails visibly when npm gave `latest` to the canary just published: npm sets `latest` on a package's
 * first upload whatever `--tag` says (npm/cli#8490) and cannot delete it. It stays until the first
 * stable release displaces it (`channelOrder`).
 */
function requireLatestNotOn(version: string): Result<void> {
  const holding: Array<string> = [];

  for (const { name } of PACKAGES) {
    const latest = distTag(name, "latest");

    if (latest._tag === "err") {
      return latest;
    }

    if (latest.value === version) {
      holding.push(name);
    }
  }

  if (holding.length === 0) {
    return ok(undefined);
  }

  return err(
    new ReleaseRefused(
      "canary-took-latest",
      `npm set latest to ${version} for ${holding.join(" and ")}, because it was the package's first upload; npm cannot delete latest, so plain installs get this canary until the first stable release moves latest (CONTRIBUTING.md#repository-setup). Both packages are published and tagged canary; no rerun is needed`
    )
  );
}

/** The Merge runs on `main` that have not completed, as URLs; a run among them can still publish. */
function activeReleaseRuns(): Result<ReadonlyArray<string>> {
  const urls: Array<string> = [];

  // --status takes one value. --all includes a disabled workflow, which the recovery disables first;
  // without it, gh does not resolve the workflow and its in-flight runs go unseen.
  for (const status of ACTIVE_RUN_STATUSES) {
    const listed = capture("gh", [
      "run",
      "list",
      "--repo",
      REPOSITORY,
      "--all",
      "--workflow",
      RELEASE_WORKFLOW,
      "--branch",
      "main",
      "--status",
      status,
      "--json",
      "url",
      "--jq",
      ".[].url",
    ]);

    if (listed._tag === "err") {
      return listed;
    }

    urls.push(...listed.value.split("\n").filter((line) => line !== ""));
  }

  return ok(urls);
}

/**
 * Repairs a split channel. `npm dist-tag add` writes unconditionally, so it refuses while a Merge run on
 * `main` could still promote; both packages must have `version` on npm before either tag moves, and
 * `promote` reads both tags right before writing.
 */
function promoteExisting(version: string, tag: ChannelTag): Result<void> {
  const runs = activeReleaseRuns();

  if (runs._tag === "err") {
    return runs;
  }

  if (runs.value.length > 0) {
    return err(
      new ReleaseRefused(
        "release-running",
        `a ${RELEASE_WORKFLOW} run on main has not completed (${runs.value.join(", ")}) and could move the tags meanwhile; disable the workflow (gh workflow disable ${RELEASE_WORKFLOW} --repo ${REPOSITORY}), wait for those runs, then rerun promote`
      )
    );
  }

  const missing = missingOnNpm(version);

  if (missing._tag === "err") {
    return missing;
  }

  if (missing.value.length > 0) {
    return err(new ReleaseRefused("not-on-npm", `${missing.value.join(" and ")} has no ${version} on npm`));
  }

  return promote(version, tag, "forward-only");
}

/** Writes the channel or plan to the workflow's GITHUB_OUTPUT file, when one is passed. */
function writeOutput(file: string | undefined, line: string): void {
  if (file !== undefined) {
    appendFileSync(file, `${line}\n`);
  }
}

function main(args: ReadonlyArray<string>): Result<void> | "usage" {
  const [command, first, second] = args;

  if (command === "prepare") {
    const channel = prepare();

    if (channel._tag === "err") {
      return channel;
    }

    writeOutput(first, `channel=${channel.value}`);

    return ok(undefined);
  }

  if (command === "plan") {
    const bump = plansBump();

    if (bump._tag === "err") {
      return bump;
    }

    process.stdout.write(`pending bump: ${String(bump.value)}\n`);
    writeOutput(first, `bump=${String(bump.value)}`);

    return ok(undefined);
  }

  if (command === "promote") {
    const tag = second === "canary" || second === "latest" ? second : undefined;

    return first === undefined || parseVersion(first) === undefined || tag === undefined
      ? "usage"
      : promoteExisting(first, tag);
  }

  const channel = command === "publish" && (first === "canary" || first === "stable") ? first : undefined;

  return channel === undefined ? "usage" : publish(channel);
}

const outcome = main(process.argv.slice(2));

if (outcome === "usage") {
  process.stderr.write(
    "Usage: node scripts/release.ts prepare [output-file] | plan [output-file] | publish <canary|stable> | promote <version> <canary|latest>\n"
  );
  process.exitCode = 2;
} else if (outcome._tag === "err") {
  // The ::error:: workflow command turns the reason into an annotation on the Actions run; in a
  // maintainer's terminal it is a harmless prefix.
  process.stdout.write(`::error::release: ${outcome.error._tag}: ${outcome.error.message}\n`);
  process.exitCode = 1;
}
