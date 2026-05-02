import { createHash, randomBytes } from "node:crypto";
import {
  generateRawToken,
  hashToken,
  RAW_TOKEN_BYTES,
  TOKEN_HASH_BYTES,
  tokenHashesEqual,
} from "../src/tokens";

describe("constants", () => {
  it("RAW_TOKEN_BYTES is 32", () => {
    expect(RAW_TOKEN_BYTES).toBe(32);
  });

  it("TOKEN_HASH_BYTES is 32 (SHA-256 output)", () => {
    expect(TOKEN_HASH_BYTES).toBe(32);
  });
});

describe("hashToken", () => {
  it("returns a 32-byte Buffer", () => {
    const out = hashToken("any-string");
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out).toHaveLength(32);
  });

  it("matches the canonical SHA-256 of the input", () => {
    const input = "hello world";
    const expected = createHash("sha256").update(input, "utf8").digest();
    expect(hashToken(input).equals(expected)).toBe(true);
  });

  it("is deterministic for a given input", () => {
    expect(hashToken("abc").equals(hashToken("abc"))).toBe(true);
  });

  it("differs for different inputs", () => {
    expect(hashToken("abc").equals(hashToken("abd"))).toBe(false);
  });

  it("accepts a Buffer input as well as a string", () => {
    const buf = Buffer.from("hello world", "utf8");
    expect(hashToken(buf).equals(hashToken("hello world"))).toBe(true);
  });
});

describe("tokenHashesEqual (constant-time)", () => {
  it("returns true for equal buffers", () => {
    const a = randomBytes(32);
    const b = Buffer.from(a);
    expect(tokenHashesEqual(a, b)).toBe(true);
  });

  it("returns false for unequal same-length buffers", () => {
    const a = randomBytes(32);
    const b = Buffer.from(a);
    b[0] = b[0]! ^ 0x01;
    expect(tokenHashesEqual(a, b)).toBe(false);
  });

  it("returns false (not throws) for length mismatch", () => {
    expect(tokenHashesEqual(randomBytes(32), randomBytes(31))).toBe(false);
  });

  it("returns false for a zero-length buffer", () => {
    expect(tokenHashesEqual(Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
  });
});

describe("generateRawToken", () => {
  it("produces a base64url string", () => {
    const t = generateRawToken();
    expect(typeof t).toBe("string");
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does NOT contain padding characters", () => {
    const t = generateRawToken();
    expect(t.includes("=")).toBe(false);
  });

  it("produces unique values across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateRawToken());
    expect(seen.size).toBe(50);
  });

  it("encodes 32 random bytes (43 base64url chars)", () => {
    expect(generateRawToken()).toHaveLength(43);
  });
});
