import { z, ZodError } from "zod";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";

const NOOP_META = {
  type: "body" as const,
  metatype: undefined,
  data: undefined,
};

describe("ZodValidationPipe", () => {
  it("is a no-op when no schema is supplied", () => {
    const pipe = new ZodValidationPipe();
    expect(pipe.transform({ a: 1 }, NOOP_META)).toEqual({ a: 1 });
    expect(pipe.transform("hello", NOOP_META)).toBe("hello");
    expect(pipe.transform(undefined, NOOP_META)).toBeUndefined();
  });

  it("returns parsed value when schema validation succeeds", () => {
    const schema = z.object({ x: z.number().int() });
    const pipe = new ZodValidationPipe(schema);
    expect(pipe.transform({ x: 7 }, NOOP_META)).toEqual({ x: 7 });
  });

  it("applies schema transforms (e.g., string trim and lowercase)", () => {
    const schema = z.object({
      email: z.string().trim().toLowerCase().email(),
    });
    const pipe = new ZodValidationPipe(schema);
    expect(
      pipe.transform({ email: "  Alice@Example.COM  " }, NOOP_META),
    ).toEqual({
      email: "alice@example.com",
    });
  });

  it("throws ZodError on validation failure (preserved for the exception filter)", () => {
    const schema = z.object({ x: z.number() });
    const pipe = new ZodValidationPipe(schema);
    let caught: unknown;
    try {
      pipe.transform({ x: "not a number" }, NOOP_META);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ZodError);
    expect((caught as ZodError).issues.length).toBeGreaterThan(0);
  });

  it("infers the parsed type from the schema (compile-time check)", () => {
    const schema = z.object({ id: z.string().uuid(), n: z.number() });
    const pipe = new ZodValidationPipe(schema);
    const out = pipe.transform(
      { id: "9f1a2b3c-4d5e-4f6a-8b7c-0d1e2f3a4b5c", n: 1 },
      NOOP_META,
    );
    // out should be typed as { id: string; n: number }
    const _expected: { id: string; n: number } = out;
    expect(_expected.id).toBeDefined();
  });
});
