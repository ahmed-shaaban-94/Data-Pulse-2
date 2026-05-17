/**
 * T583 — OutboxAuditEnqueuer: replaces direct BullMQ enqueue with outbox emission.
 *
 * This is a drop-in replacement for `AuditQueueProducer` that satisfies
 * the `AuditJobEnqueuer` interface but writes to `outbox_events` instead
 * of enqueuing directly to BullMQ.
 *
 * Flow BEFORE T583:
 *   AuditEmitterInterceptor → AuditQueueProducer.enqueue() → BullMQ "audit" queue
 *
 * Flow AFTER T583:
 *   AuditEmitterInterceptor → OutboxAuditEnqueuer.enqueue()
 *     → outbox_events row (delivery_state='pending')
 *   DrainerProcessor polls → claims row → AuditEventCreatedConsumer.handle()
 *     → BullMQ "audit" queue → AuditFanoutProcessor persists audit_events row
 *
 * Atomicity note
 * --------------
 * `AuditEmitterInterceptor` fires POST-response (in a `tap()` RxJS operator),
 * so the audit emission is already not in the same transaction as the auditable
 * request handler. This enqueuer preserves that "best-effort post-response"
 * semantic — it emits in a fresh transaction (`emitInNewTransaction`).
 *
 * For true transactional atomicity (emit in the same tx as the business write),
 * the caller would need to pass a `PoolClient` to `emit()` directly. That
 * refactor is deferred to a future slice.
 *
 * Tenant-context derivation
 * -------------------------
 * `AuditJobPayload.tenant_id` may be null (platform-admin/anonymous-actor path).
 * For the outbox row, `tenant_id` is NOT NULL (schema constraint). When the
 * payload has null tenant_id, we use the NIL UUID as the context tenantId +
 * isPlatformAdmin: true, and store a NIL UUID in the outbox row's tenant_id.
 * This mirrors the pattern in `insertAuditEvent` (packages/db/src/helpers/audit-insert.ts).
 *
 * NOTE: Null tenant_id in the audit payload means the event is platform-scoped.
 * The outbox RLS policy allows platform-admin context to INSERT. The drainer
 * claim query runs under platform-admin context and will see these rows.
 *
 * Payload shape
 * -------------
 * The `AuditJobPayload` is stored as the outbox event payload verbatim.
 * The `AuditEventCreatedConsumer` on the worker side parses and validates it
 * with the same Zod schema mirror before enqueuing to BullMQ.
 */
import { Injectable, Inject } from "@nestjs/common";
import type { Pool } from "pg";
import {
  emitInNewTransaction,
  OUTBOX_EVENT_TYPES,
} from "@data-pulse-2/db";
import { PG_POOL } from "../auth/auth.module";
import type { AuditJobEnqueuer } from "./audit-job.enqueuer";
import type { AuditJobPayload } from "./audit-job.types";

/** NIL UUID — same sentinel used in insertAuditEvent for platform-scoped rows. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

@Injectable()
export class OutboxAuditEnqueuer implements AuditJobEnqueuer {
  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
  ) {}

  async enqueue(payload: AuditJobPayload): Promise<void> {
    const tenantId = payload.tenant_id ?? null;
    const isPlatformAdmin = tenantId === null;
    // For the outbox row, tenant_id must be a UUID (NOT NULL). Platform-scoped
    // events use NIL_UUID; the drainer's platform-admin claim context sees all rows.
    const rowTenantId = tenantId ?? NIL_UUID;

    await emitInNewTransaction(
      this.pool,
      { tenantId: rowTenantId, isPlatformAdmin },
      {
        eventType: OUTBOX_EVENT_TYPES.AUDIT_EVENT_CREATED,
        tenantId: rowTenantId,
        storeId: payload.store_id,
        payload: {
          actor_user_id: payload.actor_user_id,
          actor_label:   payload.actor_label,
          tenant_id:     payload.tenant_id,
          store_id:      payload.store_id,
          action:        payload.action,
          target_type:   payload.target_type,
          target_id:     payload.target_id,
          request_id:    payload.request_id,
          metadata:      payload.metadata,
        },
        correlationId: payload.request_id,
      },
    );
  }
}
