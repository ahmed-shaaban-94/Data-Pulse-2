import {
  ARGON2_PARAMS,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "../src/passwords";

describe("ARGON2_PARAMS (OWASP 2025)", () => {
  it("uses memoryCost = 19456 (19 MiB)", () => {
    expect(ARGON2_PARAMS.memoryCost).toBe(19456);
  });

  it("uses timeCost = 2", () => {
    expect(ARGON2_PARAMS.timeCost).toBe(2);
  });

  it("uses parallelism = 1", () => {
    expect(ARGON2_PARAMS.parallelism).toBe(1);
  });

  it("uses hashLength = 32", () => {
    expect(ARGON2_PARAMS.hashLength).toBe(32);
  });
});

describe("hashPassword", () => {
  it("returns a PHC string starting with $argon2id$", async () => {
    const phc = await hashPassword("correct horse battery staple");
    expect(phc.startsWith("$argon2id$")).toBe(true);
  });

  it("encodes the OWASP params (m=19456,t=2,p=1) in the PHC string", async () => {
    const phc = await hashPassword("hunter2");
    expect(phc).toMatch(/m=19456,t=2,p=1/);
  });

  it("produces a different hash for the same password each call (salt randomness)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("rejects empty string", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });
});

describe("verifyPassword", () => {
  it("returns true for the correct password", async () => {
    const phc = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(phc, "correct horse battery staple")).toBe(
      true,
    );
  });

  it("returns false for a wrong password", async () => {
    const phc = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(phc, "wrong password")).toBe(false);
  });

  it("returns false for an empty candidate without throwing", async () => {
    const phc = await hashPassword("real");
    expect(await verifyPassword(phc, "")).toBe(false);
  });

  it("returns false for a malformed PHC string without throwing", async () => {
    expect(await verifyPassword("not-a-phc-string", "anything")).toBe(false);
  });
});

describe("needsRehash", () => {
  it("returns false for a freshly hashed password (matches current params)", async () => {
    const phc = await hashPassword("ok");
    expect(needsRehash(phc)).toBe(false);
  });

  it("returns true for a hash produced with weaker memoryCost", () => {
    // Hand-crafted PHC string with memoryCost = 4096 (well below the 19456 floor).
    const weak = "$argon2id$v=19$m=4096,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU";
    expect(needsRehash(weak)).toBe(true);
  });

  it("returns true for a hash produced with weaker timeCost", () => {
    const weak = "$argon2id$v=19$m=19456,t=1,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU";
    expect(needsRehash(weak)).toBe(true);
  });

  it("returns true for a malformed PHC string (forces a rehash)", () => {
    expect(needsRehash("garbage")).toBe(true);
  });
});
