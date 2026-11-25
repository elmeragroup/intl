// The fixture generators' randomness: a small seeded generator, so each load, each render and each test sees the same
// rows, and the helpers that draw from it.

/** A source of numbers in [0, 1), the same sequence for the same seed. */
export type Random = () => number;

/**
 * A seeded generator (mulberry32): the same seed gives the same sequence everywhere.
 *
 * @param seed - Any 32-bit integer.
 * @returns The generator.
 */
export function seeded(seed: number): Random {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Round to a number of fraction digits.
 *
 * @param value - The number.
 * @param digits - How many fraction digits to keep.
 * @returns The rounded number.
 */
export function round(value: number, digits: number): number {
  const scale = 10 ** digits;

  return Math.round(value * scale) / scale;
}

/**
 * One of the items, drawn from the generator.
 *
 * @template T - The items' type.
 * @param random - The generator.
 * @param items - The items to pick from.
 * @returns The item drawn.
 */
export function pick<T>(random: Random, items: readonly [T, ...Array<T>]): T {
  return items[Math.floor(random() * items.length)] ?? items[0];
}
