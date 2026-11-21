# po-parser conformance suite

`PoText` (`src/po-text.ts`), the tools' PO codec, replaced the `po-parser` 2.2.0 dependency. Its behaviour is held to
three oracles:

- `po-parser.test.ts`: po-parser's own test suite (`src/POParser.test.ts` at 2.2.0), ported with its expected output
  verbatim and run against `PoText` through `po-parser-shape.ts`. Its inline snapshots are exact strings here, so a
  snapshot update cannot rewrite them.
- `recorded.test.ts`: `po-parser-2.2.0.json`, recorded with po-parser 2.2.0 and GNU msgcat 1.0 over 85 PO texts: the repo's
  catalogs, every input of po-parser's suite, the GNU msgcat cases `test/cli.test.ts` holds, and edge cases (every
  escape, unknown escapes, multi-line strings, msgctxt, flags, references with and without lines, header fields,
  plural keywords, CRLF, empty msgstr, unicode, no trailing newline, a lone quote, reference lines `parseInt` reads). Each input records po-parser's `parse` (or its
  error) and `serialize`; `dialect`, po-parser on the text `parsePo` rewrote it to (`toParserDialect`, the function the
  codec replaces); `current`, what `parsePo` returned; and `msgcat`, GNU msgcat 1.0's exit status and output. It also
  records po-parser's `serialize` of 6 catalogs and `formatPo`'s output for 2 entry sets.
- `../po-text.test.ts`: a round-trip property over documents `Arbitrary.schema` generates: written and read back, each
  comes back unchanged (500 runs).

The ported cases and the recorded outputs are po-parser's, used under its MIT license: see
[LICENSE-po-parser](LICENSE-po-parser).

## The mapping

`po-parser-shape.ts` exposes `POParser.parse` and `POParser.serialize` over `PoText`:

| po-parser                                                      | `PoDocument`                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| `meta` (absent when the file has none)                         | `header` (absent when the file has none)                     |
| `messages` (absent when empty)                                 | `messages` (empty)                                           |
| `msgctxt` / `msgid` / `msgstr`                                 | `context` / `id` / `translation`                             |
| `references`, `extractedComments`, `flags` (absent when empty) | the same names (empty)                                       |
| a `#,` line with no flags: `flags: []`                         | no flags                                                     |
| a thrown `Error` with po-parser's message                      | a decode failure whose message contains it, after `line N: ` |

## Ledger

Every case of po-parser's suite is counted once: ported (asserts po-parser's output and passes), deliberate difference
(asserts ours and names po-parser's), or excluded.

| Source (`src/`)    | Ported file         | Cases | Ported | Deliberate difference | Excluded |
| ------------------ | ------------------- | ----: | -----: | --------------------: | -------: |
| `POParser.test.ts` | `po-parser.test.ts` |    48 |     46 |                     2 |        0 |

The recording holds 85 inputs. 73 read exactly as po-parser reads them and write back as it writes them; 12 read
differently, the 2 below and the 10 inputs that exist to show GNU msgcat's reading (all named in `recorded.test.ts`'s
`DELIBERATE`). All 85 read exactly as `parsePo` read them before (`dialect`, `current`).

## Deliberate differences

`parsePo` never handed po-parser a file as written: `toParserDialect` rewrote it to GNU msgcat's reading first, and the
tools rely on that reading (`test/cli.test.ts`, "keeps each entry's flags to itself" and "keeps every flag"). An entry
starts at `msgctxt`, or at a `msgid` not after one, blank line or not; a comment belongs to the entry it precedes, across
blank lines; every `#,` line of an entry is read; an obsolete (`#~`) entry is dropped with the comments before it; and
comments after the last entry are dropped. The codec reads that way itself, so where po-parser reads otherwise, the
GNU reading wins.

| Case                                                         | po-parser                                       | Ours                                                                   | GNU msgcat 1.0                                                             |
| ------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| "parses metadata when msgstr appears before msgid"           | the header's two fields and the message `hello` | `line 3: Incomplete message entry: both msgid and msgstr are required` | exit 1: `<stdin>:2:7: syntax error`, `<stdin>:3: missing 'msgstr' section` |
| "parses entries with varying flexible msgid/msgstr ordering" | `greeting` = `Hello`, `farewell` = `Goodbye`    | `line 3: Incomplete message entry: both msgid and msgstr are required` | exit 1: the same two errors                                                |

`parsePo` failed on both inputs before the change too (recorded as `current`).
