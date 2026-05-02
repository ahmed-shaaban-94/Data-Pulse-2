/**
 * UUIDv7 generator behind a thin adapter, with an explicit UUIDv4 fallback
 * path. Per plan §1.1 ("UUIDv7 default with v4 fallback") and research T-5.
 *
 * Public IDs are exposed as plain strings; column types stay `uuid` either
 * way. Swapping the underlying library or moving from v7 to v4 is a one-file
 * change here.
 */
import { v4, v7 } from "uuid";

export type UuidVariant = "v7" | "v4";

export interface IdGenerator {
  next(): string;
}

/** UUIDv7. Time-ordered (unix-ms in the high 48 bits) for B-tree locality. */
export function newIdV7(): string {
  return v7();
}

/** UUIDv4. Use only as a documented fallback if v7 is found unstable. */
export function newIdV4(): string {
  return v4();
}

/** Default generator: UUIDv7. */
export function newId(): string {
  return newIdV7();
}

export interface CreateIdGeneratorOptions {
  variant?: UuidVariant;
}

export function createIdGenerator(
  opts: CreateIdGeneratorOptions = {},
): IdGenerator {
  const variant = opts.variant ?? "v7";
  return {
    next: variant === "v7" ? newIdV7 : newIdV4,
  };
}
