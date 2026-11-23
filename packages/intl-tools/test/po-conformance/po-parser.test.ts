// po-parser 2.2.0's test suite (src/POParser.test.ts, MIT, Copyright Jan Amann: LICENSE-po-parser), ported verbatim
// onto `PoText` through po-parser-shape.ts. Unit under test: the PoText codec. Oracle: po-parser's expected output as its
// author wrote it; its inline snapshots are the exact strings here. README.md's ledger counts every case.
import { describe, expect, it } from "vitest";

import POParser from "./po-parser-shape.ts";

describe("parse", () => {
  it("parses a basic message", () => {
    expect(
      POParser.parse(`
msgid "+YJVTi"
msgstr "Hey"
`)
    ).toEqual({
      messages: [
        {
          msgid: "+YJVTi",
          msgstr: "Hey",
        },
      ],
    });
  });

  it("parses an empty message", () => {
    expect(
      POParser.parse(`
msgid "lNLCAE"
msgstr ""
`)
    ).toEqual({
      messages: [
        {
          msgid: "lNLCAE",
          msgstr: "",
        },
      ],
    });
  });

  it("handles irregular whitespace", () => {
    expect(
      POParser.parse(`
  msgid "+YJVTi"
msgstr    "Hey"  
`)
    ).toEqual({
      messages: [
        {
          msgid: "+YJVTi",
          msgstr: "Hey",
        },
      ],
    });
  });

  it("parses a message with a namespace", () => {
    expect(
      POParser.parse(`
msgctxt "ui.greeting"
msgid "+YJVTi"
msgstr "Hey"
`)
    ).toEqual({
      messages: [
        {
          msgctxt: "ui.greeting",
          msgid: "+YJVTi",
          msgstr: "Hey",
        },
      ],
    });
  });

  it("parses multiple messages with arbitrary whitespace", () => {
    expect(
      POParser.parse(`
msgid "+YJVTi"
msgstr "Hey"

msgid "fDJkF2"
msgstr "Hello"


msgid "aZdGjT"
msgstr "World"
`)
    ).toEqual({
      messages: [
        {
          msgid: "+YJVTi",
          msgstr: "Hey",
        },
        {
          msgid: "fDJkF2",
          msgstr: "Hello",
        },
        {
          msgid: "aZdGjT",
          msgstr: "World",
        },
      ],
    });
  });

  it("parses a file path", () => {
    expect(
      POParser.parse(`
#: src/components/Greeting.tsx
msgid "+YJVTi"
msgstr "Hey"
`)
    ).toEqual({
      messages: [
        {
          msgid: "+YJVTi",
          msgstr: "Hey",
          references: [
            {
              path: "src/components/Greeting.tsx",
            },
          ],
        },
      ],
    });
  });

  it("parses a file path and line number", () => {
    expect(
      POParser.parse(`
#: src/components/Greeting.tsx:120
msgid "+YJVTi"
msgstr "Hey"
`)
    ).toEqual({
      messages: [
        {
          msgid: "+YJVTi",
          msgstr: "Hey",
          references: [
            {
              path: "src/components/Greeting.tsx",
              line: 120,
            },
          ],
        },
      ],
    });
  });

  it("parses multiple file paths", () => {
    expect(
      POParser.parse(`
#: src/components/Greeting.tsx:120
#: src/components/Greeting.tsx:121
msgid "+YJVTi"
msgstr "Hey"
`)
    ).toEqual({
      messages: [
        {
          msgid: "+YJVTi",
          msgstr: "Hey",
          references: [
            {
              path: "src/components/Greeting.tsx",
              line: 120,
            },
            {
              path: "src/components/Greeting.tsx",
              line: 121,
            },
          ],
        },
      ],
    });
  });

  it("parses same file with different line numbers", () => {
    expect(
      POParser.parse(`
#: src/components/Greeting.tsx:14
#: src/components/Greeting.tsx:28
msgid "+YJVTi"
msgstr "Hey"
`)
    ).toEqual({
      messages: [
        {
          msgid: "+YJVTi",
          msgstr: "Hey",
          references: [
            {
              path: "src/components/Greeting.tsx",
              line: 14,
            },
            {
              path: "src/components/Greeting.tsx",
              line: 28,
            },
          ],
        },
      ],
    });
  });

  it("ignores column numbers in references", () => {
    expect(
      POParser.parse(`
#: src/components/Greeting.tsx:120:15
msgid "+YJVTi"
msgstr "Hey"
`)
    ).toEqual({
      messages: [
        {
          msgid: "+YJVTi",
          msgstr: "Hey",
          references: [
            {
              path: "src/components/Greeting.tsx",
              line: 120,
            },
          ],
        },
      ],
    });
  });

  it("parses a comment extracted from the source code", () => {
    expect(
      POParser.parse(`
#. Shown on home screen
msgid "+YJVTi"
msgstr "Hey"
`)
    ).toEqual({
      messages: [
        {
          msgid: "+YJVTi",
          msgstr: "Hey",
          extractedComments: ["Shown on home screen"],
        },
      ],
    });
  });

  it("parses multiple extracted comments", () => {
    expect(
      POParser.parse(`
#. First comment
#. Second comment
msgid "+YJVTi"
msgstr "Hey"
`)
    ).toEqual({
      messages: [
        {
          msgid: "+YJVTi",
          msgstr: "Hey",
          extractedComments: ["First comment", "Second comment"],
        },
      ],
    });
  });

  it("parses metadata", () => {
    // "The header contains meta-information about the content in the file.
    // It is marked with the first empty translation entry in the PO file."
    // Source: https://pofile.net
    expect(
      POParser.parse(`
msgid ""
msgstr ""
"POT-Creation-Date: 2025-10-27 16:00+0000\n"
"MIME-Version: 1.0\n"
"Content-Type: text/plain; charset=UTF-8\n"
"Content-Transfer-Encoding: 8bit\n"
"X-Generator: next-intl\n"
"Language: en-GB\n"
"Project-Id-Version: 123\n"
"Report-Msgid-Bugs-To: \n"
"PO-Revision-Date: 2025-10-23 16:19\n"
"Last-Translator: \n"
"Language-Team: English, United Kingdom\n"
"X-Crowdin-Project: 123\n"
"X-Crowdin-Project-ID: 1\n"
"X-Crowdin-Language: en-GB\n"
"X-Crowdin-File: /messages/en.po\n"
"X-Crowdin-File-ID: 11\n"
`)
    ).toEqual({
      meta: {
        "POT-Creation-Date": "2025-10-27 16:00+0000",
        "MIME-Version": "1.0",
        "Content-Type": "text/plain; charset=UTF-8",
        "Content-Transfer-Encoding": "8bit",
        "X-Generator": "next-intl",
        Language: "en-GB",
        "Project-Id-Version": "123",
        "Report-Msgid-Bugs-To": "",
        "PO-Revision-Date": "2025-10-23 16:19",
        "Last-Translator": "",
        "Language-Team": "English, United Kingdom",
        "X-Crowdin-Project": "123",
        "X-Crowdin-Project-ID": "1",
        "X-Crowdin-Language": "en-GB",
        "X-Crowdin-File": "/messages/en.po",
        "X-Crowdin-File-ID": "11",
      },
    });
  });

  it("parses entry with multiple infos (references, description, namespace)", () => {
    expect(
      POParser.parse(`
#: src/components/Button.tsx:15
#: src/components/Button.tsx:20
#. Button text for submit action
msgctxt "ui.button"
msgid "submit"
msgstr "Submit"
`)
    ).toEqual({
      messages: [
        {
          msgctxt: "ui.button",
          msgid: "submit",
          msgstr: "Submit",
          extractedComments: ["Button text for submit action"],
          references: [
            {
              path: "src/components/Button.tsx",
              line: 15,
            },
            {
              path: "src/components/Button.tsx",
              line: 20,
            },
          ],
        },
      ],
    });
  });

  it("parses numeric message IDs", () => {
    expect(
      POParser.parse(`
msgid "123"
msgstr "One hundred twenty three"
`)
    ).toEqual({
      messages: [
        {
          msgid: "123",
          msgstr: "One hundred twenty three",
        },
      ],
    });
  });

  it("parses metadata without trailing newlines", () => {
    expect(
      POParser.parse(`
msgid ""
msgstr ""
"POT-Creation-Date: 2025-10-27 16:00+0000"
"MIME-Version: 1.0"
`)
    ).toEqual({
      meta: {
        "POT-Creation-Date": "2025-10-27 16:00+0000",
        "MIME-Version": "1.0",
      },
    });
  });

  // Deliberate difference (README.md). po-parser reads the header as `meta: { 'POT-Creation-Date':
  // '2025-10-27 16:00+0000', 'MIME-Version': '1.0' }` and the message `hello`. A msgstr before its msgid is a syntax
  // error to GNU msgcat ("<stdin>:2:7: syntax error", "<stdin>:3: missing 'msgstr' section"), and a msgid not after a
  // msgctxt starts an entry, so the msgstr is an entry without a msgid, as `parsePo` read it before (recorded in
  // po-parser-2.2.0.json, `current`).
  it("parses metadata when msgstr appears before msgid", () => {
    expect(() =>
      POParser.parse(`
msgstr ""
msgid ""
"POT-Creation-Date: 2025-10-27 16:00+0000"
"MIME-Version: 1.0"

msgid "hello"
msgstr "Hello"
`)
    ).toThrow("line 3: Incomplete message entry: both msgid and msgstr are required");
  });

  it("parses nested namespaces correctly", () => {
    expect(
      POParser.parse(`
msgctxt "ui.button.submit"
msgid "text"
msgstr "Submit"
`)
    ).toEqual({
      messages: [
        {
          msgctxt: "ui.button.submit",
          msgid: "text",
          msgstr: "Submit",
        },
      ],
    });
  });

  // Deliberate difference (README.md). po-parser reads `[{ msgid: 'greeting', msgstr: 'Hello' }, { msgid: 'farewell',
  // msgstr: 'Goodbye' }]`. GNU msgcat rejects the msgstr before its msgid, as above, and so did `parsePo` before.
  it("parses entries with varying flexible msgid/msgstr ordering", () => {
    expect(() =>
      POParser.parse(`
msgstr "Hello"
msgid "greeting"

msgid "farewell"
msgstr "Goodbye"
`)
    ).toThrow("line 3: Incomplete message entry: both msgid and msgstr are required");
  });

  it("parses files with Windows newline format (\\r\\n)", () => {
    expect(
      POParser.parse('msgid "hello"\r\nmsgstr "Hello World"\r\n\r\nmsgid "goodbye"\r\nmsgstr "Goodbye"')
    ).toEqual({
      messages: [
        {
          msgid: "hello",
          msgstr: "Hello World",
        },
        {
          msgid: "goodbye",
          msgstr: "Goodbye",
        },
      ],
    });
  });

  it("parses metadata with Windows newline format (\\r\\n)", () => {
    expect(
      POParser.parse(
        'msgid ""\r\nmsgstr ""\r\n"POT-Creation-Date: 2025-10-27 16:00+0000\\n"\r\n"Language: en\\n"'
      )
    ).toEqual({
      meta: {
        "POT-Creation-Date": "2025-10-27 16:00+0000",
        Language: "en",
      },
    });
  });

  it("unescapes escaped characters inside entries", () => {
    expect(
      POParser.parse(`
msgid "hello"
msgstr "Line 1\\nLine \\"2\\" with \\\\ tab\\tcarriage\\rreturn plain letters n r t"
`)
    ).toEqual({
      messages: [
        {
          msgid: "hello",
          msgstr: 'Line 1\nLine "2" with \\ tab\tcarriage\rreturn plain letters n r t',
        },
      ],
    });
  });

  it("parses multi-line strings", () => {
    expect(
      POParser.parse(`
msgid ""
"Very long string.\\n"
"Even longer string"
msgstr ""
"translation\\n"
"translation_2"
`)
    ).toEqual({
      messages: [
        {
          msgid: "Very long string.\nEven longer string",
          msgstr: "translation\ntranslation_2",
        },
      ],
    });
  });

  it("parses multi-line strings that continue a non-empty first line", () => {
    expect(
      POParser.parse(`
msgid "greeting"
msgstr "Hello "
"World"
`)
    ).toEqual({
      messages: [
        {
          msgid: "greeting",
          msgstr: "Hello World",
        },
      ],
    });
  });

  it("parses a multi-line msgctxt", () => {
    expect(
      POParser.parse(`
msgctxt "ui."
"button"
msgid "save"
msgstr "Save"
`)
    ).toEqual({
      messages: [
        {
          msgctxt: "ui.button",
          msgid: "save",
          msgstr: "Save",
        },
      ],
    });
  });

  it("parses a multi-line entry followed by metadata-like content", () => {
    expect(
      POParser.parse(`
msgid ""
msgstr ""
"Language: en\\n"

msgid ""
"first"
msgstr ""
"translation"
`)
    ).toEqual({
      meta: {
        Language: "en",
      },
      messages: [
        {
          msgid: "first",
          msgstr: "translation",
        },
      ],
    });
  });

  describe("error handling", () => {
    it("throws for incomplete quoted strings", () => {
      expect(() =>
        POParser.parse(`
msgid "incomplete
msgstr "message"
`)
      ).toThrow('Incomplete quoted string:\n> "incomplete');
    });

    it("throws if the message is not quoted", () => {
      expect(() =>
        POParser.parse(`
msgid "+YJVTi"
msgstr 123
`)
      ).toThrow("Incomplete quoted string:\n> 123");
    });

    it("throws if the ID is not quoted", () => {
      expect(() =>
        POParser.parse(`
msgid 123
msgstr "Hey"
`)
      ).toThrow("Incomplete quoted string:\n> 123");
    });

    it("throws if no id is present", () => {
      expect(() =>
        POParser.parse(`
msgstr "Hey"
`)
      ).toThrow("Incomplete message entry: both msgid and msgstr are required");
    });

    it("throws if no message is present", () => {
      expect(() =>
        POParser.parse(`
msgid "+YJVTi"
`)
      ).toThrow("Incomplete message entry: both msgid and msgstr are required");
    });

    it("throws for usage of plurals", () => {
      expect(() =>
        POParser.parse(`
msgid "+YJVTi"
msgstr "You have one new message"
msgid_plural "You have %d new messages"
`)
      ).toThrow(
        'Plural forms (msgid_plural) are not supported, use ICU pluralization instead:\n> msgid_plural "You have %d new messages"'
      );
    });

    it("throws for translator comments", () => {
      expect(() =>
        POParser.parse(`
# Shown on home screen
msgid "+YJVTi"
msgstr "Hey"`)
      ).toThrow(
        "Translator comments (#) are not supported, use inline descriptions instead:\n> # Shown on home screen"
      );
    });

    it("parses flag comments", () => {
      expect(
        POParser.parse(`
#, fuzzy
msgid "+YJVTi"
msgstr "Hey"`)
      ).toEqual({
        messages: [
          {
            msgid: "+YJVTi",
            msgstr: "Hey",
            flags: ["fuzzy"],
          },
        ],
      });
    });

    it("parses multiple flags", () => {
      expect(
        POParser.parse(`
#, fuzzy, c-format
msgid "+YJVTi"
msgstr "Hey"`)
      ).toEqual({
        messages: [
          {
            msgid: "+YJVTi",
            msgstr: "Hey",
            flags: ["fuzzy", "c-format"],
          },
        ],
      });
    });

    it("throws for previous string key comments", () => {
      expect(() =>
        POParser.parse(`
#| msgid +YJVTi
msgid "+YJVTi"
msgstr "Hey"`)
      ).toThrow("Previous string key comments (#|) are not supported:\n> #| msgid +YJVTi");
    });

    it("throws for a quoted line without a preceding keyword", () => {
      expect(() =>
        POParser.parse(`
"orphaned line"
msgid "+YJVTi"
msgstr "Hey"
`)
      ).toThrow('Encountered unexpected quoted line:\n> "orphaned line"');
    });

    it("throws for a quoted line after a comment without a preceding keyword", () => {
      expect(() =>
        POParser.parse(`
#. Some comment
"orphaned line"
msgid "+YJVTi"
msgstr "Hey"
`)
      ).toThrow('Encountered unexpected quoted line:\n> "orphaned line"');
    });
  });
});

describe("serialize", () => {
  it("serializes simple messages", () => {
    expect(
      POParser.serialize({
        messages: [
          { msgid: "hello", msgstr: "Hello World" },
          { msgid: "goodbye", msgstr: "Goodbye" },
        ],
      })
    ).toBe('msgid "hello"\nmsgstr "Hello World"\n\nmsgid "goodbye"\nmsgstr "Goodbye"\n');
  });

  it("serializes messages with metadata", () => {
    expect(
      POParser.serialize({
        meta: {
          "Content-Type": "text/plain; charset=UTF-8",
          Language: "en",
        },
        messages: [{ msgid: "welcome", msgstr: "Welcome" }],
      })
    ).toBe(
      'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Language: en\\n"\n\nmsgid "welcome"\nmsgstr "Welcome"\n'
    );
  });

  it("serializes messages with context and references", () => {
    expect(
      POParser.serialize({
        messages: [
          {
            msgctxt: "ui.button",
            msgid: "save",
            msgstr: "Save",
            extractedComments: ["Save button tooltip"],
            references: [{ path: "src/components/Button.tsx" }, { path: "src/pages/Profile.tsx" }],
          },
        ],
      })
    ).toBe(
      '#. Save button tooltip\n#: src/components/Button.tsx\n#: src/pages/Profile.tsx\nmsgctxt "ui.button"\nmsgid "save"\nmsgstr "Save"\n'
    );
  });

  it("serializes messages with references including line numbers", () => {
    expect(
      POParser.serialize({
        messages: [
          {
            msgctxt: "ui.button",
            msgid: "save",
            msgstr: "Save",
            references: [
              { path: "src/components/Button.tsx", line: 15 },
              { path: "src/pages/Profile.tsx", line: 20 },
            ],
          },
        ],
      })
    ).toBe(
      '#: src/components/Button.tsx:15\n#: src/pages/Profile.tsx:20\nmsgctxt "ui.button"\nmsgid "save"\nmsgstr "Save"\n'
    );
  });

  it("serializes multiple extracted comments", () => {
    expect(
      POParser.serialize({
        messages: [
          {
            msgid: "hello",
            msgstr: "Hello",
            extractedComments: ["First comment", "Second comment"],
          },
        ],
      })
    ).toBe('#. First comment\n#. Second comment\nmsgid "hello"\nmsgstr "Hello"\n');
  });

  it("serializes nested namespaces correctly", () => {
    expect(
      POParser.serialize({
        messages: [
          { msgctxt: "ui.button.submit", msgid: "text", msgstr: "Submit" },
          { msgctxt: "simple", msgid: "message", msgstr: "Hello" },
        ],
      })
    ).toBe(
      'msgctxt "ui.button.submit"\nmsgid "text"\nmsgstr "Submit"\n\nmsgctxt "simple"\nmsgid "message"\nmsgstr "Hello"\n'
    );
  });

  it("serializes messages with flags", () => {
    expect(
      POParser.serialize({
        messages: [
          {
            msgid: "hello",
            msgstr: "Hello World",
            flags: ["fuzzy"],
          },
        ],
      })
    ).toBe('#, fuzzy\nmsgid "hello"\nmsgstr "Hello World"\n');
  });

  it("serializes messages with multiple flags", () => {
    expect(
      POParser.serialize({
        messages: [
          {
            msgid: "hello",
            msgstr: "Hello World",
            flags: ["fuzzy", "c-format"],
          },
        ],
      })
    ).toBe('#, fuzzy, c-format\nmsgid "hello"\nmsgstr "Hello World"\n');
  });

  it("serializes multi-line values as single-line strings", () => {
    const content = `
msgid ""
"Very long string.\\n"
"Even longer string"
msgstr ""
"translation\\n"
"translation_2"
`;
    expect(POParser.serialize(POParser.parse(content))).toBe(
      'msgid "Very long string.\\nEven longer string"\nmsgstr "translation\\ntranslation_2"\n'
    );
  });

  it("serializes strings containing special characters", () => {
    expect(
      POParser.serialize({
        messages: [
          {
            msgid: "hello",
            msgstr: 'Line 1\nLine "2" with \\ tab\tcarriage\rreturn',
          },
        ],
      })
    ).toBe('msgid "hello"\nmsgstr "Line 1\\nLine \\"2\\" with \\\\ tab\\tcarriage\\rreturn"\n');
  });
});
