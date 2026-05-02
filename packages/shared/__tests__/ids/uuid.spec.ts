import { validate as validateUuid, version as uuidVersion } from "uuid";
import {
  createIdGenerator,
  newId,
  newIdV4,
  newIdV7,
  type IdGenerator,
} from "../../src/ids/uuid";

describe("newIdV7", () => {
  it("returns a valid UUID v7", () => {
    const id = newIdV7();
    expect(validateUuid(id)).toBe(true);
    expect(uuidVersion(id)).toBe(7);
  });

  it("is monotonically non-decreasing within a millisecond burst", () => {
    // UUIDv7 embeds the unix-ms timestamp in the high 48 bits, so adjacent
    // ids generated in the same tick should sort lexicographically.
    const ids = Array.from({ length: 50 }, () => newIdV7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("produces unique values across 1000 calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newIdV7());
    expect(seen.size).toBe(1000);
  });
});

describe("newIdV4 (explicit fallback)", () => {
  it("returns a valid UUID v4", () => {
    const id = newIdV4();
    expect(validateUuid(id)).toBe(true);
    expect(uuidVersion(id)).toBe(4);
  });

  it("produces unique values", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newIdV4());
    expect(seen.size).toBe(1000);
  });
});

describe("newId (default = v7)", () => {
  it("delegates to newIdV7 by default", () => {
    const id = newId();
    expect(validateUuid(id)).toBe(true);
    expect(uuidVersion(id)).toBe(7);
  });
});

describe("createIdGenerator (adapter for swap / fallback)", () => {
  it("returns a v7 generator by default", () => {
    const gen = createIdGenerator();
    const id = gen.next();
    expect(uuidVersion(id)).toBe(7);
  });

  it("returns a v4 generator when explicitly configured (fallback path)", () => {
    const gen = createIdGenerator({ variant: "v4" });
    const id = gen.next();
    expect(uuidVersion(id)).toBe(4);
  });

  it("can be replaced with a deterministic mock for tests", () => {
    const mock: IdGenerator = {
      next: () => "00000000-0000-7000-8000-000000000000",
    };
    expect(mock.next()).toBe("00000000-0000-7000-8000-000000000000");
  });
});
