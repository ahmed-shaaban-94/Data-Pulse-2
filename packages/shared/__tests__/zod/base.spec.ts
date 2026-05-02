import { Email, Slug, Uuid } from "../../src/zod/base";

describe("Uuid", () => {
  it("accepts a UUIDv4", () => {
    const v4 = "9f1a2b3c-4d5e-4f6a-8b7c-0d1e2f3a4b5c";
    expect(Uuid.parse(v4)).toBe(v4);
  });

  it("accepts a UUIDv7", () => {
    const v7 = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";
    expect(Uuid.parse(v7)).toBe(v7);
  });

  it("rejects a non-UUID string", () => {
    expect(Uuid.safeParse("not-a-uuid").success).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(Uuid.safeParse("").success).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(Uuid.safeParse(123 as unknown).success).toBe(false);
  });
});

describe("Email", () => {
  it("accepts a normal email", () => {
    expect(Email.parse("alice@example.com")).toBe("alice@example.com");
  });

  it("lower-cases input (citext parity)", () => {
    expect(Email.parse("Alice@Example.COM")).toBe("alice@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(Email.parse("  bob@example.com  ")).toBe("bob@example.com");
  });

  it("rejects an invalid email", () => {
    expect(Email.safeParse("not-an-email").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(Email.safeParse("").success).toBe(false);
  });

  it("enforces a sane max length", () => {
    const local = "a".repeat(255);
    expect(Email.safeParse(`${local}@example.com`).success).toBe(false);
  });
});

describe("Slug", () => {
  it.each(["a", "abc", "abc-def", "store-001", "tenant-1-eu"])(
    "accepts %s",
    (slug) => {
      expect(Slug.parse(slug)).toBe(slug);
    },
  );

  it.each([
    "Abc", // uppercase
    "-abc", // leading hyphen
    "abc-", // trailing hyphen
    "ab--c", // consecutive hyphens
    "a b", // space
    "abc_def", // underscore
    "", // empty
  ])("rejects %s", (slug) => {
    expect(Slug.safeParse(slug).success).toBe(false);
  });

  it("enforces a max length (<= 63)", () => {
    expect(Slug.safeParse("a".repeat(63)).success).toBe(true);
    expect(Slug.safeParse("a".repeat(64)).success).toBe(false);
  });
});
