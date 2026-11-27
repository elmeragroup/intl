---
"@elmeragroup/intl": patch
---

A number, plural, selectordinal, date or time argument that an untyped caller (a cast or `any`) gives a value of
another kind now fails like a missing argument: `onError` gets an `ArgumentNotOfKind` naming the argument, what it got
and the kind it takes, then `t` throws it and `<T>` renders its children. Until now the formatter turned the value into
a number or date nobody gave, unreported: a `null` count rendered `0` and an `undefined` one `NaN`; a string that is
not a number or an object rendered `NaN`, a boolean `0` or `1`, an empty string `0`, a `Date` its milliseconds; a
`null` date rendered 1 January 1970, an `undefined` one the current date, a boolean, an empty or a numeric string a
time in 1970. A text date (`"abc"`), an object or a bigint in a date, which threw an unnamed `RangeError` or
`TypeError`, now throw `ArgumentNotOfKind`. A typed call renders as before, with one exception: `<Plural>` takes a
string count, and inside `<T>` one that is not a number (`<Plural n="abc">`), which rendered `NaN`, now fails the same
way. Unchanged: a `NaN` count or number (a number the caller gave) renders `NaN`, a numeric string count (`"3"`) and a
timestamp date render as given, a select still renders `other` for a value no case names, a missing argument still
throws `MissingValueError`, and a present `null` or `undefined` in a plain `{x}` still renders as nothing.
