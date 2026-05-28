# 005-WAVE1-METRICS-MISMATCH-FOLLOWUP — PR 2 architectural pivot

**Date**: 2026-05-28
**Slice**: `005-WAVE1-METRICS-MISMATCH-FOLLOWUP`
**Author**: brainstormed via `superpowers:brainstorming` skill, after Phase 4.5 architectural-question trigger from `superpowers:systematic-debugging` skill
**Status**: design — awaiting user review before transitioning to `superpowers:writing-plans`

## Context

PR #386 (commit `1e759b9`, the diagnostic) and PR #387 (commit `5dcb12f`, the investigation update) are merged on `main`. PR #387's investigation update (`specs/005-pos-catalog-sync-reconciliation/wave-status.md`) records that all four PR-1 instrumented boundaries (B5-pre, B1, B2, B3) fire in order within 30 ms of the second supertest call, then the test idles until a 30 s timeout. The `ConflictException` reaches `IdempotencyMismatchFilter.catch()` cleanly; the response never reaches supertest.

The investigation refuted all three hypotheses on the original FOLLOWUP brief's hypothesis ladder, narrowing the failure to **post-B3, pre-B5-post-call**.

A Phase 2 pattern-analysis check (per `superpowers:systematic-debugging` skill) found:
- `IdempotencyMismatchFilter` is the **only async exception filter** in the entire codebase (`grep -r "async catch" apps/api/src` returns this file alone).
- There is **no working precedent** for the `@UseFilters(asyncFilter)` + re-throw pattern in this codebase.
- PR #349 produced 3 prior failed fix attempts (`30ca9e0`, `951ee84`, `b8a9dd4` revert).
- The skill's Phase 4.5 rule: 3+ failed fixes + each fix revealing new evidence ≠ "another fix to try" but "wrong architecture, question fundamentals."

This document captures the architectural-pivot design that resolves the FOLLOWUP slice without further filter-chain instrumentation.

## Goal

Restore single-filter pipeline parity with 001's `apps/api/test/idempotency/conflict.spec.ts` (which uses the same `Test.createTestingModule + APP_INTERCEPTOR + sync throw` shape and **passes CI today**). Achieve this by replacing the broken async exception filter with a route-scoped interceptor that uses `tap({ error: ... })` for catalog-domain telemetry — mirroring `AuditEmitterInterceptor`'s working pattern.

## Non-goals

- **Not** instrumenting B3.5 + B4 boundaries (the matrix-discrimination path documented in PR #387). The architectural pivot makes the matrix moot.
- **Not** modifying `IdempotencyInterceptor`'s production behavior. Only removing the PR-1 diagnostic blocks.
- **Not** modifying `GlobalExceptionFilter`. The 409 envelope-formatting path stays unchanged.
- **Not** modifying the 409 wire contract (FR-021c determinism). Same status code, same error code, same envelope shape, same idempotency-token-mismatch counter name, same `unknown_item.idempotency_mismatch_rejected` audit subject.

## Architecture

### Before (broken)

```text
Request → APP_INTERCEPTOR (IdempotencyInterceptor)
       → @UseFilters(IdempotencyMismatchFilter)   ← async catch + re-throw never propagates
       → GlobalExceptionFilter (never reached)
       → supertest (timeout at 30s)
```

The async filter's `Promise<void>` rejection from `throw exception` does not reliably chain to the next exception filter in this codebase's NestJS configuration. The mechanism has no working precedent here.

### After (mirrors `AuditEmitterInterceptor`)

```text
Request → APP_INTERCEPTOR (IdempotencyInterceptor)            ← throws ConflictException
       → @UseInterceptors(IdempotencyMismatchInterceptor)     ← tap({ error: ... }) fires telemetry,
                                                                error continues unchanged
       → GlobalExceptionFilter (receives exception cleanly)
       → 409 envelope → supertest
```

The route-level interceptor's `tap({ error: ... })` observes the error without catching it; the error continues propagating to `GlobalExceptionFilter` exactly as in 001's working `conflict.spec.ts`.

## Components

Six files touched; three are in current `allowed_files`, three are new paths needing `[GATED]` `allowed_files` expansion in `execution-map.yaml`.

| File | Action | In `allowed_files`? |
|---|---|---|
| `apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts` | DELETE | yes |
| `apps/api/src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.ts` | CREATE | no (new path) |
| `apps/api/src/catalog/unknown-items/unknown-items.controller.ts` | EDIT — swap `@UseFilters` → `@UseInterceptors`; update imports + comment block (lines 280-285) | no — `[GATED]` |
| `apps/api/src/catalog/unknown-items/unknown-items.module.ts` | EDIT — swap filter provider → interceptor provider; update imports + comment block (lines 64-71) | no — `[GATED]` |
| `apps/api/test/catalog/unknown-items/filters/idempotency-mismatch.filter.unit.spec.ts` | DELETE | no — `[GATED]` |
| `apps/api/test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts` | CREATE | no (new path) |
| `apps/api/src/idempotency/idempotency.interceptor.ts` | EDIT — remove `T532_DIAG` B1+B2 blocks, `ROOT_LOGGER` inject, `Optional` import | yes |
| `apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts` | EDIT — remove all PR-1 diagnostic scaffolding; swap filter import → interceptor import in harness | yes |

`[GATED]` execution-map.yaml edit covers four new path entries:

```yaml
allowed_files:
  - apps/api/test/catalog/unknown-items/audit/metrics.spec.ts
  - apps/api/test/catalog/unknown-items/audit/idempotency-mismatch-audit.spec.ts
  - apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts
  - apps/api/src/idempotency/idempotency.interceptor.ts
  - apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts        # to be deleted
  - apps/api/src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.ts  # NEW
  - apps/api/src/catalog/unknown-items/unknown-items.controller.ts                   # NEW
  - apps/api/src/catalog/unknown-items/unknown-items.module.ts                       # NEW
  - apps/api/test/catalog/unknown-items/filters/idempotency-mismatch.filter.unit.spec.ts  # to be deleted
  - apps/api/test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts  # NEW
```

## Interceptor design

### File: `apps/api/src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.ts`

```ts
import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
} from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";
import type { Request } from "express";
import { Observable, tap } from "rxjs";

import { ROOT_LOGGER } from "../../../common/logging.interceptor";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../audit/audit-job.types";
import { recordIdempotencyTokenMismatch } from "../../../observability/metrics/api.metrics";

type AugmentedRequest = Request & {
  context?: { tenantId: string | null; storeId: string | null };
  principal?: { userId?: string | null };
  requestId?: string;
};

@Injectable()
export class IdempotencyMismatchInterceptor implements NestInterceptor {
  constructor(
    @Optional() @Inject(AUDIT_JOB_ENQUEUER)
    private readonly enqueuer: AuditJobEnqueuer | null = null,
    @Optional() @Inject(ROOT_LOGGER)
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

    // FR-021c observability — catalog-axis counter.
    recordIdempotencyTokenMismatch();

    // FR-082 — catalog-domain audit subject. Fire-and-forget; never override
    // the deterministic 409 contract with audit-pipeline failures.
    // Skipped when the audit enqueuer is not wired (legacy test fixtures).
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
    // propagating to GlobalExceptionFilter.
  }
}
```

### Invariants the interceptor preserves

1. **FR-021c determinism**: 409 status, `code: "idempotency_key_conflict"`, envelope from `GlobalExceptionFilter`, never replaced by audit/counter failures.
2. **Method scoping**: only fires on routes annotated with `@UseInterceptors(IdempotencyMismatchInterceptor)` — currently just `posCaptureItem`. The Wave 1 stop rule ("filter must not modify behavior on routes other than capture") is preserved by decorator scope, identical to the old filter's `@UseFilters` scoping.
3. **Narrow code check**: only fires for `code === "idempotency_key_conflict"`. Future Wave 2 conflicts (alias-conflict, etc.) on the same route use different codes and pass through.
4. **Side-effect order**: counter increments BEFORE audit enqueue. Same order as the old filter. Counter is sync (prom-client increment); audit is fire-and-forget.
5. **No exception swallowing**: the tap-error handler returns `void`. The error continues to propagate. Never `return throwError(...)`, never `throw`, never any operator that could substitute the error.

## Controller edit

`apps/api/src/catalog/unknown-items/unknown-items.controller.ts`:

```diff
-import {
-  ...
-  UseFilters,
-  UseGuards,
-} from "@nestjs/common";
+import {
+  ...
+  UseGuards,
+  UseInterceptors,
+} from "@nestjs/common";

-import { IdempotencyMismatchFilter } from "./filters/idempotency-mismatch.filter";
+import { IdempotencyMismatchInterceptor } from "./interceptors/idempotency-mismatch.interceptor";

   ...
   // Method-scoped: applied only to `posCaptureItem`, not to LIST / DISMISS.
-  // Class-level scoping would inherit to LIST / DISMISS (forbidden
-  // per slice stop rule).
-  @UseFilters(IdempotencyMismatchFilter)
+  // Class-level scoping would inherit to LIST / DISMISS (forbidden
+  // per slice stop rule). The interceptor pattern replaces the prior
+  // @UseFilters(IdempotencyMismatchFilter) — see PR #387 wave-status.md
+  // §"Investigation update — 2026-05-28 (PR #386 CI evidence)".
+  @UseInterceptors(IdempotencyMismatchInterceptor)
   async posCaptureItem(
```

## Module edit

`apps/api/src/catalog/unknown-items/unknown-items.module.ts`:

```diff
-import { IdempotencyMismatchFilter } from "./filters/idempotency-mismatch.filter";
+import { IdempotencyMismatchInterceptor } from "./interceptors/idempotency-mismatch.interceptor";

   ...
-  // `IdempotencyMismatchFilter` is registered as a provider so NestJS
-  // resolves its `AUDIT_JOB_ENQUEUER` injection from the audit module
-  // (imported above). The filter is NOT registered as APP_FILTER —
-  // module-global scope would run it on every route, violating the
-  // slice's stop rule ("filter must not modify IdempotencyInterceptor
-  // behavior on routes other than the capture route"). Method-scope
-  // is applied via `@UseFilters(IdempotencyMismatchFilter)` on
-  // `posCaptureItem` in `unknown-items.controller.ts`.
+  // `IdempotencyMismatchInterceptor` is registered as a provider so
+  // NestJS resolves its `AUDIT_JOB_ENQUEUER` injection from the audit
+  // module (imported above). It is NOT registered as APP_INTERCEPTOR —
+  // module-global scope would run it on every route, violating the
+  // slice's stop rule. Method-scope is applied via
+  // `@UseInterceptors(IdempotencyMismatchInterceptor)` on
+  // `posCaptureItem` in `unknown-items.controller.ts`.
+  // Replaces the prior IdempotencyMismatchFilter — see PR #387
+  // wave-status.md §"Investigation update — 2026-05-28".
-  providers: [UnknownItemsService, IdempotencyMismatchFilter, RolesGuard],
+  providers: [UnknownItemsService, IdempotencyMismatchInterceptor, RolesGuard],
```

## Testing

### Unit-spec port (IMF1-5 → IMI1-5)

`apps/api/test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts` — new file. Five cases ported from the old filter unit spec, adapted to the interceptor's `intercept(ctx, next)` signature. Mirrors the harness shape of `audit-emitter.interceptor.unit.spec.ts` (a known working comparator in the repo).

| Case | Behavioral assertion |
|---|---|
| IMI1 | Non-`ConflictException` error → no side effects; error propagates unchanged |
| IMI2 | `ConflictException` with non-matching code → no side effects; error propagates unchanged |
| IMI3 | Matching 409 → counter increments exactly once + audit enqueued exactly once + original error propagates unchanged |
| IMI4 | Matching 409 with `enqueuer === null` → counter still increments; no audit call; no throw |
| IMI5 | Matching 409 with enqueuer that throws → counter still increments; error caught by `.catch()`; original ConflictException propagates unchanged |

### Integration spec (`retry-mismatch.spec.ts`) turns GREEN

Edits:
- Remove `T532_DIAG` env-var save+restore (in `beforeAll` + `afterAll`).
- Remove `diagKeyFingerprint` helper + `import { createHash }` + `import { createLogger }`.
- Remove all B5 `diagLogger.debug(...)` calls and the diagnostic comment block (lines 335-390 ish — the PR #386 framing).
- Swap `import { IdempotencyMismatchFilter }` → `import { IdempotencyMismatchInterceptor }`.
- Swap `IdempotencyMismatchFilter` in the `providers` array → `IdempotencyMismatchInterceptor`.
- Existing `mismatchSpy` (spies on `recordIdempotencyTokenMismatch`) unchanged.
- Existing `auditSpy` (`SpyAuditEnqueuer`) unchanged.
- All existing assertions stay byte-identical (status 409, error envelope shape, counter call count, audit call count, audit subject, no row created, etc.).
- `describe` (not `describe.skip`) retained from PR #386 since this is now expected GREEN.

### Interceptor cleanup in `idempotency.interceptor.ts`

- Remove `T532_DIAG` B1 block (lines ~258-272 of current state on main).
- Remove `T532_DIAG` B2 block (lines ~316-329 of current state on main).
- Remove `@Optional() @Inject(ROOT_LOGGER) private readonly logger?: Logger` constructor parameter.
- Remove `Optional` from `@nestjs/common` import.
- Remove `type Logger` from `@data-pulse-2/shared` import (revert to plain `IdempotencyKeyStore` import).
- Remove `import { ROOT_LOGGER } from "../common/logging.interceptor";`.

Result: `idempotency.interceptor.ts` reverts to its pre-PR-#386 shape.

### Validation

CI (db-integration) is the authoritative validator. Docker unavailable locally per project memory.

Validation command from `execution-map.yaml` line 890 (unchanged):

```bash
pnpm --filter @data-pulse-2/api test "test/catalog/unknown-items/audit/metrics" \
  "test/catalog/unknown-items/audit/idempotency-mismatch-audit" \
  "test/catalog/unknown-items/idempotency/retry-mismatch"
```

Expected: GREEN on T532 (retry-mismatch.spec.ts). T552-mismatch-case (currently `describe.skip` in `metrics.spec.ts`) and T550 (the new `idempotency-mismatch-audit.spec.ts` file) are **explicitly out of scope for PR 2** — they belong to PR 3, after PR 2's CI confirms the architectural pivot is correct. Sequencing: get the harness right first, then layer on T550 + T552 coverage in a follow-up.

Branch-coverage gate (90% global threshold): expected to PASS because the new interceptor's branches are covered by IMI1-5 unit cases.

## Risks

### R1: `tap.error` semantics interact with `from(promise).switchMap()`

`IdempotencyInterceptor.intercept()` returns `from(this.handle(...)).pipe(switchMap(obs => obs))`. When `handle()` rejects (collision branch), the rejection becomes an `error` notification on the outer observable. The new `IdempotencyMismatchInterceptor`'s `tap({ error: ... })` should fire on that notification because route-level interceptors wrap *inside* APP_INTERCEPTOR.

**Confidence**: high (matches RxJS docs and the working `AuditEmitterInterceptor` precedent), but **empirically unconfirmed** until CI runs.

**Fallback** if CI shows tap-error doesn't fire: use `catchError(err => { sideEffect(err); return throwError(() => err); })` instead. Functionally equivalent but more verbose.

### R2: Orphan references after filter deletion

Removing `IdempotencyMismatchFilter` leaves potential stale references in: controller imports, controller comments, module imports, module comments, possibly elsewhere.

**Mitigation**: post-edit grep verifies zero occurrences of `IdempotencyMismatchFilter` and `UseFilters\(.*Mismatch`. Run before commit.

### R3: CodeRabbit may flag the architectural shift

CodeRabbit's ASSERTIVE profile tends to flag mechanism-changing refactors. The PR body must front-load:
1. The contract guarantees that *do not* change (FR-021c determinism, 409 wire shape, counter name, audit subject).
2. `AuditEmitterInterceptor` as the working precedent for `tap.error` + fire-and-forget.
3. PR #387's wave-status.md investigation update as the architectural-pivot justification (Phase 4.5 of `superpowers:systematic-debugging`).
4. The single-filter pipeline parity with 001's working `conflict.spec.ts`.

## Sequencing

Single PR (PR 2 of the FOLLOWUP slice):

1. Surface `[GATED]` ask for `execution-map.yaml` `allowed_files` expansion (4 new paths). Wait for explicit approval.
2. Apply approved `execution-map.yaml` edit.
3. Create `apps/api/src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.ts`.
4. Create `apps/api/test/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor.unit.spec.ts` (TDD-style: write IMI1-5 first).
5. Edit `apps/api/src/catalog/unknown-items/unknown-items.controller.ts`.
6. Edit `apps/api/src/catalog/unknown-items/unknown-items.module.ts`.
7. Delete `apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts`.
8. Delete `apps/api/test/catalog/unknown-items/filters/idempotency-mismatch.filter.unit.spec.ts`.
9. Edit `apps/api/src/idempotency/idempotency.interceptor.ts` (remove PR-1 diagnostics).
10. Edit `apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts` (remove diagnostics; swap filter→interceptor in harness).
11. Grep verification: zero occurrences of `IdempotencyMismatchFilter`, `UseFilters\(.*Mismatch`, `T532_DIAG`.
12. Commit + push + open PR.

## Unknowns flagged in PR body

- R1's empirical confirmation comes only from CI.
- The IMF1-5 → IMI1-5 port may reveal that one or two cases don't have an interceptor-shaped equivalent. Any divergence is noted in the PR.

## Related work

- PR #386 (merged at `773d5aa`) — diagnostic instrumentation that produced the boundary-signature evidence.
- PR #387 (merged at `5dcb12f`) — wave-status.md investigation update with discriminator matrix (now superseded by this architectural pivot).
- Working comparators in codebase:
  - `apps/api/test/idempotency/conflict.spec.ts` — 001's working single-filter integration spec.
  - `apps/api/src/audit/audit-emitter.interceptor.ts` — the `tap({ next/error: ... })` + fire-and-forget pattern this design mirrors.

## Process trail

- `superpowers:using-superpowers` → invoked at session continuation.
- `superpowers:systematic-debugging` → Phase 1 (complete from PR #386 evidence), Phase 2 (pattern analysis revealed no working precedent for async-filter pattern), Phase 4.5 trigger (3+ failed fixes + architectural problem signature).
- `superpowers:brainstorming` → this document.
- Next: `superpowers:writing-plans` (after user spec review).
