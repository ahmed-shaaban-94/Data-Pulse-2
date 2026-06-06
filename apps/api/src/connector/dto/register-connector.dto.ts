/**
 * 018-US1 (T041) — register/issue request DTOs + the wire-shape projections.
 *
 * Strict Zod schemas (§XII mass-assignment ban): the request carries ONLY the
 * registerable fields — tenant_id, actor, id, and disabled state are
 * server-resolved and MUST NOT be body-assignable. Mirrors the contract
 * `RegisterConnectorInstanceRequest` / `IssueCredentialRequest` in
 * `packages/contracts/openapi/connector/connector-admin.yaml`.
 */
import { z } from "zod";

import type { ConnectorRegistrationRow } from "@data-pulse-2/db/schema";

export const CONNECTOR_ENVIRONMENTS = ["dev", "staging", "pilot", "prod"] as const;

/** Server default + ceiling for a credential's bounded expiry (FR-012). */
export const DEFAULT_CREDENTIAL_EXPIRY_DAYS = 90;
export const MAX_CREDENTIAL_EXPIRY_DAYS = 365;

export const RegisterConnectorInstanceRequestSchema = z
  .object({
    display_name: z.string().trim().min(1).max(180),
    erpnext_site_ref: z.string().trim().min(1).max(255),
    environment: z.enum(CONNECTOR_ENVIRONMENTS),
  })
  .strict();

export type RegisterConnectorInstanceRequestDto = z.infer<
  typeof RegisterConnectorInstanceRequestSchema
>;

export const IssueCredentialRequestSchema = z
  .object({
    expires_in_days: z
      .number()
      .int()
      .min(1)
      .max(MAX_CREDENTIAL_EXPIRY_DAYS)
      .optional(),
  })
  .strict();

export type IssueCredentialRequestDto = z.infer<
  typeof IssueCredentialRequestSchema
>;

// ---------------------------------------------------------------------------
// Wire-shape projections (toBody — no raw DB entity, no secret/hash; §IV)
// ---------------------------------------------------------------------------

/** A credential's lifecycle STATUS — never a secret or hash. */
export interface CredentialStatusBody {
  credential_id: string;
  instance_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

/** A connector instance projection — identity + lifecycle + active-cred status. */
export interface ConnectorInstanceBody {
  id: string;
  display_name: string;
  erpnext_site_ref: string;
  environment: (typeof CONNECTOR_ENVIRONMENTS)[number];
  created_at: string;
  disabled_at: string | null;
  active_credential: CredentialStatusBody | null;
}

/** The issue/rotate response — the ONLY place the raw secret appears, once. */
export interface IssuedCredentialBody {
  credential_id: string;
  instance_id: string;
  secret: string;
  expires_at: string;
  issued_at: string;
}

/** Project a connector_registration row (+ optional active credential) to the wire shape. */
export function toConnectorInstance(
  row: ConnectorRegistrationRow,
  activeCredential: CredentialStatusBody | null,
): ConnectorInstanceBody {
  return {
    id: row.id,
    display_name: row.displayName,
    erpnext_site_ref: row.erpnextSiteRef,
    environment: row.environment as (typeof CONNECTOR_ENVIRONMENTS)[number],
    created_at: row.createdAt.toISOString(),
    disabled_at: row.disabledAt ? row.disabledAt.toISOString() : null,
    active_credential: activeCredential,
  };
}
