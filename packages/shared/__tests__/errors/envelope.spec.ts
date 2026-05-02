import {
  ErrorCodes,
  errorEnvelope,
  isErrorEnvelope,
} from "../../src/errors/envelope";

describe("errorEnvelope", () => {
  it("returns { error: { code, message, request_id } } with exactly those keys", () => {
    const env = errorEnvelope({
      code: ErrorCodes.NOT_FOUND,
      message: "thing not found",
      requestId: "req-123",
    });

    expect(env).toEqual({
      error: {
        code: "not_found",
        message: "thing not found",
        request_id: "req-123",
      },
    });
    expect(Object.keys(env)).toEqual(["error"]);
    expect(Object.keys(env.error).sort()).toEqual([
      "code",
      "message",
      "request_id",
    ]);
  });

  it("includes details when provided", () => {
    const env = errorEnvelope({
      code: ErrorCodes.VALIDATION,
      message: "bad input",
      requestId: "req-xyz",
      details: { field: "email" },
    });
    expect(env.error).toMatchObject({
      code: "validation_error",
      message: "bad input",
      request_id: "req-xyz",
      details: { field: "email" },
    });
  });

  it("omits details when not provided", () => {
    const env = errorEnvelope({
      code: ErrorCodes.INTERNAL,
      message: "boom",
      requestId: "r",
    });
    expect("details" in env.error).toBe(false);
  });

  it("is JSON round-trip stable", () => {
    const env = errorEnvelope({
      code: ErrorCodes.UNAUTHORIZED,
      message: "nope",
      requestId: "r",
    });
    expect(JSON.parse(JSON.stringify(env))).toEqual(env);
  });
});

describe("isErrorEnvelope", () => {
  it("recognizes a valid envelope", () => {
    const env = errorEnvelope({
      code: ErrorCodes.FORBIDDEN,
      message: "no",
      requestId: "r",
    });
    expect(isErrorEnvelope(env)).toBe(true);
  });

  it("rejects null / undefined / non-object", () => {
    expect(isErrorEnvelope(null)).toBe(false);
    expect(isErrorEnvelope(undefined)).toBe(false);
    expect(isErrorEnvelope("oops")).toBe(false);
    expect(isErrorEnvelope(42)).toBe(false);
  });

  it("rejects an object missing required fields", () => {
    expect(isErrorEnvelope({ error: { code: "x" } })).toBe(false);
    expect(
      isErrorEnvelope({ error: { code: "x", message: "y" } }),
    ).toBe(false);
    expect(
      isErrorEnvelope({
        error: { code: "x", message: "y", request_id: 7 },
      }),
    ).toBe(false);
  });
});

describe("ErrorCodes", () => {
  it("uses snake_case stable strings", () => {
    expect(ErrorCodes.NOT_FOUND).toBe("not_found");
    expect(ErrorCodes.UNAUTHORIZED).toBe("unauthorized");
    expect(ErrorCodes.FORBIDDEN).toBe("forbidden");
    expect(ErrorCodes.VALIDATION).toBe("validation_error");
    expect(ErrorCodes.CONFLICT).toBe("conflict");
    expect(ErrorCodes.RATE_LIMITED).toBe("rate_limited");
    expect(ErrorCodes.INTERNAL).toBe("internal_error");
  });
});
