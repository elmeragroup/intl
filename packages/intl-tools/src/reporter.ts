// Where the tools' user output goes. A service rather than effect's Console, which writes to the global console: each
// host routes the two streams its own way (the bin through its own stdout.write, which handles a reader closing the
// pipe; the Vite build collects both into its error; the Vitest setup drops stdout) by providing its own layer, and
// each text is written as given, newlines included.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The two output streams a host gives the tools, as plain writes. */
export type ReporterIo = {
  /** Writes the report: a summary line, or the JSON document. */
  readonly stdout: (text: string) => void;
  /** Writes problems, usage errors and failures. */
  readonly stderr: (text: string) => void;
};

/** The tools' user output: the report on stdout, problems and failures on stderr, each text written byte for byte. */
export class Reporter
  extends /* @__PURE__ */ Context.Service<
    Reporter,
    {
      /** Writes text, newlines included, to the report stream. */
      readonly stdout: (text: string) => Effect.Effect<void>;
      /** Writes text, newlines included, to the problem stream. */
      readonly stderr: (text: string) => Effect.Effect<void>;
    }
  >()("elmera-intl-tools/Reporter")
{
  /**
   * A reporter writing through the host's own functions.
   *
   * @param io - The host's stdout and stderr writes.
   * @returns A layer whose writes call `io` synchronously, in order.
   */
  static layer(io: ReporterIo): Layer.Layer<Reporter> {
    // Untraced: a report writes a line per problem, and a span per line would trace nothing the command's span lacks.
    return Layer.succeed(Reporter, {
      stdout: Effect.fnUntraced(function* (text: string) {
        yield* Effect.sync(() => {
          io.stdout(text);
        });
      }),
      stderr: Effect.fnUntraced(function* (text: string) {
        yield* Effect.sync(() => {
          io.stderr(text);
        });
      }),
    });
  }
}
