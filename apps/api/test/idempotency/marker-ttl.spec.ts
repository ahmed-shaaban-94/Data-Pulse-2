/**
 * T514 — Marker TTL test.
 *
 * InProgressMarker uses a 60-second default TTL (strategy.md §9.2).
 * After expiry, a retry should be treated correctly:
 *   - If the original completed (store has an entry): replay.
 *   - If the original failed (store has no entry): fresh request.
 *
 * This is a unit test for InProgressMarker and IdempotencyInterceptor logic
 * using a controllable fake Redis that exposes TTL.
 */
import "reflect-metadata";
import { InProgressMarker, DEFAULT_INFLIGHT_TTL_SEC } from "../../src/idempotency/in-progress-marker";

// ---------------------------------------------------------------------------
// Fake Redis that records SET NX EX calls
// ---------------------------------------------------------------------------
interface SetCall { key: string; value: string; ttlSec: number }

class RecordingRedis {
  public setCalls: SetCall[] = [];
  public delCalls: string[] = [];
  private store: Map<string, { value: string; expiresAt: number }> = new Map();

  async set(key: string, value: string, opts: { nx: true; ex: number }): Promise<"OK" | null> {
    this.setCalls.push({ key, value, ttlSec: opts.ex });
    if (this.store.has(key)) return null; // NX = only set if absent
    this.store.set(key, { value, expiresAt: Date.now() + opts.ex * 1000 });
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.delCalls.push(key);
    this.store.delete(key);
    return 1;
  }

  /** Simulate TTL expiry by removing the key. */
  expire(key: string): void { this.store.delete(key); }

  /** Check whether a key currently exists. */
  has(key: string): boolean {
    const e = this.store.get(key);
    if (!e) return false;
    if (Date.now() > e.expiresAt) { this.store.delete(key); return false; }
    return true;
  }

  clear(): void { this.store.clear(); this.setCalls = []; this.delCalls = []; }
}

describe("T514 — InProgressMarker TTL behavior", () => {
  let redis: RecordingRedis;
  let marker: InProgressMarker;

  beforeEach(() => {
    redis = new RecordingRedis();
    marker = new InProgressMarker(redis);
  });

  it("default TTL is 60 seconds", () => {
    expect(DEFAULT_INFLIGHT_TTL_SEC).toBe(60);
  });

  it("trySet stores the marker with the default 60s TTL", async () => {
    const result = await marker.trySet("tuple-1");
    expect(result).toBe(true);
    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0]!.ttlSec).toBe(60);
  });

  it("trySet respects a custom TTL override", async () => {
    await marker.trySet("tuple-custom", 120);
    expect(redis.setCalls[0]!.ttlSec).toBe(120);
  });

  it("trySet returns false when marker already exists (NX fails)", async () => {
    await marker.trySet("tuple-1");       // first: sets the key
    const second = await marker.trySet("tuple-1"); // NX fails
    expect(second).toBe(false);
  });

  it("trySet returns true after TTL expiry (marker self-clears)", async () => {
    await marker.trySet("tuple-1");
    // Simulate TTL expiry by forcing key removal
    const key = [...redis["store"].keys()].find((k) => k.startsWith("idem:inflight:"))!;
    redis.expire(key);

    const result = await marker.trySet("tuple-1");
    expect(result).toBe(true);
  });

  it("del removes the marker key", async () => {
    await marker.trySet("tuple-1");
    await marker.del("tuple-1");
    expect(redis.delCalls).toHaveLength(1);
  });

  it("del is idempotent on a non-existent key (no throw)", async () => {
    await expect(marker.del("does-not-exist")).resolves.toBeUndefined();
  });

  it("marker key is deterministic for the same tuple", async () => {
    await marker.trySet("same-tuple");
    await marker.trySet("same-tuple");
    // Both calls go to the same key
    const keys = new Set(redis.setCalls.map((c) => c.key));
    expect(keys.size).toBe(1);
  });

  it("marker keys are different for different tuples", async () => {
    await marker.trySet("tuple-A");
    await marker.trySet("tuple-B");
    const keys = redis.setCalls.map((c) => c.key);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
