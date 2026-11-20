"use client";
import { fixtures } from "./corpus";

// Each corpus entry in its own item, indexed, so the spec compares it with its expectation.
export function CorpusList() {
  return (
    <ul id="corpus">
      {fixtures.map((fixture, index) => (
        <li key={fixture.key} data-corpus={index}>
          {fixture.el}
        </li>
      ))}
    </ul>
  );
}
