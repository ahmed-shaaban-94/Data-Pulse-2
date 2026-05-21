/**
 * Unit tests for InstrumentedRedis — the ioredis subclass that records
 * `redis_command_duration_seconds` on every sendCommand call.
 *
 * Tests cover:
 *   1. normalizeCommand — known/unknown command normalization
 *   2. KNOWN_REDIS_COMMANDS — closed-set membership
 *   3. InstrumentedRedis.duplicate — subclass propagation
 *   4. InstrumentedRedis.sendCommand — recording on resolve and reject
 *
 * `sendCommand` is tested by spying on `Redis.prototype.sendCommand` so no
 * live Redis connection is needed.
 *
 * Constitution §VII / FR-B-006 / P4 W4.
 */
import { Redis, type Command } from "ioredis";

import {
  InstrumentedRedis,
  normalizeCommand,
  KNOWN_REDIS_COMMANDS,
} from "../../src/observability/instrumented-redis";
import { recordRedisCommandDuration } from "../../src/observability/metrics/worker.metrics";

jest.mock("../../src/observability/metrics/worker.metrics", () => ({
  recordRedisCommandDuration: jest.fn(),
}));

const mockedRecord = recordRedisCommandDuration as jest.MockedFunction<
  typeof recordRedisCommandDuration
>;

function makeCommand(name: string): Command {
  return { name } as unknown as Command;
}

// ---------------------------------------------------------------------------
// 1. normalizeCommand
// ---------------------------------------------------------------------------

describe("normalizeCommand", () => {
  it("returns lowercase name for a known command (lowercase input)", () => {
    expect(normalizeCommand("get")).toBe("get");
  });

  it("returns lowercase name for a known command (UPPERCASE input)", () => {
    expect(normalizeCommand("GET")).toBe("get");
  });

  it("returns lowercase name for a known command (mixed case)", () => {
    expect(normalizeCommand("Zadd")).toBe("zadd");
  });

  it('returns "other" for an unknown command', () => {
    expect(normalizeCommand("xread")).toBe("other");
  });

  it('returns "other" for an empty string', () => {
    expect(normalizeCommand("")).toBe("other");
  });

  it('returns "other" for a blocking-pop command not in the bounded set', () => {
    expect(normalizeCommand("brpop")).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// 2. KNOWN_REDIS_COMMANDS
// ---------------------------------------------------------------------------

describe("KNOWN_REDIS_COMMANDS", () => {
  it("includes core BullMQ-relevant commands", () => {
    const required = ["zadd", "zrangebyscore", "lpush", "llen", "hset", "eval", "ping"];
    required.forEach((cmd) => {
      expect(KNOWN_REDIS_COMMANDS.has(cmd)).toBe(true);
    });
  });

  it("does not include brpop (blocking pop belongs to BullMQ internals, not the bounded set)", () => {
    expect(KNOWN_REDIS_COMMANDS.has("brpop")).toBe(false);
  });

  it("does not include dangerous or unbounded admin commands", () => {
    expect(KNOWN_REDIS_COMMANDS.has("flushall")).toBe(false);
    expect(KNOWN_REDIS_COMMANDS.has("select")).toBe(false);
    expect(KNOWN_REDIS_COMMANDS.has("keys")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. InstrumentedRedis.duplicate
// ---------------------------------------------------------------------------

describe("InstrumentedRedis.duplicate", () => {
  let redis: InstrumentedRedis;

  beforeEach(() => {
    redis = new InstrumentedRedis({ lazyConnect: true });
  });

  afterEach(() => {
    redis.disconnect();
  });

  it("returns an InstrumentedRedis instance (not plain Redis)", () => {
    const dup = redis.duplicate();
    expect(dup).toBeInstanceOf(InstrumentedRedis);
    dup.disconnect();
  });

  it("duplicate of a duplicate is still InstrumentedRedis", () => {
    const dup1 = redis.duplicate();
    const dup2 = dup1.duplicate();
    expect(dup2).toBeInstanceOf(InstrumentedRedis);
    dup1.disconnect();
    dup2.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 4. InstrumentedRedis.sendCommand — recording on resolve and reject
// ---------------------------------------------------------------------------

describe("InstrumentedRedis.sendCommand — recording", () => {
  let redis: InstrumentedRedis;
  let superSpy: jest.SpyInstance;

  beforeEach(() => {
    redis = new InstrumentedRedis({ lazyConnect: true });
    superSpy = jest
      .spyOn(Redis.prototype, "sendCommand")
      .mockReturnValue(Promise.resolve("ok"));
    mockedRecord.mockClear();
  });

  afterEach(() => {
    superSpy.mockRestore();
    redis.disconnect();
  });

  it("resolves with the value returned by the underlying sendCommand", async () => {
    superSpy.mockReturnValue(Promise.resolve("expected-value"));
    const result = await (redis.sendCommand(makeCommand("get")) as Promise<unknown>);
    expect(result).toBe("expected-value");
  });

  it("calls recordRedisCommandDuration exactly once on resolve", async () => {
    await (redis.sendCommand(makeCommand("get")) as Promise<unknown>);
    expect(mockedRecord).toHaveBeenCalledTimes(1);
  });

  it("records the correct known command label on resolve", async () => {
    await (redis.sendCommand(makeCommand("zadd")) as Promise<unknown>);
    expect(mockedRecord).toHaveBeenCalledWith({ command: "zadd" }, expect.any(Number));
  });

  it('records command="other" for an unknown command on resolve', async () => {
    await (redis.sendCommand(makeCommand("xread")) as Promise<unknown>);
    expect(mockedRecord).toHaveBeenCalledWith({ command: "other" }, expect.any(Number));
  });

  it("records a non-negative duration in seconds on resolve", async () => {
    await (redis.sendCommand(makeCommand("ping")) as Promise<unknown>);
    const calls = mockedRecord.mock.calls;
    for (const [, duration] of calls) {
      expect(duration).toBeGreaterThanOrEqual(0);
      // Unit test completes well under 60 seconds — seconds, not milliseconds
      expect(duration).toBeLessThan(60);
    }
  });

  it("calls recordRedisCommandDuration exactly once on reject", async () => {
    superSpy.mockReturnValue(Promise.reject(new Error("connection refused")));
    await expect(
      redis.sendCommand(makeCommand("get")) as Promise<unknown>,
    ).rejects.toThrow("connection refused");
    expect(mockedRecord).toHaveBeenCalledTimes(1);
  });

  it("records the correct known command label on reject", async () => {
    superSpy.mockReturnValue(Promise.reject(new Error("timeout")));
    await expect(
      redis.sendCommand(makeCommand("set")) as Promise<unknown>,
    ).rejects.toThrow();
    expect(mockedRecord).toHaveBeenCalledWith({ command: "set" }, expect.any(Number));
  });

  it("rethrows the original error object after recording on reject", async () => {
    const originalError = new Error("redis timeout");
    superSpy.mockReturnValue(Promise.reject(originalError));
    await expect(
      redis.sendCommand(makeCommand("get")) as Promise<unknown>,
    ).rejects.toBe(originalError);
  });

  it('records command="other" for an unknown command on reject', async () => {
    superSpy.mockReturnValue(Promise.reject(new Error("fail")));
    await expect(
      redis.sendCommand(makeCommand("brpop")) as Promise<unknown>,
    ).rejects.toThrow();
    expect(mockedRecord).toHaveBeenCalledWith({ command: "other" }, expect.any(Number));
  });

  it("normalises UPPERCASE command names to the bounded label set on resolve", async () => {
    await (redis.sendCommand(makeCommand("GET")) as Promise<unknown>);
    expect(mockedRecord).toHaveBeenCalledWith({ command: "get" }, expect.any(Number));
  });
});
