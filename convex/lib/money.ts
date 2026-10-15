/** Round to 2 decimals (currency). */
export function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round to 4 decimals (unit costs). */
export function r4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

export const DAY = 24 * 60 * 60 * 1000;

export function sum<T>(items: T[], f: (x: T) => number): number {
  return items.reduce((acc, x) => acc + f(x), 0);
}
