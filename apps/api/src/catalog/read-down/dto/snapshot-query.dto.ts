/**
 * Snapshot-query DTOs for 010 US1 (T035).
 *
 * The read-down snapshot is a GET with only query params (read-only — no body):
 *   - branch_id  : optional uuid, validated against the device token scope
 *                  (mismatch → non-disclosing 404). POS vocabulary for store_id.
 *   - page_token : optional opaque continuation token (do NOT decode here).
 *   - limit      : optional 1..1000 page size (contract Limit; default applied
 *                  in the service).
 *
 * Each is parsed independently with `ZodValidationPipe` at the `@Query` site
 * (mirrors the 009 inventory controller idiom), so a malformed value 400s
 * before reaching the service.
 */
import { z } from "zod";

/** branch_id — optional uuid (POS wire term for store_id). */
export const BranchIdSchema = z.string().uuid().optional();

/** Opaque continuation token — a non-empty string; the service decodes it. */
export const PageTokenSchema = z.string().min(1).optional();

/** limit — coerced 1..1000 (contract Limit: minimum 1, maximum 1000). */
export const LimitSchema = z.coerce.number().int().min(1).max(1000).optional();

/**
 * since — REQUIRED opaque cursor on the delta endpoint (contract Since). A
 * non-empty string; the service decodes + scope-validates it. Missing/empty →
 * 400 validation (a delta with no cursor is meaningless; the consumer must
 * snapshot first).
 */
export const SinceSchema = z.string().min(1);
