// Turbopack's roots as withIntl hands them to the PO loader, and whether Turbopack loads a file there. A leaf on
// `node:*` alone: the loader imports it, and must not load next.ts. Every rule here can only turn a
// refusal into an accept: a missed refusal leaves Turbopack's own `outside configured roots` error, while a false one
// breaks a build that works, so the model is coarser than Turbopack's and errs towards accepting.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

/** Turbopack's root and the setting that decides it. */
export type TurbopackRoot = {
  /** The root, absolute. */
  readonly root: string;
  /** `outputFileTracingRoot` when set (Next uses it over `turbopack.root`), else `turbopack.root`. */
  readonly setting: "outputFileTracingRoot" | "turbopack.root";
};

/** Turbopack's roots as next.config is evaluated with them: JSON, in the PO loader's options. */
export type TurbopackRoots = TurbopackRoot & {
  /** `experimental.turbopackAdditionalRoots`, each resolved through its links where it exists. */
  readonly additional: ReadonlyArray<string>;
};

/**
 * Whether Turbopack loads a file the PO loader registers, as Turbopack at v16.4.6 checks it (replayed for #53): the
 * path lies in a root as written, or a directory above it resolves, through its links, into a root's real path. The
 * file itself is not resolved: Turbopack refuses a file linked into a root from outside it.
 *
 * @param roots - Turbopack's roots.
 * @param file - The absolute path the loader would register.
 * @returns Whether Turbopack loads it.
 */
export function isInRoots(roots: TurbopackRoots, file: string): boolean {
  const written = [roots.root, ...roots.additional];

  // Lexically inside: no system call, the common case of every catalog import.
  if (written.some((root) => isBelow(root, file))) {
    return true;
  }

  const real = written.map((root) => canonical(root) ?? root);

  for (let directory = dirname(file); ;) {
    const resolved = canonical(directory);

    if (resolved !== undefined && real.some((root) => isBelow(root, resolved))) {
      return true;
    }

    const parent = dirname(directory);

    if (parent === directory) {
      return false;
    }

    directory = parent;
  }
}

/**
 * Whether a path lies in a directory, or is it, lexically.
 *
 * @param directory - The directory.
 * @param path - The path.
 * @returns Whether the path is the directory or below it.
 */
export function isBelow(directory: string, path: string): boolean {
  const below = relative(directory, path);

  return below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below);
}

/**
 * The real path of an existing file or directory.
 *
 * @param path - The path, relative paths from the working directory.
 * @returns The real path, or none when it does not resolve (missing, or unreadable).
 */
export function canonical(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}
