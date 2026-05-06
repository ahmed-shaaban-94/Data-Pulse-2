/**
 * DeviceRepository — read-side lookups against `devices` for sign-in.
 *
 * Wave 1 sign-in resolves the terminal scope (tenant + branch) by hashing
 * the operator-supplied `device_token_attestation` and matching the
 * `devices.token_hash` column. The plaintext attestation is never logged
 * or persisted (ADR 0001 D7, FR-POS-AUTH-2).
 *
 * The lookup is intentionally direct against the admin pool: at sign-in
 * time the request has no established tenant context (the device is the
 * source of that context). Tenant/store consistency between the device
 * and the resolved operator is enforced by the service layer
 * (PosOperatorsService.signIn) not by RLS, per ADR D9 final paragraph.
 */
import { Injectable } from "@nestjs/common";
import { hashToken } from "@data-pulse-2/auth";
import { devices, type DeviceRow } from "@data-pulse-2/db/schema";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull } from "drizzle-orm";
import type { Pool } from "pg";

type DrizzleClient = NodePgDatabase;

function db(client: Pool): DrizzleClient {
  return drizzle(client);
}

@Injectable()
export class DeviceRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Resolve a device by its raw token attestation. Returns the row when
   * the hash matches AND `revoked_at IS NULL`; returns null otherwise.
   *
   * Constant-time hash compare is provided by Postgres' BYTEA equality
   * — the column is UNIQUE so the lookup is a single index probe and
   * returns at most one row regardless of input.
   */
  async findActiveByAttestation(rawAttestation: string): Promise<DeviceRow | null> {
    if (rawAttestation.length === 0) return null;
    const tokenHash = hashToken(rawAttestation);
    const rows = await db(this.pool)
      .select()
      .from(devices)
      .where(and(eq(devices.tokenHash, tokenHash), isNull(devices.revokedAt)))
      .limit(1);
    return rows[0] ?? null;
  }
}
