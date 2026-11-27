// The two ways the tools resolve a real path, one per question. A root that is printed, made relative or handed to a
// host is resolved the hosts' way (`realPathSync`): Next (lib/realpath.js:17-18, v16.4.6) and Vite
// (`safeRealpathSync`, dist/node/chunks/node.js:2454, v8.3.4) take the kernel's answer on POSIX,
// `fs.realpathSync.native`, and Node's JavaScript `fs.realpathSync` on Windows, where the native form turns a `subst`
// or mapped drive into its target and the hosts keep the drive. On POSIX the JavaScript form walks the links itself:
// it keeps the case a path was spelled in on a volume that folds case (`myapp` for `MyApp`), and it collapses a link
// target's `..` before resolving the link that `..` climbs out of (`mnt/web -> ../checkout/current/../web`, #118), so
// it would root one config elsewhere than the kernel and the hosts do. Whether two paths name one file is a question
// of identity, which takes the kernel's answer on every platform (`identityPathSync`), as the catalog import always
// has: on Windows the JavaScript form keeps the case and the drive a path was spelled with, so a catalog the config
// spells in another case than the disk, or a project on a `subst` drive under Vite (whose `safeRealpathSync` is native
// unless `net use` reports mapped drives), would match no file. On POSIX the two are one call, so nothing changes
// there and no test can tell them apart (Windows support: #122). A leaf on `node:fs` alone: next.config, the loaders
// and the Effect platform all import it.
import { realpath, realpathSync } from "node:fs";

const WINDOWS = process.platform === "win32";

/**
 * A path's real path, as the hosts resolve it.
 *
 * @param path - The path, relative paths from the working directory.
 * @returns The real path; throws Node's error when the path does not resolve (missing, unreadable, a link loop).
 */
export const realPathSync: (path: string) => string = WINDOWS ? realpathSync : realpathSync.native;

/**
 * A path's real path as the kernel resolves it, on every platform: the one to compare when asking whether two paths
 * name one file, never one to print or hand to a host (`realPathSync`).
 *
 * @param path - The path, relative paths from the working directory.
 * @returns The real path; throws Node's error when the path does not resolve (missing, unreadable, a link loop).
 */
export const identityPathSync: (path: string) => string = realpathSync.native;

/**
 * `realPathSync`, asynchronous: Node's callback form, so a lookup stalled on a mount holds no fiber.
 *
 * @param path - The path, relative paths from the working directory.
 * @param callback - Given Node's error, or the real path.
 */
export const realPathAsync: (
  path: string,
  callback: (error: NodeJS.ErrnoException | null, resolved: string) => void
) => void = WINDOWS ? realpath : realpath.native;
