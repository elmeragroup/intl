import { createFileRoute } from "@tanstack/react-router";

import { T } from "@elmeragroup/intl/react";

// Uses 3 of the 500 bulk messages, which fill the catalog to a realistic size.
export const Route = createFileRoute("/three")({ component: Three });

function Three() {
  return (
    <ul id="three">
      <li>
        <T>Bulk message 001</T>
      </li>
      <li>
        <T>Bulk message 002</T>
      </li>
      <li>
        <T>Bulk message 003</T>
      </li>
    </ul>
  );
}
