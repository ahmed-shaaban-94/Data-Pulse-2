# 005-WAVE1-METRICS-MISMATCH-FOLLOWUP PR 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken async exception filter `IdempotencyMismatchFilter` with `IdempotencyMismatchInterceptor` (using RxJS `tap({ error: ... })`) so that the `T532` integration spec (currently RED on `main`) turns GREEN without changing the FR-021c wire contract.

**Architecture:** Route-scoped `@UseInterceptors(IdempotencyMismatchInterceptor)` on `posCaptureItem` replaces the prior `@UseFilters(IdempotencyMismatchFilter)`. The new interceptor mirrors `AuditEmitterInterceptor`'s pattern: `next.handle().pipe(tap({ error: handler }))` where `handler` fires the catalog counter + fire-and-forget audit. The original `ConflictException` continues propagating to `GlobalExceptionFilter` unchanged, restoring single-filter pipeline parity with 001's working `apps/api/test/idempotency/conflict.spec.ts`.

**Tech Stack:** TypeScript 5.x strict · NestJS 11 · RxJS 7 · Jest 29 · pino · pnpm 9 workspace · prom-client (transitive via `api.metrics`).

**Spec:** `docs/superpowers/specs/2026-05-28-005-followup-pr2-architectural-pivot-design.md` (commit `e5f4d97` on this branch).

**Branch (already created):** `fix/005-wave1-metrics-mismatch-followup-pr2` off `main` at `5dcb12f`.

**Working precedents to mirror:**
- `apps/api/src/audit/audit-emitter.interceptor.ts` — `tap({ next: ... })` + fire-and-forget enqueue + `@Optional() @Inject(ROOT_LOGGER)`.
- `apps/api/test/audit/audit-emitter.interceptor.unit.spec.ts` — unit-spec harness shape (no DI container; hand-built `ExecutionContext`).
- `apps/api/test/catalog/unknown-items/filters/idempotency-mismatch.filter.unit.spec.ts` — IMF1-5 cases to port as IMI1-5.

---

## Task 0: [GATED] Get explicit approval for execution-map.yaml allowed_files expansion

**Files:**
- Modify: `specs/005-pos-catalog-sync-reconciliation/execution-map.yaml:883-888`

Per `docs/agent-os/standing-rules.md` §3, edits to `execution-map.yaml` are a `[GATED]` action requiring explicit user approval before staging. This task is the gate; do not proceed to Task 1 without approval.

- [ ] **Step 1: Surface the [GATED] ask to the user**

Show the user the exact diff that will land in the next step, and ask for explicit approval:

> [GATED] — about to modify `specs/005-pos-catalog-sync-reconciliation/execution-map.yaml` to expand the slice's `allowed_files` so PR 2 can touch the controller, module, and the new interceptors/ subdir. The diff is:
>
> ```diff
>     allowed_files:
>       - apps/api/test/catalog/unknown-items/audit/metrics.spec.ts
>       - apps/api/test/catalog/unknown-items/audit/idempotency-mismatch-audit.spec.ts   # T550 new file
>       - apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts
>       - apps/api/src/idempotency/idempotency.interceptor.ts
>       - apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts        # to be deleted in PR 2
> +     - apps/api/src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.ts  # NEW (PR 2)
> +     - apps/api/src/catalog/unknown-items/unknown-items.controller.ts                       # NEW (PR 2)
> +     - apps/api/src/catalog/unknown-items/unknown-items.module.ts                           # NEW (PR 2)
> +     - apps/api/test/catalog/unknown-items/filters/idempotency-mismatch.filter.unit.spec.ts # to be deleted in PR 2
> +     - apps/api/test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts  # NEW (PR 2)
> ```
>
> Approve to proceed?

Wait for an explicit `approved` / `go` before Step 2.

- [ ] **Step 2: Apply the approved diff**

Use the `Edit` tool on `specs/005-pos-catalog-sync-reconciliation/execution-map.yaml`. The exact `old_string` to match (lines 883-888 of current main):

```yaml
    allowed_files:
      - apps/api/test/catalog/unknown-items/audit/metrics.spec.ts
      - apps/api/test/catalog/unknown-items/audit/idempotency-mismatch-audit.spec.ts   # T550 new file
      - apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts
      - apps/api/src/idempotency/idempotency.interceptor.ts
      - apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts
```

Replace with:

```yaml
    allowed_files:
      - apps/api/test/catalog/unknown-items/audit/metrics.spec.ts
      - apps/api/test/catalog/unknown-items/audit/idempotency-mismatch-audit.spec.ts   # T550 new file
      - apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts
      - apps/api/src/idempotency/idempotency.interceptor.ts
      - apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts        # deleted in PR 2 (architectural pivot)
      - apps/api/src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.ts  # PR 2 (architectural pivot)
      - apps/api/src/catalog/unknown-items/unknown-items.controller.ts                       # PR 2 (architectural pivot)
      - apps/api/src/catalog/unknown-items/unknown-items.module.ts                           # PR 2 (architectural pivot)
      - apps/api/test/catalog/unknown-items/filters/idempotency-mismatch.filter.unit.spec.ts # deleted in PR 2 (filter unit spec)
      - apps/api/test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts  # PR 2 (ported IMI1-5)
```

- [ ] **Step 3: Commit the execution-map edit**

```bash
git add specs/005-pos-catalog-sync-reconciliation/execution-map.yaml
git commit -m "$(cat <<'EOF'
[GATED] chore(005): expand FOLLOWUP slice allowed_files for PR 2 pivot

PR 2 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP needs to:
- create apps/api/src/catalog/unknown-items/interceptors/* (new dir)
- edit apps/api/src/catalog/unknown-items/unknown-items.controller.ts
- edit apps/api/src/catalog/unknown-items/unknown-items.module.ts
- delete apps/api/test/.../filters/idempotency-mismatch.filter.unit.spec.ts
- create apps/api/test/.../interceptors/idempotency-mismatch.interceptor.unit.spec.ts

All five paths were outside the slice's prior allowed_files. Adding
them here per Standing Rules §3 [GATED] approval (user authorised
2026-05-28). Justification: see PR #387 wave-status.md investigation
update + this branch's design doc.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1: Create the new IdempotencyMismatchInterceptor (failing unit tests first)

**Files:**
- Create: `apps/api/src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.ts`
- Create: `apps/api/test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts`

TDD discipline: write IMI1-5 unit tests first, watch them fail, then implement the interceptor.

- [ ] **Step 1: Create parent directories**

```bash
mkdir -p apps/api/src/catalog/unknown-items/interceptors
mkdir -p apps/api/test/catalog/unknown-items/interceptors
```

- [ ] **Step 2: Write the failing IMI1-5 unit tests**

Use the `Write` tool to create `apps/api/test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts` with this exact content:

```typescript
/**
 * idempotency-mismatch.interceptor.unit.spec.ts
 *
 * Docker-free unit coverage for IdempotencyMismatchInterceptor.
 *
 * Strategy: construct the interceptor directly (no DI container), hand-build
 * an ExecutionContext + a CallHandler that returns an Observable wrapping a
 * caller-supplied error, subscribe, and assert on the audit-enqueue payload +
 * the propagated error.
 *
 * Mirrors the proven pattern in `apps/api/test/audit/audit-emitter.interceptor.unit.spec.ts`.
 * Ports IMF1-5 from the prior IdempotencyMismatchFilter unit spec; renumbered
 * IMI1-5. Behavioural contract identical; mechanism differs.
 *
 * Branches covered:
 *   IMI1 — non-ConflictException error → no side effects, error propagates unchanged
 *   IMI2 — non-matching code → no side effects, error propagates unchanged
 *   IMI3 — matching code + enqueuer wired → counter fires, audit enqueued, error propagates
 *   IMI4 — matching code + enqueuer null (constructor @Optional fallback) → counter fires, no audit
 *   IMI5 — matching code + enqueuer rejects → counter fires, original error propagates (not the BullMQ error)
 *
 * Note: IMF5 (filter-only "tolerates absent request fields" case) is folded
 * into IMI3 as the canonical matching-code path; the interceptor's payload
 * construction is byte-identical to the filter's, so a separate "absent
 * fields" case is redundant.
 */
import "reflect-metadata";

import {
  type CallHandler,
  ConflictException,
  type ExecutionContext,
} from "@nestjs/common";
import { firstValueFrom, lastValueFrom, of, throwError } from "rxjs";

import { IdempotencyMismatchInterceptor } from "../../../../src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor";
import type { AuditJobEnqueuer } from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import * as apiMetrics from "../../../../src/observability/metrics/api.metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
      getResponse: <T>() => ({} as unknown as T),
    }),
  } as unknown as ExecutionContext;
}

function makeHandler(observableFactory: () => ReturnType<typeof of>): CallHandler {
  return { handle: observableFactory } as unknown as CallHandler;
}

class FakeEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
}

class ThrowingEnqueuer implements AuditJobEnqueuer {
  public callCount = 0;
  async enqueue(_payload: AuditJobPayload): Promise<void> {
    this.callCount += 1;
    throw new Error("BullMQ outage");
  }
}

const MATCHING_EXCEPTION = (): ConflictException =>
  new ConflictException({
    code: "idempotency_key_conflict",
    message:
      "The provided Idempotency-Key has already been used for a different request body. Generate a new key.",
  });

const NON_MATCHING_EXCEPTION = (): ConflictException =>
  new ConflictException({
    code: "alias_conflict",
    message: "Some other 409 reason — not our concern.",
  });

const REQUEST_SHAPE = {
  context: {
    tenantId: "0a000000-0000-7000-8000-00000000a1d1",
    storeId: "0a000000-0000-7000-8000-00000000a51c",
  },
  principal: {
    userId: "0a000000-0000-7000-8000-00000000ad11",
  },
  requestId: "req_abc123",
};

/**
 * Subscribe to the interceptor's output and resolve to:
 *   { kind: "value", value } on success
 *   { kind: "error", error } on error
 * Avoids relying on rxjs `firstValueFrom`/`lastValueFrom` rejection shape.
 */
async function collectOutcome<T>(observable: import("rxjs").Observable<T>): Promise<
  { kind: "value"; value: T } | { kind: "error"; error: unknown }
> {
  return new Promise((resolve) => {
    observable.subscribe({
      next: (value) => resolve({ kind: "value", value }),
      error: (error) => resolve({ kind: "error", error }),
    });
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("IdempotencyMismatchInterceptor (unit, no harness)", () => {
  let mismatchCounter: number;
  let counterSpy: jest.SpyInstance;

  beforeEach(() => {
    mismatchCounter = 0;
    counterSpy = jest
      .spyOn(apiMetrics, "recordIdempotencyTokenMismatch")
      .mockImplementation(() => {
        mismatchCounter += 1;
      });
  });

  afterEach(() => {
    counterSpy.mockRestore();
  });

  // IMI1 — non-ConflictException error: passthrough, no side effects.
  it("IMI1: non-ConflictException error propagates unchanged with no side effects", async () => {
    const enqueuer = new FakeEnqueuer();
    const interceptor = new IdempotencyMismatchInterceptor(enqueuer);
    const error = new Error("some other failure");
    const ctx = makeCtx(REQUEST_SHAPE);
    const next = makeHandler(() => throwError(() => error));

    const outcome = await collectOutcome(interceptor.intercept(ctx, next));

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toBe(error);
    expect(mismatchCounter).toBe(0);
    expect(enqueuer.calls).toHaveLength(0);
  });

  // IMI2 — ConflictException with non-matching code: passthrough, no side effects.
  it("IMI2: non-matching 409 propagates unchanged with no side effects", async () => {
    const enqueuer = new FakeEnqueuer();
    const interceptor = new IdempotencyMismatchInterceptor(enqueuer);
    const exception = NON_MATCHING_EXCEPTION();
    const ctx = makeCtx(REQUEST_SHAPE);
    const next = makeHandler(() => throwError(() => exception));

    const outcome = await collectOutcome(interceptor.intercept(ctx, next));

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toBe(exception);
    expect(mismatchCounter).toBe(0);
    expect(enqueuer.calls).toHaveLength(0);
  });

  // IMI3 — matching code + enqueuer wired: counter increments, audit enqueued, error propagates.
  it("IMI3: matching 409 increments counter, enqueues audit, propagates the original error", async () => {
    const enqueuer = new FakeEnqueuer();
    const interceptor = new IdempotencyMismatchInterceptor(enqueuer);
    const exception = MATCHING_EXCEPTION();
    const ctx = makeCtx(REQUEST_SHAPE);
    const next = makeHandler(() => throwError(() => exception));

    const outcome = await collectOutcome(interceptor.intercept(ctx, next));

    // Allow microtask queue to drain the fire-and-forget enqueue call.
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toBe(exception);
    expect(mismatchCounter).toBe(1);
    expect(enqueuer.calls).toHaveLength(1);
    const payload = enqueuer.calls[0]!;
    expect(payload.action).toBe("unknown_item.idempotency_mismatch_rejected");
    expect(payload.tenant_id).toBe(REQUEST_SHAPE.context.tenantId);
    expect(payload.store_id).toBe(REQUEST_SHAPE.context.storeId);
    expect(payload.actor_user_id).toBe(REQUEST_SHAPE.principal.userId);
    expect(payload.request_id).toBe(REQUEST_SHAPE.requestId);
    expect(payload.target_type).toBeNull();
    expect(payload.target_id).toBeNull();
    expect(payload.metadata).toBeNull();
  });

  // IMI4 — matching code + enqueuer null: counter increments, no audit.
  it("IMI4: matching 409 with null enqueuer still increments counter, no audit, no throw", async () => {
    const interceptor = new IdempotencyMismatchInterceptor(null);
    const exception = MATCHING_EXCEPTION();
    const ctx = makeCtx(REQUEST_SHAPE);
    const next = makeHandler(() => throwError(() => exception));

    const outcome = await collectOutcome(interceptor.intercept(ctx, next));

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toBe(exception);
    expect(mismatchCounter).toBe(1);
  });

  // IMI5 — matching code + enqueuer throws: original ConflictException propagates, not BullMQ error.
  it("IMI5: matching 409 with throwing enqueuer propagates the original 409 (not the BullMQ error)", async () => {
    const enqueuer = new ThrowingEnqueuer();
    const interceptor = new IdempotencyMismatchInterceptor(enqueuer);
    const exception = MATCHING_EXCEPTION();
    const ctx = makeCtx(REQUEST_SHAPE);
    const next = makeHandler(() => throwError(() => exception));

    const outcome = await collectOutcome(interceptor.intercept(ctx, next));

    // Allow microtask queue to drain the fire-and-forget enqueue call (which rejects).
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toBe(exception);
    expect(mismatchCounter).toBe(1);
    expect(enqueuer.callCount).toBe(1);
  });
});
```

- [ ] **Step 3: Run the unit spec — confirm it fails because the interceptor doesn't exist**

```bash
pnpm --filter @data-pulse-2/api exec jest test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts --no-coverage 2>&1 | tail -30
```

Expected: `Cannot find module '../../../../src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor'` (or similar import-not-found). All 5 cases fail to even load. This confirms the test sees the absence we expect.

- [ ] **Step 4: Implement IdempotencyMismatchInterceptor (minimal code to make IMI1-5 pass)**

Use the `Write` tool to create `apps/api/src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.ts` with this exact content:

```typescript
/**
 * IdempotencyMismatchInterceptor — 005-WAVE1-METRICS-MISMATCH-FOLLOWUP PR 2.
 *
 * NestJS interceptor that intercepts the `ConflictException` thrown by the
 * 001 `IdempotencyInterceptor` when a previously-seen `Idempotency-Key` is
 * reused with a different request body (`idempotency.interceptor.ts:272-276`).
 * Uses RxJS `tap({ error: ... })` to:
 *
 *   1. Increment the catalog-domain `idempotency_token_mismatch_total`
 *      counter (FR-021c observability).
 *   2. Enqueue an audit event with action
 *      `unknown_item.idempotency_mismatch_rejected` (FR-082).
 *
 * The error continues propagating to GlobalExceptionFilter unchanged, which
 * formats the 409 envelope (Constitution §IV — honors user-supplied
 * fine-grained code "idempotency_key_conflict").
 *
 * REPLACES the prior `IdempotencyMismatchFilter` (deleted in this PR). The
 * filter pattern (async `@Catch(ConflictException)` + re-throw) was the only
 * async exception filter in the codebase with no working precedent; PR #386
 * boundary-evidence (recorded in `wave-status.md` §"Investigation update —
 * 2026-05-28 (PR #386 CI evidence)") confirmed the async re-throw never
 * propagated to GlobalExceptionFilter. This interceptor mirrors the working
 * pattern of `AuditEmitterInterceptor` (apps/api/src/audit/audit-emitter.interceptor.ts):
 * `next.handle().pipe(tap({ ... }))` + fire-and-forget enqueue. Restores
 * single-filter pipeline parity with 001's working `conflict.spec.ts`.
 *
 * Method-scoping invariant (PRESERVED from the filter): the interceptor is
 * applied ONLY via `@UseInterceptors(IdempotencyMismatchInterceptor)` on the
 * `posCaptureItem` route. Other routes on the controller (LIST, DISMISS,
 * future Wave 2 reconciliation routes) MUST NOT inherit this telemetry —
 * their 409s use different codes (e.g. `alias_conflict`) and would be
 * mis-labelled. NOT registered as `APP_INTERCEPTOR`.
 *
 * Narrow code check (PRESERVED): only fires for
 * `code === "idempotency_key_conflict"`. Other 409 codes on the capture
 * route (none today; Wave 2 may add some) pass through unchanged.
 *
 * Audit payload construction mirrors `AuditEmitterInterceptor`
 * (`audit-emitter.interceptor.ts:101-122`):
 *   - actor_user_id ← request.principal?.userId
 *   - tenant_id     ← request.context?.tenantId
 *   - store_id      ← request.context?.storeId
 *   - request_id    ← request.requestId
 *   - target_type / target_id / metadata: null (no specific target row exists)
 *
 * Fire-and-forget enqueue (FR-021c determinism):
 *   The enqueue promise is NOT awaited inside the tap-error handler. If the
 *   audit pipeline rejects (BullMQ outage, Redis disconnect), the `.catch()`
 *   on the unawaited promise logs the failure via the optional logger but
 *   does NOT alter the response shape. The 409 contract is deterministic
 *   and must not be replaced by audit-pipeline failures.
 *
 * See:
 *   spec.md FR-021c / FR-082
 *   docs/observability/signals.md §1.1 (idempotency_token_mismatch_total)
 *   wave-status.md §"Investigation update — 2026-05-28 (PR #386 CI evidence)"
 */
import {
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  Optional,
} from "@nestjs/common";
import type { Request } from "express";
import { type Observable, tap } from "rxjs";

import type { Logger } from "@data-pulse-2/shared";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../audit/audit-job.types";
import { ROOT_LOGGER } from "../../../common/logging.interceptor";
import { recordIdempotencyTokenMismatch } from "../../../observability/metrics/api.metrics";

/**
 * Shape of a request augmented by upstream interceptors. Mirrors the fields
 * `AuditEmitterInterceptor` reads — kept narrow so the interceptor doesn't
 * transitively depend on every upstream interceptor's type export.
 */
type AugmentedRequest = Request & {
  context?: { tenantId: string | null; storeId: string | null };
  principal?: { userId?: string | null };
  requestId?: string;
};

@Injectable()
export class IdempotencyMismatchInterceptor implements NestInterceptor {
  constructor(
    @Optional()
    @Inject(AUDIT_JOB_ENQUEUER)
    private readonly enqueuer: AuditJobEnqueuer | null = null,
    @Optional()
    @Inject(ROOT_LOGGER)
    private readonly logger?: Logger,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      tap({
        error: (err: unknown) => this.handleError(err, ctx),
      }),
    );
  }

  private handleError(err: unknown, ctx: ExecutionContext): void {
    // Narrow: only act on the specific 409 the IdempotencyInterceptor throws
    // on payload mismatch. Other errors (incl. other 409s on this route in
    // future waves) pass through unchanged.
    if (!(err instanceof ConflictException)) return;
    const response = err.getResponse();
    const code =
      typeof response === "object" && response !== null
        ? (response as { code?: unknown }).code
        : undefined;
    if (code !== "idempotency_key_conflict") return;

    // FR-021c observability — catalog-axis counter. The 001 platform-axis
    // counter (`recordIdempotencyConflict`) already fired inside the
    // interceptor at the collision branch.
    recordIdempotencyTokenMismatch();

    // FR-082 — catalog-domain audit subject. Fire-and-forget; never override
    // the deterministic 409 contract with audit-pipeline failures.
    // Skipped when the audit enqueuer is not wired (legacy test fixtures —
    // capture-happy-path, capture-validation, etc., which never exercise
    // the mismatch path).
    if (this.enqueuer !== null) {
      const request = ctx.switchToHttp().getRequest<AugmentedRequest>();
      const payload: AuditJobPayload = {
        actor_user_id: request.principal?.userId ?? null,
        actor_label: null,
        tenant_id: request.context?.tenantId ?? null,
        store_id: request.context?.storeId ?? null,
        action: "unknown_item.idempotency_mismatch_rejected",
        target_type: null,
        target_id: null,
        request_id: request.requestId ?? null,
        metadata: null,
      };
      this.enqueuer.enqueue(payload).catch((enqErr: unknown) => {
        this.logger?.error(
          { err: enqErr, action: payload.action },
          "IdempotencyMismatchInterceptor: enqueue failed",
        );
      });
    }
    // tap.error handler returns void; original ConflictException continues
    // propagating to GlobalExceptionFilter unchanged.
  }
}
```

- [ ] **Step 5: Run the unit spec — confirm all 5 cases pass**

```bash
pnpm --filter @data-pulse-2/api exec jest test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts --no-coverage 2>&1 | tail -20
```

Expected:
```
PASS test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts
  IdempotencyMismatchInterceptor (unit, no harness)
    ✓ IMI1: non-ConflictException error propagates unchanged with no side effects
    ✓ IMI2: non-matching 409 propagates unchanged with no side effects
    ✓ IMI3: matching 409 increments counter, enqueues audit, propagates the original error
    ✓ IMI4: matching 409 with null enqueuer still increments counter, no audit, no throw
    ✓ IMI5: matching 409 with throwing enqueuer propagates the original 409 (not the BullMQ error)

Tests:       5 passed, 5 total
```

If any case fails: STOP, do not move to Task 2. Re-read the failure carefully. Common gotchas:
- IMI3/IMI5 require `await new Promise((resolve) => setImmediate(resolve))` to drain the fire-and-forget microtask queue. Without it, the assertion on `enqueuer.calls` runs before the unawaited `.catch()` resolves.
- The `instanceof ConflictException` check requires `reflect-metadata` (imported at top of spec).

- [ ] **Step 6: Commit Task 1 work**

```bash
git add apps/api/src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.ts apps/api/test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts
git commit -m "$(cat <<'EOF'
feat(005): IdempotencyMismatchInterceptor + IMI1-5 unit coverage

Introduces IdempotencyMismatchInterceptor as the replacement for the
broken IdempotencyMismatchFilter (deleted in a later commit on this
branch). Uses RxJS tap({ error }) + fire-and-forget audit enqueue,
mirroring AuditEmitterInterceptor's working pattern.

The interceptor preserves the FR-021c wire contract byte-for-byte:
- Same 409 status, same error code (idempotency_key_conflict)
- Same idempotency_token_mismatch_total counter
- Same unknown_item.idempotency_mismatch_rejected audit subject
- Same method-scoping invariant (applied only to posCaptureItem)
- Same narrow code-check (only fires for the matching code)

IMI1-5 unit tests port the prior IMF1-5 cases 1:1, adapted for the
interceptor's intercept(ctx, next) signature. Branch-coverage contract
preserved; wave-status.md citation will be updated when the old
filter spec is deleted in a later commit on this branch.

Mechanism change justification:
  wave-status.md §"Investigation update — 2026-05-28 (PR #386 CI evidence)"
  docs/superpowers/specs/2026-05-28-005-followup-pr2-architectural-pivot-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Swap controller decorator @UseFilters → @UseInterceptors

**Files:**
- Modify: `apps/api/src/catalog/unknown-items/unknown-items.controller.ts:65-79, 280-286`

- [ ] **Step 1: Edit the controller imports (remove UseFilters, add UseInterceptors)**

Use the `Edit` tool. `old_string`:

```typescript
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
```

`new_string`:

```typescript
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
```

- [ ] **Step 2: Swap the filter import for the interceptor import**

Use the `Edit` tool. First, find the existing filter import line via `Grep` if its exact form is unclear:

```bash
# Use the Grep tool with pattern: ^import.*IdempotencyMismatchFilter
# path: apps/api/src/catalog/unknown-items/unknown-items.controller.ts
```

Then `Edit` the line. `old_string` (one example shape — verify exact via Grep first):

```typescript
import { IdempotencyMismatchFilter } from "./filters/idempotency-mismatch.filter";
```

`new_string`:

```typescript
import { IdempotencyMismatchInterceptor } from "./interceptors/idempotency-mismatch.interceptor";
```

- [ ] **Step 3: Swap the @UseFilters decorator + update its comment block**

Use the `Edit` tool. `old_string` (lines ~280-286 of current main):

```typescript
  // Method-scoped: applied only to `posCaptureItem`, not to LIST / DISMISS.
  // Class-level scoping would inherit to LIST / DISMISS (forbidden
  // per slice stop rule).
  @UseFilters(IdempotencyMismatchFilter)
  async posCaptureItem(
```

`new_string`:

```typescript
  // Method-scoped: applied only to `posCaptureItem`, not to LIST / DISMISS.
  // Class-level scoping would inherit to LIST / DISMISS (forbidden
  // per slice stop rule). Architectural pivot from @UseFilters →
  // @UseInterceptors (PR 2 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP) —
  // see specs/005-pos-catalog-sync-reconciliation/wave-status.md
  // §"Investigation update — 2026-05-28 (PR #386 CI evidence)".
  @UseInterceptors(IdempotencyMismatchInterceptor)
  async posCaptureItem(
```

- [ ] **Step 4: Verify no orphan references in the controller**

Run:

```bash
# Use the Grep tool with pattern: IdempotencyMismatchFilter|UseFilters
# path: apps/api/src/catalog/unknown-items/unknown-items.controller.ts
```

Expected: zero matches. If matches found, edit them out.

- [ ] **Step 5: Commit Task 2 work**

```bash
git add apps/api/src/catalog/unknown-items/unknown-items.controller.ts
git commit -m "$(cat <<'EOF'
refactor(005): swap controller @UseFilters → @UseInterceptors for mismatch

posCaptureItem now binds IdempotencyMismatchInterceptor via
@UseInterceptors instead of the deleted-in-this-PR IdempotencyMismatchFilter
via @UseFilters. Same method-scope, same stop-rule semantics, same
contract surface.

Part of PR 2 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP architectural pivot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Swap module provider IdempotencyMismatchFilter → IdempotencyMismatchInterceptor

**Files:**
- Modify: `apps/api/src/catalog/unknown-items/unknown-items.module.ts`

- [ ] **Step 1: Swap the import**

Use the `Edit` tool. `old_string`:

```typescript
import { IdempotencyMismatchFilter } from "./filters/idempotency-mismatch.filter";
```

`new_string`:

```typescript
import { IdempotencyMismatchInterceptor } from "./interceptors/idempotency-mismatch.interceptor";
```

- [ ] **Step 2: Update the explanatory comment + the provider entry**

Use the `Edit` tool. `old_string`:

```typescript
  // `IdempotencyMismatchFilter` is registered as a provider so NestJS
  // resolves its `AUDIT_JOB_ENQUEUER` injection from the audit module
  // (imported above). The filter is NOT registered as APP_FILTER —
  // module-global scope would run it on every route, violating the
  // slice's stop rule ("filter must not modify IdempotencyInterceptor
  // behavior on routes other than the capture route"). Method-scope
  // is applied via `@UseFilters(IdempotencyMismatchFilter)` on
  // `posCaptureItem` in `unknown-items.controller.ts`.
  // RolesGuard is registered as a plain class provider; @nestjs/core auto-
  // provides Reflector and MembershipRepository comes from ContextModule.
  providers: [UnknownItemsService, IdempotencyMismatchFilter, RolesGuard],
```

`new_string`:

```typescript
  // `IdempotencyMismatchInterceptor` is registered as a provider so
  // NestJS resolves its `AUDIT_JOB_ENQUEUER` injection from the audit
  // module (imported above). It is NOT registered as APP_INTERCEPTOR —
  // module-global scope would run it on every route, violating the
  // slice's stop rule ("interceptor must not modify behavior on routes
  // other than the capture route"). Method-scope is applied via
  // `@UseInterceptors(IdempotencyMismatchInterceptor)` on `posCaptureItem`
  // in `unknown-items.controller.ts`.
  // Architectural pivot from the prior IdempotencyMismatchFilter
  // (PR 2 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP) — see
  // specs/005-pos-catalog-sync-reconciliation/wave-status.md
  // §"Investigation update — 2026-05-28 (PR #386 CI evidence)".
  // RolesGuard is registered as a plain class provider; @nestjs/core auto-
  // provides Reflector and MembershipRepository comes from ContextModule.
  providers: [UnknownItemsService, IdempotencyMismatchInterceptor, RolesGuard],
```

- [ ] **Step 3: Verify no orphan references in the module**

Run:

```bash
# Use the Grep tool with pattern: IdempotencyMismatchFilter
# path: apps/api/src/catalog/unknown-items/unknown-items.module.ts
```

Expected: zero matches.

- [ ] **Step 4: Commit Task 3 work**

```bash
git add apps/api/src/catalog/unknown-items/unknown-items.module.ts
git commit -m "$(cat <<'EOF'
refactor(005): module provider IdempotencyMismatchFilter → Interceptor

UnknownItemsModule now provides IdempotencyMismatchInterceptor instead
of the deleted-in-this-PR IdempotencyMismatchFilter. Same DI shape
(plain provider, NOT APP_INTERCEPTOR / NOT APP_FILTER) — method-scope
remains on posCaptureItem via @UseInterceptors decorator.

Part of PR 2 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP architectural pivot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Delete the broken filter file + its unit spec

**Files:**
- Delete: `apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts`
- Delete: `apps/api/test/catalog/unknown-items/filters/idempotency-mismatch.filter.unit.spec.ts`

- [ ] **Step 1: Delete the filter source file**

```bash
git rm apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts
```

- [ ] **Step 2: Delete the filter unit spec**

```bash
git rm apps/api/test/catalog/unknown-items/filters/idempotency-mismatch.filter.unit.spec.ts
```

- [ ] **Step 3: Verify the now-empty filters/ directories are removed**

The `filters/` subdirectories (under both src/ and test/) had a single file each. After deletion they should be empty. Check:

```bash
ls apps/api/src/catalog/unknown-items/filters/ 2>&1
ls apps/api/test/catalog/unknown-items/filters/ 2>&1
```

Expected output for each:
```
ls: cannot access 'apps/api/src/catalog/unknown-items/filters/': No such file or directory
```

Git removes empty directories automatically when their last file is deleted. If the directories still exist for some reason (e.g., `.gitkeep` or other unexpected files), investigate before continuing — do NOT blindly `rmdir`.

- [ ] **Step 4: Verify no codebase references to the deleted filter remain**

Use the `Grep` tool. Pattern: `IdempotencyMismatchFilter`. Path: `apps/api` (entire workspace, both src/ and test/). Expected: zero matches anywhere.

If matches found: investigate each one. They're stale references that will break compilation. Most likely candidates are old comments referencing the filter or an alternate test harness file that wasn't on our radar.

- [ ] **Step 5: Commit Task 4 work**

```bash
git commit -m "$(cat <<'EOF'
refactor(005): delete IdempotencyMismatchFilter and its unit spec

The async exception filter pattern was the only async @Catch in the
codebase, with no working precedent. PR #386 boundary-evidence (recorded
in wave-status.md §"Investigation update — 2026-05-28 (PR #386 CI
evidence)") confirmed the async re-throw never reached
GlobalExceptionFilter, causing T532 to time out at 30s.

The replacement IdempotencyMismatchInterceptor (added in an earlier
commit on this branch) preserves the FR-021c wire contract via the
proven RxJS tap({ error }) pattern.

Branch-coverage contract preserved: IMI1-5 (in the new interceptor
unit spec) cover the same five behavioural branches as the deleted
IMF1-5. wave-status.md will be updated to cite IMI1-5 in PR 3 (the
audit-trail-cleanup follow-up).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Clean up PR #386 diagnostic scaffolding from idempotency.interceptor.ts

**Files:**
- Modify: `apps/api/src/idempotency/idempotency.interceptor.ts:29-48, 122-129, 254-276, 314-333`

Restore the file to its pre-PR-#386 shape (removes T532_DIAG blocks + the `ROOT_LOGGER` injection added solely for the diagnostic).

- [ ] **Step 1: Remove `Optional` from @nestjs/common import**

Use the `Edit` tool. `old_string`:

```typescript
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Optional,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
```

`new_string`:

```typescript
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
```

- [ ] **Step 2: Remove `type Logger` from the shared import + remove the ROOT_LOGGER import line**

Use the `Edit` tool. `old_string`:

```typescript
import { IdempotencyKeyStore, type Logger } from "@data-pulse-2/shared";
import type { StoredResult } from "@data-pulse-2/shared";

import { ROOT_LOGGER } from "../common/logging.interceptor";
import type { ResolvedContext } from "../context/types";
```

`new_string`:

```typescript
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import type { StoredResult } from "@data-pulse-2/shared";

import type { ResolvedContext } from "../context/types";
```

- [ ] **Step 3: Remove the logger constructor parameter**

Use the `Edit` tool. `old_string`:

```typescript
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_KEY_STORE) private readonly store: IdempotencyKeyStore,
    private readonly marker: InProgressMarker,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Logger,
  ) {}
```

`new_string`:

```typescript
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_KEY_STORE) private readonly store: IdempotencyKeyStore,
    private readonly marker: InProgressMarker,
  ) {}
```

- [ ] **Step 4: Remove the B1 diagnostic block**

Use the `Edit` tool. `old_string`:

```typescript
      if (stored.hit === "collision") {
        // Same key, different body — conflict.
        await this.marker.del(tuple);
        recordIdempotencyConflict({ route });
        // [T532-DIAG] PR 1 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP. Diagnostic-only.
        // Remove in PR 2 once the harness failure boundary is identified.
        if (process.env["T532_DIAG"] === "1") {
          this.logger?.debug(
            {
              event: "T532-DIAG-B1",
              boundary: "interceptor-pre-throw",
              route,
              tuple_fingerprint: keyFingerprint(tuple),
              ts: Date.now(),
            },
            "T532 diagnostic: interceptor about to throw ConflictException",
          );
        }
        throw new ConflictException({
          code: "idempotency_key_conflict",
          message:
            "The provided Idempotency-Key has already been used for a different request body. Generate a new key.",
        });
      }
```

`new_string`:

```typescript
      if (stored.hit === "collision") {
        // Same key, different body — conflict.
        await this.marker.del(tuple);
        recordIdempotencyConflict({ route });
        throw new ConflictException({
          code: "idempotency_key_conflict",
          message:
            "The provided Idempotency-Key has already been used for a different request body. Generate a new key.",
        });
      }
```

- [ ] **Step 5: Remove the B2 diagnostic block**

Use the `Edit` tool. `old_string`:

```typescript
    } catch (err) {
      // [T532-DIAG B2] PR 1 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP. Diagnostic-only.
      // Logs whether ConflictException reaches the outer try/catch on its way out.
      // Expected: this fires AFTER B1, BEFORE B3. Remove in PR 2.
      if (process.env["T532_DIAG"] === "1") {
        this.logger?.debug(
          {
            event: "T532-DIAG-B2",
            boundary: "interceptor-catch",
            err_name: (err as Error)?.name ?? "unknown",
            err_message: ((err as Error)?.message ?? "").slice(0, 80),
            ts: Date.now(),
          },
          "T532 diagnostic: exception reached interceptor outer catch",
        );
      }
      // If we set the marker but then hit a store error, clean up.
      await this.marker.del(tuple).catch(() => undefined);
      throw err;
    }
```

`new_string`:

```typescript
    } catch (err) {
      // If we set the marker but then hit a store error, clean up.
      await this.marker.del(tuple).catch(() => undefined);
      throw err;
    }
```

- [ ] **Step 6: Verify no T532_DIAG references remain in the interceptor**

Use the `Grep` tool. Pattern: `T532_DIAG|T532-DIAG`. Path: `apps/api/src/idempotency/idempotency.interceptor.ts`. Expected: zero matches.

Also verify the file no longer imports `Optional`, `type Logger`, or `ROOT_LOGGER`:

```bash
# Grep pattern: Optional|ROOT_LOGGER|type Logger
# path: apps/api/src/idempotency/idempotency.interceptor.ts
```

Expected: zero matches.

- [ ] **Step 7: Commit Task 5 work**

```bash
git add apps/api/src/idempotency/idempotency.interceptor.ts
git commit -m "$(cat <<'EOF'
chore(005): remove T532_DIAG diagnostic scaffolding from interceptor

PR #386 added env-gated pino debug logs at B1 (interceptor pre-throw) and
B2 (outer try/catch) plus an @Optional() ROOT_LOGGER inject solely for
the T532 boundary investigation. The diagnostic mission is complete
(wave-status.md §"Investigation update — 2026-05-28") and the
architectural pivot in PR 2 makes the diagnostic blocks obsolete.

Restores idempotency.interceptor.ts to its pre-PR-#386 shape modulo
unrelated drift (none expected — the file was untouched by other PRs
in this window).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update the T532 integration spec — remove diagnostics, swap filter→interceptor in harness

**Files:**
- Modify: `apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts`

The spec currently unskipped T532 + contains the PR #386 diagnostic scaffolding. Strip the diagnostics + swap the filter import in the test harness so T532 runs against the new interceptor.

- [ ] **Step 1: Remove unused `createHash` + `createLogger` imports + the doubled blank line**

Use the `Edit` tool. `old_string`:

```typescript
import "reflect-metadata";

import { createHash } from "node:crypto";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
```

`new_string`:

```typescript
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
```

- [ ] **Step 2: Restore the shared import to its pre-PR-#386 shape (remove `createLogger`)**

Use the `Edit` tool. `old_string`:

```typescript
import { createLogger, IdempotencyKeyStore } from "@data-pulse-2/shared";
```

`new_string`:

```typescript
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
```

- [ ] **Step 3: Swap the filter import for the interceptor import**

Use the `Edit` tool. `old_string`:

```typescript
import { IdempotencyMismatchFilter } from "../../../../src/catalog/unknown-items/filters/idempotency-mismatch.filter";
```

`new_string`:

```typescript
import { IdempotencyMismatchInterceptor } from "../../../../src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor";
```

- [ ] **Step 4: Remove the `diagLogger` + `diagKeyFingerprint` block**

Use the `Edit` tool. `old_string`:

```typescript
const IDEMP_KEY = "abcdef1234567890abcdef1234567890";

// [T532-DIAG] Module-local pino logger for B5 boundary diagnostics. Mirrors
// the createLogger pattern in apps/api/src/main.ts. Removed in PR 2.
const diagLogger = createLogger({ service: "test.t532.retry-mismatch" });

/**
 * [T532-DIAG] Returns a SHA-256 hex fingerprint (first 8 chars) of the
 * Idempotency-Key for safe-to-log identification. Mirrors the
 * `keyFingerprint` helper in apps/api/src/idempotency/idempotency.interceptor.ts.
 * No raw key material is logged.
 */
function diagKeyFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
const FIRST_VALUE = "T532-MISMATCH-A";
```

`new_string`:

```typescript
const IDEMP_KEY = "abcdef1234567890abcdef1234567890";
const FIRST_VALUE = "T532-MISMATCH-A";
```

- [ ] **Step 5: Remove the T532_DIAG env-var save/setup block in `beforeAll`**

Use the `Edit` tool. `old_string`:

```typescript
let mismatchSpy: jest.SpyInstance;
let dockerSkipped = false;

// [T532-DIAG] Save+restore T532_DIAG around the suite so the flag does not
// leak into other Jest workers that may share this process. Removed in PR 2
// once the failure boundary is identified.
let prevT532Diag: string | undefined;

beforeAll(async () => {
  prevT532Diag = process.env["T532_DIAG"];
  process.env["T532_DIAG"] = "1";

  try {
    env = await startPgEnv();
```

`new_string`:

```typescript
let mismatchSpy: jest.SpyInstance;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
```

- [ ] **Step 6: Remove the T532_DIAG restore block in `afterAll`**

Use the `Edit` tool. `old_string`:

```typescript
afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
  // [T532-DIAG] Restore prior T532_DIAG value so the flag does not leak.
  if (prevT532Diag === undefined) {
    delete process.env["T532_DIAG"];
  } else {
    process.env["T532_DIAG"] = prevT532Diag;
  }
}, 60_000);
```

`new_string`:

```typescript
afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);
```

- [ ] **Step 7: Swap the filter provider in the test harness for the interceptor provider**

Use the `Edit` tool. `old_string`:

```typescript
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      // The filter is registered as a provider so NestJS can resolve
      // its `AUDIT_JOB_ENQUEUER` injection. The `@UseFilters` decorator
      // on `posCaptureItem` is what actually opts the route in — same
      // wiring as production.
      IdempotencyMismatchFilter,
      // Override the AUDIT_JOB_ENQUEUER token with the spy so we can
      // assert exactly what the filter enqueued without needing
      // BullMQ / Redis. Canonical pattern per
      // `audit-emitter.interceptor.ts:15`.
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
```

`new_string`:

```typescript
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      // The interceptor is registered as a provider so NestJS can resolve
      // its `AUDIT_JOB_ENQUEUER` injection. The `@UseInterceptors` decorator
      // on `posCaptureItem` is what actually opts the route in — same
      // wiring as production. Architectural pivot from the prior
      // IdempotencyMismatchFilter (PR 2 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP).
      IdempotencyMismatchInterceptor,
      // Override the AUDIT_JOB_ENQUEUER token with the spy so we can
      // assert exactly what the interceptor enqueued without needing
      // BullMQ / Redis. Canonical pattern per
      // `audit-emitter.interceptor.ts:15`.
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
```

- [ ] **Step 8: Replace the long PR #386 diagnostic header comment + remove the B5 supertest logs**

The PR #386 commit added a multi-line comment block above the `describe(...)` block and `diagLogger.debug(...)` calls before/after the second supertest call inside the `it(...)`. Both must be removed and the original PR #339 framing simplified.

Use the `Edit` tool. `old_string` (the full diagnostic header):

```typescript
// [T532-DIAG] PR 1 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP — DIAGNOSTIC ONLY.
//
// CI RED IS EXPECTED on this PR. The unskip + diagnostic logging exist to
// collect *evidence* about where the ConflictException dies in the harness
// pipeline. PR 2 of the slice will apply the actual fix based on what the
// boundary logs reveal.
//
// What this PR does:
//   1. Removes `.skip` from the describe block below so the test runs.
//   2. Sets process.env.T532_DIAG = "1" before the suite runs so that
//      `console.log` statements at boundaries B1/B2/B3 (instrumented in
//      apps/api/src/idempotency/idempotency.interceptor.ts and
//      apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts)
//      fire under this CI run only. The env-gate keeps the diagnostics
//      inert in production and every other test suite.
//   3. Adds B5 console.log around the second supertest call to capture
//      the response (or absence thereof on timeout).
//
// The five boundary points the slice brief specified:
//   B1 — interceptor pre-throw (instrumented in interceptor.ts)
//   B2 — interceptor outer try/catch (instrumented in interceptor.ts)
//   B3 — IdempotencyMismatchFilter.catch entry (instrumented in filter.ts)
//   B4 — GlobalExceptionFilter.catch entry: NOT INSTRUMENTED in PR 1
//        because apps/api/src/common/exception.filter.ts is outside this
//        slice's allowed_files. Inferred from absence-of-B3-log.
//   B5 — supertest response receipt (instrumented below)
//
// Original PR #349 framing (preserved below for reference; per the
// FOLLOWUP brief in specs/005-pos-catalog-sync-reconciliation/wave-status.md
// §"Correction to the existing skip-block framing", the claim that
// "the harness pattern is wrong" overstated the evidence — 001's
// conflict.spec.ts uses the same Test.createTestingModule + APP_INTERCEPTOR
// + sync-throw shape and passes CI today, so the pattern itself is NOT
// broken. This diagnostic PR exists to find the actual structural
// difference between 001's working spec and this one):
//
//   Root cause (original framing, retained for context): the test harness
//   uses a no-op `IdempotencyKeyStore` pgWriter/pgReader plus a method-level
//   `@UseFilters(IdempotencyMismatchFilter)` binding on the controller. When
//   `APP_INTERCEPTOR` throws (or returns `throwError`) inside that harness,
//   the `ConflictException` escapes Jest before any filter side-effect can
//   run, causing a 30s test timeout with a bare RxJS stack trace ending at
//   `switchMap.ts` — no NestJS request frames, no supertest frames, no
//   filter frames. Fix attempts in PR #349 (`30ca9e0` interceptor
//   `throwError` shape, `951ee84` global filter binding) failed with
//   byte-identical CI output.
//
// Slice brief: specs/005-pos-catalog-sync-reconciliation/wave-status.md
// §"Slice brief — 005-WAVE1-METRICS-MISMATCH-FOLLOWUP"
describe("T532 / 005-WAVE1-IDEMP-MISMATCH — FR-021c payload-mismatch", () => {
```

`new_string`:

```typescript
// T532 / 005-WAVE1-IDEMP-MISMATCH — FR-021c payload-mismatch end-to-end.
//
// History: this spec was authored in PR #339 and merged with db-integration
// RED. Three prior fix attempts (PR #349 30ca9e0, PR #349 951ee84, and the
// b8a9dd4 revert) all failed because they targeted symptoms in the test
// harness rather than the underlying architectural issue: the
// IdempotencyMismatchFilter was the only async exception filter in the
// codebase, and its async `Promise<void>` re-throw from `catch()` did not
// propagate to GlobalExceptionFilter. PR #386's diagnostic instrumentation
// proved the failure was post-filter-catch, pre-supertest-response, leading
// to the architectural pivot in PR 2 of the FOLLOWUP slice: the filter is
// replaced by IdempotencyMismatchInterceptor (using RxJS tap({ error })),
// mirroring AuditEmitterInterceptor's working pattern.
//
// Reference: specs/005-pos-catalog-sync-reconciliation/wave-status.md
// §"Investigation update — 2026-05-28 (PR #386 CI evidence)"
//          + §"Slice brief — 005-WAVE1-METRICS-MISMATCH-FOLLOWUP"
describe("T532 / 005-WAVE1-IDEMP-MISMATCH — FR-021c payload-mismatch", () => {
```

- [ ] **Step 9: Remove the B5 pre/post-call `diagLogger.debug` calls in the test body**

Use the `Edit` tool. `old_string`:

```typescript
    // Second call — same key, DIFFERENT identifier_value. The
    // IdempotencyInterceptor detects payload mismatch and throws
    // ConflictException. The filter catches it, fires catalog
    // telemetry, re-throws. GlobalExceptionFilter formats the envelope.
    //
    // [T532-DIAG B5] Pre/post-call structured pino logs around supertest. If
    // the call times out without ever returning, only the pre-call log fires —
    // that combined with which of B1/B2/B3 also fired tells us where in the
    // pipeline the exception was swallowed. Key is logged as a SHA-256
    // fingerprint only — no raw key material.
    diagLogger.debug(
      {
        event: "T532-DIAG-B5",
        boundary: "supertest-pre-call",
        key_fingerprint: diagKeyFingerprint(IDEMP_KEY),
        value: SECOND_VALUE,
        ts: Date.now(),
      },
      "T532 diagnostic: about to issue mismatch-triggering POST",
    );
    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({
        identifier_type: "barcode",
        identifier_value: SECOND_VALUE,
      });
    diagLogger.debug(
      {
        event: "T532-DIAG-B5",
        boundary: "supertest-post-call",
        key_fingerprint: diagKeyFingerprint(IDEMP_KEY),
        status: second.status,
        body_keys: Object.keys(second.body ?? {}),
        ts: Date.now(),
      },
      "T532 diagnostic: mismatch POST returned",
    );
```

`new_string`:

```typescript
    // Second call — same key, DIFFERENT identifier_value. The
    // IdempotencyInterceptor detects payload mismatch and throws
    // ConflictException. The route-scoped IdempotencyMismatchInterceptor's
    // tap({ error }) fires catalog telemetry. GlobalExceptionFilter
    // formats the 409 envelope.
    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({
        identifier_type: "barcode",
        identifier_value: SECOND_VALUE,
      });
```

- [ ] **Step 10: Verify no PR #386 diagnostic scaffolding remains anywhere in the spec**

Use the `Grep` tool. Pattern: `T532_DIAG|T532-DIAG|diagLogger|diagKeyFingerprint|prevT532Diag|createHash|createLogger\(|IdempotencyMismatchFilter`. Path: `apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts`. Expected: zero matches.

- [ ] **Step 11: Commit Task 6 work**

```bash
git add apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts
git commit -m "$(cat <<'EOF'
test(005): port T532 integration spec to IdempotencyMismatchInterceptor

Removes all PR #386 T532_DIAG diagnostic scaffolding (the env-gate save+
restore lifecycle, the module-local pino diagLogger, the diagKeyFingerprint
helper, B5 pre/post-call structured logs, and the long diagnostic header
comment).

Swaps the test harness:
  - import IdempotencyMismatchFilter → IdempotencyMismatchInterceptor
  - providers[].IdempotencyMismatchFilter → IdempotencyMismatchInterceptor
  - explanatory comments updated

All assertion blocks remain byte-identical: status 409, error envelope
shape (code "idempotency_key_conflict"), counter call count, audit
enqueue subject "unknown_item.idempotency_mismatch_rejected", no new
unknown_items row created.

Expected outcome on CI: T532 turns GREEN after this PR's architectural
pivot. Previously RED on main since PR #386 unskipped it for diagnostic
evidence collection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Local pre-push verification + final grep sweep

**Files:** none (verification only).

- [ ] **Step 1: Final grep sweep for any orphan references**

Use the `Grep` tool. For each pattern below, expected result is **zero matches** across the entire workspace (or only matches in `docs/`, `wave-status.md`, `CHANGELOG`, or PR/commit history references — i.e., in documentation NOT in source code):

| Pattern | Acceptable matches |
|---|---|
| `IdempotencyMismatchFilter` | `docs/**`, `wave-status.md`, commit messages only |
| `T532_DIAG` | none anywhere |
| `T532-DIAG` | docs only (referencing the old PR #386 diagnostic) |
| `diagLogger` | none |
| `diagKeyFingerprint` | none |
| `UseFilters\(.*Mismatch` | none |
| `from "\./filters/idempotency-mismatch\.filter"` | none |

If any source-code match found: STOP, return to the relevant task, fix.

- [ ] **Step 2: Local TypeScript build (= implicit typecheck)**

```bash
pnpm --filter @data-pulse-2/api exec tsc -p tsconfig.build.json --noEmit 2>&1 | tail -30
```

Expected: silent success (no output, exit 0) OR `pnpm install`-required errors if `node_modules` is empty (per project memory, Docker + sometimes `node_modules` may be absent locally). If `node_modules` is missing, run `pnpm install` first (if user permission). If still failing after install, STOP and report.

- [ ] **Step 3: Run the new interceptor unit spec one more time to confirm still green**

```bash
pnpm --filter @data-pulse-2/api exec jest test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts --no-coverage 2>&1 | tail -15
```

Expected: 5/5 PASS, same as Task 1 Step 5.

- [ ] **Step 4: Confirm git tree is clean and ready to push**

```bash
git status --short --branch 2>&1
git log --oneline main..HEAD 2>&1
```

Expected branch output: `## fix/005-wave1-metrics-mismatch-followup-pr2`. Expected `git status` body: only the three known-protected untracked dirs (`bin/`, `externals/`, `.understand-anything/`), nothing else modified.

Expected commit log (7 commits since main):
```
<sha> test(005): port T532 integration spec to IdempotencyMismatchInterceptor
<sha> chore(005): remove T532_DIAG diagnostic scaffolding from interceptor
<sha> refactor(005): delete IdempotencyMismatchFilter and its unit spec
<sha> refactor(005): module provider IdempotencyMismatchFilter → Interceptor
<sha> refactor(005): swap controller @UseFilters → @UseInterceptors for mismatch
<sha> feat(005): IdempotencyMismatchInterceptor + IMI1-5 unit coverage
<sha> [GATED] chore(005): expand FOLLOWUP slice allowed_files for PR 2 pivot
<sha> docs(005): brainstormed design for PR 2 architectural pivot
```

(Spec doc commit `e5f4d97` from the brainstorming phase is the 8th commit — included via the earlier branch creation.)

---

## Task 8: [GATED] Push branch + open PR 2

**Files:** none (GitHub operation).

Per Standing Rules: never push or open PR without explicit user instruction.

- [ ] **Step 1: Surface the push + PR ask to the user**

> Local branch `fix/005-wave1-metrics-mismatch-followup-pr2` has 8 commits ready. The IMI1-5 unit suite passes locally. Branch is ready to push and open PR 2 against main. Approve `git push -u origin <branch>` + `gh pr create`?

Wait for explicit approval.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin fix/005-wave1-metrics-mismatch-followup-pr2
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --title "feat(005): [pivot] replace IdempotencyMismatchFilter with IdempotencyMismatchInterceptor" --body "$(cat <<'EOF'
## Summary

PR 2 of `005-WAVE1-METRICS-MISMATCH-FOLLOWUP`. **Architectural pivot triggered by PR #386's boundary evidence + `superpowers:systematic-debugging` Phase 4.5 (3+ failed fixes, no working precedent for the broken async-filter pattern).**

Replaces `IdempotencyMismatchFilter` (an async `@Catch(ConflictException)` exception filter — the only async exception filter in the codebase, with no working precedent) with `IdempotencyMismatchInterceptor` that uses `tap({ error: ... })` on the route handler's observable. Mirrors `AuditEmitterInterceptor`'s proven pattern. Restores single-filter pipeline parity with 001's working `apps/api/test/idempotency/conflict.spec.ts`.

## Contract surface — invariants preserved byte-for-byte

| Contract | Preserved? |
|---|---|
| 409 status on payload mismatch | ✅ |
| `error.code: "idempotency_key_conflict"` envelope shape | ✅ |
| `idempotency_token_mismatch_total` counter increment (FR-021c) | ✅ |
| `unknown_item.idempotency_mismatch_rejected` audit subject (FR-082) | ✅ |
| Method-scope to `posCaptureItem` only (Wave 1 stop rule) | ✅ |
| Narrow code-check (only acts on `idempotency_key_conflict`) | ✅ |
| FR-021c determinism (no contract impact from audit failures) | ✅ |

**Only the mechanism changes: async filter + re-throw → sync interceptor + RxJS `tap({ error })` + fire-and-forget enqueue.**

## Changes

| File | Action |
|---|---|
| `specs/005-pos-catalog-sync-reconciliation/execution-map.yaml` | `[GATED]` allowed_files expansion (user authorised 2026-05-28) |
| `apps/api/src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.ts` | new file — the interceptor (mirrors `AuditEmitterInterceptor`) |
| `apps/api/test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts` | new file — IMI1-5 ported from prior IMF1-5 |
| `apps/api/src/catalog/unknown-items/unknown-items.controller.ts` | swap `@UseFilters(...Filter)` → `@UseInterceptors(...Interceptor)` |
| `apps/api/src/catalog/unknown-items/unknown-items.module.ts` | swap filter provider → interceptor provider |
| `apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts` | **DELETED** |
| `apps/api/test/catalog/unknown-items/filters/idempotency-mismatch.filter.unit.spec.ts` | **DELETED** |
| `apps/api/src/idempotency/idempotency.interceptor.ts` | remove PR #386 T532_DIAG scaffolding + `ROOT_LOGGER` inject |
| `apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts` | remove PR #386 diagnostics; swap filter → interceptor in test harness |

## Why the pivot (not "add 2 more logs")

The original FOLLOWUP brief proposed PR 2 = "add B3.5 + B4 + read discriminator matrix". PR #386's CI evidence showed all 4 PR-1 boundaries fire in order within 30ms, then 30s timeout — confirming the exception reaches the filter but the filter's async re-throw never propagates to GlobalExceptionFilter. A Phase 2 pattern-analysis revealed `IdempotencyMismatchFilter` is the ONLY async exception filter in the entire codebase: `grep -r "async catch" apps/api/src` returns this file alone. **No working precedent.**

Per `superpowers:systematic-debugging` Phase 4.5 (3+ failed fixes in PR #349 + each fix revealing new problems): "STOP and question the architecture. This is NOT a failed hypothesis — this is a wrong architecture." Adding B3.5 + B4 would have been fix #4 in disguise.

`AuditEmitterInterceptor` (`apps/api/src/audit/audit-emitter.interceptor.ts:89-97`) shows the working pattern in the codebase for cross-cutting telemetry on the request pipeline: `next.handle().pipe(tap({...}))` + fire-and-forget enqueue + `@Optional() @Inject(ROOT_LOGGER)`. The new mismatch interceptor mirrors that exactly.

## Process trail

- `superpowers:using-superpowers` invoked at session continuation
- `superpowers:systematic-debugging` — Phase 1 complete from PR #386 evidence; Phase 2 revealed no working precedent; Phase 4.5 triggered architectural question
- `superpowers:brainstorming` — design doc at `docs/superpowers/specs/2026-05-28-005-followup-pr2-architectural-pivot-design.md` (committed as `e5f4d97` on this branch)
- `superpowers:writing-plans` — plan at `docs/superpowers/plans/2026-05-28-005-followup-pr2-architectural-pivot.md`

## Test plan

- [ ] CI `fast` job green
- [ ] CI `db-integration` job green
  - [ ] `retry-mismatch.spec.ts` T532 case turns GREEN (was RED on main since PR #386)
  - [ ] All 191 spec files in api workspace still pass (5 cases of new IMI unit spec; no other suite altered)
  - [ ] Branch-coverage gate (90% global) passes
- [ ] CodeRabbit review acceptable (front-loaded contract-guarantee summary should pre-empt mechanism-change concerns)

## Out-of-scope (deferred to PR 3 of the slice)

- T550: new file `apps/api/test/catalog/unknown-items/audit/idempotency-mismatch-audit.spec.ts` (integration coverage for the audit emission)
- T552-mismatch-case: unskip the currently-skipped case in `apps/api/test/catalog/unknown-items/audit/metrics.spec.ts`
- wave-status.md update to cite IMI1-5 instead of IMF1-5 in the branch-coverage notes

PR 3 will land after PR 2's CI confirms the architectural pivot is correct.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Confirm PR URL + report to user**

The `gh pr create` output includes the PR URL. Capture it and report to the user as the completion signal.

---

## Self-review notes

- **Spec coverage:** every section of the design doc maps to a task. Section 1 (architecture) → Tasks 1+2+3+6. Section 2 (components) → Tasks 1-6 split file-by-file. Section 3 (data flow) → Task 1 (interceptor implementation reflects the tap.error path). Section 4 (error handling) → Task 1 IMI1-5 cover all 5 edge cases. Section 5 (testing) → Tasks 1 (unit) + 6 (integration spec port) + 7 (verification). Section 6 (risks/sequencing/unknowns) → tasks ordered per the design doc's sequencing block; R1 surfaces in Task 1 Step 5 (rerun spec); R2 covered by Task 7 Step 1 grep sweep; R3 (CodeRabbit) covered by the PR body in Task 8.
- **Placeholder scan:** zero TBDs, no "implement appropriate error handling", no "similar to Task N". Each commit message and each diff is concrete.
- **Type consistency check:** `IdempotencyMismatchInterceptor` constructor signature stays `(enqueuer: AuditJobEnqueuer | null, logger?: Logger)` across Task 1 implementation + Task 1 unit spec + Task 3 module provider + Task 6 integration spec. `intercept(ctx, next)` signature consistent. Audit payload field names (`action`, `tenant_id`, `store_id`, `actor_user_id`, `request_id`, `target_type`, `target_id`, `metadata`) consistent across IMI3 assertion and the interceptor implementation. Counter name `recordIdempotencyTokenMismatch` consistent.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-28-005-followup-pr2-architectural-pivot.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good fit because the plan has 9 tasks (0-8) with clean boundaries.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review. Lower context-switching cost, but the session is getting long.

**Which approach?**
