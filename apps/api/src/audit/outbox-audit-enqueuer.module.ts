/**
 * OutboxAuditEnqueuerModule -- T583 live DI swap (slice 1C-B2).
 *
 * Sibling leaf module to `AuditEnqueuerModule`. The two together form a
 * deliberate-and-narrow override pattern:
 *
 *   AuditEnqueuerModule -- legacy path. Provides AUDIT_JOB_ENQUEUER bound to
 *     `auditJobEnqueuerFactory` (BullMQ direct / NoOp). NO DB dependency.
 *     Imported by AuthModule for the auth.signin.{ok|failed} emission path
 *     (T238) -- importing the outbox variant there would create the cycle
 *     `AuthModule -> OutboxAuditEnqueuerModule -> AuthModule`.
 *
 *   OutboxAuditEnqueuerModule (this file) -- consults isOutboxAuditEnabled()
 *     + the injected PG_POOL via `outboxOrLegacyAuditJobEnqueuerFactory`,
 *     returns either an OutboxAuditEnqueuer (flag on + pool present) or
 *     the legacy enqueuer (flag off or pool null). Imports AuthModule for
 *     PG_POOL -- which is safe because AuthModule does NOT import this
 *     module. The flow is `AuditModule -> OutboxAuditEnqueuerModule ->
 *     AuthModule`, with AuthModule importing only AuditEnqueuerModule (the
 *     pool-free leaf). No cycle.
 *
 * Why sibling-leaf-module instead of in-place provider replacement
 * ----------------------------------------------------------------
 * The naive alternative -- adding `inject: [PG_POOL]` to AuditEnqueuerModule
 * and importing AuthModule there -- creates the exact cycle the leaf module
 * was built to avoid (see audit-enqueuer.module.ts docstring). The sibling
 * pattern keeps AuditEnqueuerModule cycle-free while letting AuditModule
 * import BOTH leaf modules; Nest's last-import-wins for token providers
 * (Nest core) ensures AuditModule's request-graph emissions reach the
 * outbox-aware factory while AuthModule's auth-signin emissions keep
 * using the legacy BullMQ path.
 *
 * Deliberate consequence
 * ----------------------
 * `auth.signin.{ok|failed}` events ALWAYS take the legacy BullMQ path,
 * regardless of OUTBOX_AUDIT_ENABLED. This preserves the existing auth
 * audit posture (task instruction: "Do not weaken existing auth.signin
 * audit behavior") and is correct: auth-signin happens before
 * TenantContextGuard runs, so the outbox row's tenant_id would be NIL
 * UUID anyway -- routing it through the outbox + drainer + BullMQ path
 * adds latency and a failure surface for zero observable benefit.
 *
 * Last-import-wins
 * ----------------
 * Nest resolves providers by walking the module graph and, for the same
 * token, the LAST registered provider wins. AuditModule imports
 * AuditEnqueuerModule first, then OutboxAuditEnqueuerModule -- so the
 * request-graph AUDIT_JOB_ENQUEUER resolves to THIS module's provider.
 * `outbox-audit-enqueuer.module.spec.ts` boots the actual AuditModule
 * and pins the resolved class so any future re-ordering of imports
 * fails loudly at test time.
 *
 * No second Postgres pool
 * -----------------------
 * AuthModule already constructs PG_POOL (pg.Pool wrapper). This module
 * imports AuthModule and consumes PG_POOL via DI -- there is no
 * additional `new Pool(...)` here.
 */
import { Module, type Provider } from "@nestjs/common";
import type { Pool } from "pg";

import { AuthModule, PG_POOL } from "../auth/auth.module";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "./audit-job.enqueuer";
import { outboxOrLegacyAuditJobEnqueuerFactory } from "./audit-enqueuer.module";

const auditJobEnqueuerProvider: Provider = {
  provide: AUDIT_JOB_ENQUEUER,
  useFactory: (pool: Pool | null): AuditJobEnqueuer =>
    outboxOrLegacyAuditJobEnqueuerFactory(pool),
  inject: [PG_POOL],
};

@Module({
  imports: [AuthModule],
  providers: [auditJobEnqueuerProvider],
  exports: [AUDIT_JOB_ENQUEUER],
})
export class OutboxAuditEnqueuerModule {}
