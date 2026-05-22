/**
 * InstrumentedRedis — ioredis subclass that records
 * `redis_command_duration_seconds` observations on every sendCommand call.
 *
 * Design notes
 * ============
 * - Override point: `sendCommand` is the single ioredis method through which
 *   every Redis command flows (pipeline, multi, and standalone). The return
 *   value is typed `unknown`; most invocations resolve as Promises, but
 *   pipeline/cluster contexts may return synchronous values. A thenable guard
 *   ensures `.then()` is only called on actual Promises, recording duration
 *   on both the synchronous and async paths.
 *
 * - Bounded label set: FR-B-006 forbids unbounded cardinality.
 *   `KNOWN_REDIS_COMMANDS` is the closed set of BullMQ-relevant command
 *   verbs; anything not in the set is bucketed as `"other"`.
 *
 * - `duplicate()` override: BullMQ's `Worker` constructor calls
 *   `connection.duplicate()` to create a separate blocking connection (used
 *   for BRPOP). Without the override, `duplicate()` returns a plain `Redis`
 *   instance and the blocking connection is un-instrumented. The override
 *   returns a new `InstrumentedRedis` so both connections carry the hook.
 *
 * - No `outcome` label: `redis_command_duration_seconds` is defined with
 *   only a `command` label (see `assertMetricLabels` in worker.metrics.ts).
 *   Duration is recorded on both success and error paths regardless.
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / P4 W4.
 */
import { Redis, Command, type RedisOptions } from "ioredis";

import { recordRedisCommandDuration } from "./metrics/worker.metrics";

// ---------------------------------------------------------------------------
// Bounded command label set (FR-B-006)
// ---------------------------------------------------------------------------

/**
 * Closed set of Redis command verbs used by BullMQ and the worker pipelines.
 * Any command not in this set is recorded with label `command = "other"`.
 * Adding a new entry requires a corresponding `ALLOWED_METRIC_LABELS` update
 * (packages/shared) — do NOT widen without that gate.
 */
export const KNOWN_REDIS_COMMANDS: ReadonlySet<string> = new Set([
  "del",
  "eval",
  "evalsha",
  "exists",
  "expire",
  "get",
  "hget",
  "hdel",
  "hgetall",
  "hmget",
  "hset",
  "llen",
  "lpop",
  "lpush",
  "multi",
  "exec",
  "ping",
  "pexpire",
  "rpush",
  "sadd",
  "set",
  "scard",
  "smembers",
  "srem",
  "subscribe",
  "publish",
  "zadd",
  "zcard",
  "zcount",
  "zrange",
  "zrangebyscore",
  "zrem",
  "zremrangebyscore",
]);

/**
 * Normalise a raw command name to the bounded label set.
 * Returns the lowercase name if it is in `KNOWN_REDIS_COMMANDS`, else `"other"`.
 */
export function normalizeCommand(name: string): string {
  const lower = name.toLowerCase();
  return KNOWN_REDIS_COMMANDS.has(lower) ? lower : "other";
}

// ---------------------------------------------------------------------------
// Instrumented subclass
// ---------------------------------------------------------------------------

/**
 * ioredis `Redis` subclass that hooks `sendCommand` to record
 * `redis_command_duration_seconds` on every command resolved or rejected.
 *
 * Pass an instance of this class wherever a BullMQ `Queue` or `Worker`
 * accepts a `connection` option. BullMQ will use it for all non-blocking
 * commands, and `duplicate()` ensures the blocking connection carries the
 * same instrumentation.
 */
export class InstrumentedRedis extends Redis {
  /**
   * Returns a new `InstrumentedRedis` with the same options so BullMQ's
   * blocking connection (created via `connection.duplicate()`) is also
   * instrumented. Without this override, `duplicate()` returns a plain
   * `Redis` instance.
   */
  override duplicate(override?: Partial<RedisOptions>): InstrumentedRedis {
    return new InstrumentedRedis({ ...this.options, ...override });
  }

  /**
   * Wraps the base-class `sendCommand` to record duration in seconds.
   * Duration is recorded on both resolve and reject — the metric tracks
   * total round-trip time regardless of outcome.
   *
   * A thenable guard handles the rare synchronous-return path (pipeline/
   * cluster contexts) so that calling `.then()` on a non-Promise never
   * throws a runtime error.
   */
  override sendCommand(
    command: Command,
    stream?: Parameters<Redis["sendCommand"]>[1],
  ): unknown {
    const start = performance.now();
    const result = super.sendCommand(command, stream);
    if (
      result === null ||
      typeof (result as { then?: unknown }).then !== "function"
    ) {
      recordRedisCommandDuration(
        { command: normalizeCommand(command.name) },
        (performance.now() - start) / 1000,
      );
      return result;
    }
    return (result as Promise<unknown>).then(
      (v: unknown) => {
        recordRedisCommandDuration(
          { command: normalizeCommand(command.name) },
          (performance.now() - start) / 1000,
        );
        return v;
      },
      (err: unknown) => {
        recordRedisCommandDuration(
          { command: normalizeCommand(command.name) },
          (performance.now() - start) / 1000,
        );
        throw err;
      },
    );
  }
}
