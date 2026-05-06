/**
 * POS-Operators DTOs — Wave 1 sign-in surface.
 *
 * Source of truth: `packages/contracts/openapi/pos-operators.openapi.yaml`.
 *
 * The Zod schema below mirrors `PosOperatorSignInRequest`:
 *   - `kind` is a literal — only "manager_admin" is admitted in Wave 1.
 *   - `device_token_attestation` is a non-empty string (terminal-side proof
 *     of possession of the paired device token).
 *   - `branch_id` is **not** a body field — it is resolved server-side from
 *     the device-token claim. Including it would be an additional property
 *     and rejected by `additionalProperties: false`.
 *
 * Forbidden fields (`password`, `identifier`, `pin`, `cashier`,
 * `clerk_session_token`, `branch_id`) are not declared and are rejected
 * via Zod's `.strict()` (= OpenAPI `additionalProperties: false`).
 */
import { z } from "zod";

export const PosOperatorSignInSchema = z
  .object({
    kind: z.literal("manager_admin"),
    device_token_attestation: z.string().min(1),
  })
  .strict();

export type PosOperatorSignInInput = z.infer<typeof PosOperatorSignInSchema>;

/**
 * POS-facing operator role values. Mapped from the internal `roles.code`
 * vocabulary at the DTO/service boundary:
 *
 *   internal `owner`        → POS `admin`
 *   internal `tenant_admin` → POS `admin`
 *   internal `store_manager`→ POS `manager`
 *   internal `store_staff`  → INELIGIBLE for the `manager_admin` surface
 *
 * Internal vocabulary never appears in POS-facing payloads (FR-POS-AUTH-7
 * analogue for role names).
 */
export type PosOperatorRole = "manager" | "admin";

/** Conforms to OpenAPI `PosOperatorSummary`. */
export interface PosOperatorSummaryBody {
  /** `users.clerk_user_id` (Clerk subject), NOT `users.id` (ADR D4). */
  id: string;
  display_name: string;
  role: PosOperatorRole;
  /** Tenant UUID (server-internal IDs are visible here, but `branch_id` is the only POS-facing branch identifier). */
  tenant_id: string;
  /** Internal `store_id` surfaced as `branch_id` to POS callers (FR-POS-AUTH-7). */
  branch_id: string;
}

/** Conforms to OpenAPI `PosOperatorSessionSummary`. */
export interface PosOperatorSessionSummaryBody {
  id: string;
  issued_at: string;
}

/** Conforms to OpenAPI `PosOperatorSignInSucceeded`. */
export interface PosOperatorSignInSucceededBody {
  kind: "signed_in";
  operator: PosOperatorSummaryBody;
  operator_session: PosOperatorSessionSummaryBody;
}

/** Conforms to OpenAPI `PosOperatorTakeoverRequired`. */
export interface PosOperatorTakeoverRequiredBody {
  kind: "takeover_required";
}

export type PosOperatorSignInResponseBody =
  | PosOperatorSignInSucceededBody
  | PosOperatorTakeoverRequiredBody;
