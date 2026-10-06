/** Strict input validation at JSON/IPC boundaries; no coercion or inherited properties. */
export function record(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Expected plain object");
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result))
    if (
      !allowed.includes(key) ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      throw new Error(`Unexpected field: ${key}`);
  return result;
}
export function text(value: unknown, max = 10000, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim())
  )
    throw new Error("Invalid text");
  return value;
}
export function id(value: unknown): string {
  const s = text(value, 200);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("Invalid identifier");
  return s;
}
export function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error("Invalid integer");
  return value;
}
export function finite(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("Invalid number");
  return value;
}
export function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid boolean");
  return value;
}
export function list<T>(
  value: unknown,
  parse: (item: unknown) => T,
  max = 10000,
): T[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("Invalid or oversized list");
  return value.map(parse);
}
export function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error("Invalid choice");
  return value as T;
}
export function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length)
    throw new Error("Duplicate identifiers");
}
export function interval(start: unknown, end: unknown, duration: number): void {
  integer(start);
  integer(end);
  if ((start as number) >= (end as number) || (end as number) > duration)
    throw new Error("Invalid source interval");
}
