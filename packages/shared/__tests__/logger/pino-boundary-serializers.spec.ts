/**
 * BOUNDARY_SERIALIZERS coverage — pino.ts lines 205-243.
 *
 * The three serializers (req, res, err) are module-private but exercised
 * whenever the logger receives a binding with a `req`, `res`, or `err` key.
 * Tests capture the rendered JSON to assert the safe-envelope output.
 */
import { Writable } from "node:stream";
import { createLogger } from "../../src/logger/pino";

function makeCapture(): {
  dest: { write(msg: string): void };
  lastLine: () => Record<string, unknown>;
} {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return {
    dest,
    lastLine: () => {
      const raw = chunks.join("").trim().split("\n").pop() ?? "{}";
      return JSON.parse(raw) as Record<string, unknown>;
    },
  };
}

// ---------------------------------------------------------------------------
// req serializer (lines 204-222)
// ---------------------------------------------------------------------------

describe("BOUNDARY_SERIALIZERS.req — safe envelope", () => {
  it("emits method, route (from url), and headers_count", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.info(
      { req: { method: "GET", url: "/v1/context/me", headers: { "x-request-id": "abc" } } },
      "test",
    );
    const req = lastLine()["req"] as Record<string, unknown>;
    expect(req["method"]).toBe("GET");
    expect(req["route"]).toBe("/v1/context/me");
    expect(req["headers_count"]).toBe(1);
    expect(req["headers"]).toBeUndefined();
    expect(req["body"]).toBeUndefined();
  });

  it("prefers req.route over req.url when both present", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.info(
      { req: { method: "GET", route: "/v1/tenants/:id/members", url: "/v1/tenants/123/members" } },
      "test",
    );
    const req = lastLine()["req"] as Record<string, unknown>;
    expect(req["route"]).toBe("/v1/tenants/:id/members");
  });

  it("prefers originalUrl over url when route absent", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.info({ req: { method: "POST", originalUrl: "/v1/auth/signin" } }, "test");
    const req = lastLine()["req"] as Record<string, unknown>;
    expect(req["route"]).toBe("/v1/auth/signin");
  });

  it("headers_count is 0 when headers is absent", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.info({ req: { method: "DELETE" } }, "test");
    const req = lastLine()["req"] as Record<string, unknown>;
    expect(req["headers_count"]).toBe(0);
  });

  it("returns non-object req values unchanged (null passthrough)", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.info({ req: null }, "null req");
    expect(lastLine()["req"]).toBeNull();
  });

  it("returns non-object req values unchanged (string passthrough)", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.info({ req: "not-an-object" }, "string req");
    expect(lastLine()["req"]).toBe("not-an-object");
  });
});

// ---------------------------------------------------------------------------
// res serializer (lines 223-230)
// ---------------------------------------------------------------------------

describe("BOUNDARY_SERIALIZERS.res — safe envelope", () => {
  it("emits status from statusCode", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.info({ res: { statusCode: 200, body: { secret: "leak" } } }, "test");
    const res = lastLine()["res"] as Record<string, unknown>;
    expect(res["status"]).toBe(200);
    expect(res["body"]).toBeUndefined();
  });

  it("falls back to res.status when statusCode absent", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.info({ res: { status: 404 } }, "test");
    const res = lastLine()["res"] as Record<string, unknown>;
    expect(res["status"]).toBe(404);
  });

  it("emits null status when neither statusCode nor status present", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.info({ res: { other: "field" } }, "test");
    const res = lastLine()["res"] as Record<string, unknown>;
    expect(res["status"]).toBeNull();
  });

  it("returns non-object res values unchanged", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.info({ res: null }, "null res");
    expect(lastLine()["res"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// err serializer (lines 231-243)
// ---------------------------------------------------------------------------

describe("BOUNDARY_SERIALIZERS.err — safe envelope", () => {
  it("emits type, message, and stack from a standard Error", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    const error = new Error("something went wrong");
    logger.error({ err: error }, "handler failed");
    const err = lastLine()["err"] as Record<string, unknown>;
    expect(err["type"]).toBe("Error");
    expect(err["message"]).toBe("something went wrong");
    expect(typeof err["stack"]).toBe("string");
  });

  it("uses the constructor.name when name property is absent", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    // An object without a `name` property but with a named constructor.
    class CustomError extends Error {
      constructor() {
        super("custom");
        this.name = "CustomError";
      }
    }
    logger.error({ err: new CustomError() }, "custom error");
    const err = lastLine()["err"] as Record<string, unknown>;
    expect(err["type"]).toBe("CustomError");
  });

  it("redacts non-string message with sentinel", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    // Craft an error-like object with a non-string message.
    logger.error({ err: { name: "WeirdError", message: 42, stack: null } }, "weird");
    const err = lastLine()["err"] as Record<string, unknown>;
    expect(err["message"]).toBe("[non-string message redacted]");
  });

  it("emits null stack when stack is absent", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.error({ err: { name: "NoStack", message: "oops" } }, "no stack");
    const err = lastLine()["err"] as Record<string, unknown>;
    expect(err["stack"]).toBeNull();
  });

  it("drops custom enumerable properties (PII protection)", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    class PiiError extends Error {
      constructor(
        message: string,
        public email: string,
      ) {
        super(message);
        this.name = "PiiError";
      }
    }
    logger.error({ err: new PiiError("fail", "user@example.com") }, "pii error");
    const errStr = JSON.stringify(lastLine()["err"]);
    expect(errStr).not.toContain("user@example.com");
  });

  it("returns non-object err values unchanged (null)", () => {
    const { dest, lastLine } = makeCapture();
    const logger = createLogger({ service: "t", destination: dest });
    logger.error({ err: null }, "null err");
    expect(lastLine()["err"]).toBeNull();
  });
});
