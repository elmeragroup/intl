---
"@elmeragroup/intl": patch
---

`<T>` no longer throws where it can render what the developer wrote. It reports once (to `onError`, or the default
`console.error`) and renders its children untranslated in each of these cases (#99):

- A `<Val>`, `<Plural>` or `<Select>` the extractor rejects: zero or two value props, a `<Plural>` form or `<Select>`
  branch that is not a string, a `<Select>` branch name that is no select key (`_a-b`, `_other`), or a `<Select>`
  without `other`. The report carries the message the throw had.
- A value that is neither text nor a number from an untyped caller (`any`, a cast), such as an object, a `Date`, a
  boolean, or a `null` `<Plural>` count or `<Select>` value. It is reported as `<Val v> needs a string or number value`
  (or `<Plural n>`, `<Select k>`) under the message's key.
- A message that fails to format, such as a number in a plain `{n}` (`PlainArgumentNotText`). `t` and `t.from` still
  report and then throw the formatter's own error, since their only fallback would be the ICU source.

A `<Val>` whose value is a present `null` or `undefined` now formats as `t()` formats the same value: a plain `{v}`
renders nothing, and a translation that reads it as a select gets the same branch. It threw a `TypeError` before. A
child that is neither text nor an element (a promise, an object) still throws, since `<T>` cannot put it in a message.
An `onError` that throws still propagates out of `<T>`.

`Val`, `Plural` and `Select` outside a `<T>` (which is what the fallback renders) now render only text the developer
wrote, or nothing. This changes what an app sees if it renders them outside a `<T>`:

- `Val`: `null`, `undefined`, an object, a `Date` and `true` rendered "null", "undefined", "[object Object]", the date
  in the host's time zone, and "true". They now render nothing. A string or a number renders as before. `children` no
  longer renders: `<Val v="a">b</Val>` rendered "ab" and now renders "a".
- `Select`: `_other="A"` with the value `other`, or `_a-b="A"` with the value `a-b`, rendered "A" and now renders
  `other`.
- `Select`: a matched branch that is not a string, such as `_a={1}` or `_a={<b>A</b>}`, rendered "1" or the element,
  and now renders `other`. An object branch or an object `other` crashed React, and now renders `other`, or nothing
  when `other` is not a string.
- `Plural`: a form that is not a string counts as unwritten, so `n={1} one={1} other="# xs"` rendered nothing and now
  renders "1 xs".
