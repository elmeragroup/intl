import { T, Val } from "@elmeragroup/intl/react";

// Imported by no route: its translation is in the catalog only, so finding it in data sent to the browser means the
// catalog was sent.
export function Unused() {
  return <T>Catalog only sentinel</T>;
}

// The same for the English catalog, which holds structured sources only (hence the argument): its source text reaches
// a document only through the en catalog, since translated catalogs are keyed by hash and hold the translation.
export function UnusedEnglish() {
  return (
    <T>
      English catalog sentinel ENVAKT-4X8 <Val name="x" />
    </T>
  );
}
