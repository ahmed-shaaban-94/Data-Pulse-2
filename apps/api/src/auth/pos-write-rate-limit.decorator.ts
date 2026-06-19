/**
 * @PosWriteRateLimitBucket — ADR 0009 (audit M-2).
 *
 * Route-level decorator marking which per-device write bucket
 * `PosWriteRateLimitGuard` enforces on a handler. Passive — it only stores
 * metadata; the guard reads it via `Reflector.get(KEY, ctx.getHandler())` and
 * throttles accordingly. A route WITHOUT this annotation is not throttled (the
 * guard allows it), so the guard is inert until a route opts in.
 *
 * This is the per-route-config-for-an-enhancer pattern (mirrors `@Idempotent` /
 * `@Auditable`): a guard referenced by class in `@UseGuards(...)` is
 * reflection-instantiated as a single shared instance, so per-route policy MUST
 * come from route metadata, not a per-instance constructor argument.
 *
 * Usage:
 *   @UseGuards(PosOperatorEnvelopeSaleGuard, PosWriteRateLimitGuard)
 *   @PosWriteRateLimitBucket("posWriteSale")
 */
import { SetMetadata } from "@nestjs/common";

import type { POS_WRITE_RATE_LIMIT_BUCKETS } from "./rate-limit";

export type PosWriteBucketName = keyof typeof POS_WRITE_RATE_LIMIT_BUCKETS;

export const POS_WRITE_RATE_LIMIT_BUCKET_KEY = "dp2:pos-write-rate-limit:bucket";

export const PosWriteRateLimitBucket = (bucket: PosWriteBucketName) =>
  SetMetadata(POS_WRITE_RATE_LIMIT_BUCKET_KEY, bucket);
