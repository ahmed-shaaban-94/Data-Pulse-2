# Implementation Tasks: POS Catalog Sync & Unknown Item Reconciliation — Wave 1 (Capture path)

**Feature ID**: 005
**Wave**: 1 of 2 (Capture path — US1 + US4 + US5 + dismiss)
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) · **Quickstart**: [quickstart.md](./quickstart.md) · **Contracts**: [contracts/README.md](./contracts/README.md)
**Constitution**: v3.0.1 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md))
**Branch**: `tasks/005-wave-1-capture`
**Status**: Draft (planning only — no code authored)
**Created**: 2026-05-23
**Owner**: Ahmed Shaaban

---

> **READ THIS FIRST — Wave 1 scope only**
>
> Per [plan.md §8](./plan.md#8-implementation-phasing-advisory--speckit-tasks-is-the-next-command), 005 implementation is split into two waves:
>
> - **Wave 1** (this `tasks.md`): US1 capture, US4 idempotency, US5 audit. **Plus** the dismiss action from US2 scenario #3 — see "Dismiss boundary decision" below.
> - **Wave 2** (a future `tasks.md` or this one extended): US2 link + create-new reconciliation, US3 alias-conflict fail-closed. **Blocked on `PHASE3_RED_WAVE`** (specifically T350 + T383 from `specs/003-catalog-foundation/execution-map.yaml`).
>
> This document covers Wave 1 only. **Do not start any reconciliation work (link / create-new) from this document.** When Wave 2 unblocks, that work gets its own task generation pass referencing this completed Wave 1 as a predecessor.

> **Dismiss boundary decision** (advisor consultation, 2026-05-23):
>
> Dismiss is technically in US2 #3 per the spec, but it only UPDATEs `unknown_items.resolution_status='dismissed'` — it has **no dependency on T350 or T383** (the gating prerequisites for link / create-new). So dismiss is unblocked.
>
> **Decision: pull dismiss into Wave 1.** It joins US5 audit + observability in Phase 5 below. Rationale: Wave 1's audit story is more complete if it covers capture + dismiss + idempotency-mismatch subjects together, rather than emitting capture / mismatch in Wave 1 and dismiss in Wave 2 alone. This also matches the spec's lifecycle (FR-001–FR-005) which treats `dismissed` as a first-class terminal state alongside `resolved`.
>
> Linking and create-new remain firmly in Wave 2.

> **Scope reminder** (from spec §3 + §12 + plan §9):
>
> - No code in `apps/worker/**`, no dashboard UI, no POS app code.
> - No new SQL migrations (Wave 1 introduces zero schema work — confirmed by data-model.md §5).
> - No edits to `specs/003-catalog-foundation/**` (read-only for 005).
> - The contract YAML is gated — see §2 below.

---

## 1. Conventions

| Marker / pattern | Meaning |
|---|---|
| `T###` | Task identifier — globally unique within this feature. **Numbering starts at `T500`** to avoid collision with 001's `T001–T299`, 002's `T200–T299`, 003's `T300–T499`. Wave 2 (a future tasks.md) is expected to use `T600–T699`. |
| `[P]` | Parallel-safe — task touches **no file that another `[P]` task in the same group touches**. May run concurrently within a group. |
| `[GATED]` | Approval-gated — execution requires explicit owner approval per Constitution §VIII + Standing Rules §3 (touches OpenAPI YAML, SQL migrations, `package.json`, `pnpm-lock.yaml`, CI workflows, or other listed forbidden surfaces). Listed centrally in §2 below. |
| `[FR-#]` | Anchors a task to one or more spec §6 functional requirements it must preserve. |
| `[SI-#]` | Anchors a task to one or more spec §7 security/isolation requirements. |
| `[US#]` | User story label — required on user-story phase tasks per Spec Kit convention. Setup / Foundational / Polish phases carry NO `[US#]` label. |
| `[TC]` | Requires Testcontainers-backed Postgres (real RLS / DDL). Constitution §VI. |
| `RED` | Test task that initially fails (no implementation yet). Always precedes its `GREEN` pair. |
| `GREEN` | Implementation task that makes a prior `RED` test pass. Lists the `RED` task as predecessor. |
| File paths | Exact target path on disk. Authoring belongs to the implementation task, not this planning document. |

**Task line shape**: `- [ ] T### [P?] [US#?] Description with exact file path · constraints carried · predecessors`

---

## 2. Approval-gated tasks (`[GATED]`)

Per Constitution §VIII and [`docs/agent-os/standing-rules.md §3`](../../docs/agent-os/standing-rules.md), the following tasks touch files that require **explicit owner approval before any tool edits them**. Listed here so approval can be requested once for the whole set.

| Task | Reason for gating |
|---|---|
| `T503 [GATED]` — author OpenAPI YAML `packages/contracts/openapi/catalog/unknown-items.yaml` for Wave 1 operationIds (`posCaptureItem`, `tenantAdminListUnknownItems`, `tenantAdminDismissUnknownItem`) | OpenAPI YAML — `packages/contracts/openapi/**` is a forbidden surface |
| `T504 [GATED]` — register the YAML in `packages/contracts/openapi/index.ts` (if it exists) and the conformance-test entrypoint | OpenAPI directory of record |

**No new SQL migrations are gated for Wave 1.** Data-model.md §5 explicitly enumerates "no new tables, no new columns, no new indexes, no new constraints, no new RLS policies, no new SQL migration files". Any Wave 1 task that would touch `packages/db/drizzle/**` or `packages/db/src/schema/**` is a defect — stop the slice and report.

**No `package.json` / `pnpm-lock.yaml` changes are gated for Wave 1.** Plan §1.1 confirms no new runtime dependencies. Any Wave 1 task that would touch these is a defect — stop.

**No `.github/**` changes.** No CI workflow edits for Wave 1.

---

## 3. User scenarios in scope for Wave 1

Mapped from spec §5 to Wave 1's task phases:

| US# | Scenario (spec §5) | Phase | Notes |
|---|---|---|---|
| **US1** | POS captures an unknown item without breaking the sale | Phase 3 | P1 — full coverage |
| **US4** | Repeats and retries are idempotent | Phase 4 | P2 — full coverage including FR-021a/b/c |
| **US5** | Reconciliation actions are fully auditable | Phase 5 | P2 — Wave 1 subset: capture / dismiss / idempotency-mismatch subjects (link / create-new subjects defer to Wave 2) |
| **US2 #3 (dismiss only)** | Tenant admin dismisses an unknown item as invalid | Phase 5 | Pulled into Wave 1 per "Dismiss boundary decision" above |
| **US2 #1, #2 (link, create-new)** | — | **NOT IN WAVE 1** | Blocked on `PHASE3_RED_WAVE` — defer to Wave 2 |
| **US3** | Alias conflicts fail closed | **NOT IN WAVE 1** | Reconciliation-only — defer to Wave 2 |

---

## 4. Phase 1 — Setup (shared infrastructure)

**Purpose**: Establish 005 module skeleton and register Wave 1 catalog metrics in the existing observability surface. No business logic yet.

> **Note** (post-review spike, 2026-05-23): the original draft listed an `audit-subjects.ts` registration task. **There is no such registry on this repo.** Audit subjects are passed inline to the `@Auditable(action)` decorator (see `apps/api/src/audit/auditable.decorator.ts`); the `AuditEmitterInterceptor` reads the metadata and emits one event per successful response. No pre-registration is needed — subjects come into existence at the decorator-application site. The original T501 collapsed entirely.

- [ ] T500 Create `apps/api/src/catalog/unknown-items/` module directory and an empty `unknown-items.module.ts` skeleton (NestJS `@Module({})` stub with no providers yet). Predecessors: none. Acceptance: file exists, exports a `UnknownItemsModule` class, compiles.
- [ ] T501 [P] Register the three new Wave-1-owned Prometheus counters in `apps/api/src/observability/metrics/api.metrics.ts` (verified path; this is the file the existing `IdempotencyInterceptor` already imports from, see `apps/api/src/idempotency/idempotency.interceptor.ts:62`): `unknown_item_captured_total`, `unknown_item_resolved_total` (with `action` label ∈ `{linked, created, dismissed}` — Wave 1 only emits `dismissed`), `idempotency_token_mismatch_total`. Predecessors: none. Acceptance: three new counters exported with the existing exporter; existing counters (`recordIdempotencyConflict`, `recordIdempotencyReplay`, `recordIdempotencyInProgress`, etc.) are NOT modified.

**Checkpoint after Phase 1**: Module skeleton exists; the three Wave 1 counters are registered. Audit subjects are declared inline via `@Auditable(action)` decorators at the controller-method sites in subsequent phases — no central registry to update. No HTTP endpoints, no business logic, no DB writes.

---

## 5. Phase 2 — Foundational (blocking prerequisites for all user stories)

**Purpose**: Establish the surfaces every US1/US4/US5 task depends on — the gated contract YAML, the idempotency-service wrapper, and the isolation-harness extension. **No US-phase task can start until this phase is complete.**

### 5.1 Gated contract slice (`[GATED]`)

Per plan §8.3 and Standing Rules §3.

- [ ] T503 [GATED] Request explicit approval, then author `packages/contracts/openapi/catalog/unknown-items.yaml` defining the three Wave 1 operationIds: `posCaptureItem` (POST capture; declares `Idempotency-Key` header per the existing `IdempotencyInterceptor` convention, NOT `Idempotency-Token` from the spec draft), `tenantAdminListUnknownItems` (GET list), `tenantAdminDismissUnknownItem` (POST dismiss). Schemas align with [data-model.md §2.1 + §2.2](./data-model.md), failure responses follow [research.md §R2 taxonomy](./research.md#r2--failure-mode-taxonomy-mapping-each-failure-to-fr-091-categories), idempotency contract per FR-021/021a/021b/021c (with header-name alignment recorded in T564 closeout). Predecessors: T500, T501. Acceptance: YAML lints clean against the existing OpenAPI validator; conformance test stub exists.
- [ ] T504 [GATED] [P] If `packages/contracts/openapi/index.ts` (or the conformance-test entrypoint) maintains a list of YAMLs, register `catalog/unknown-items.yaml` there. Verify file path during execution; if the project auto-discovers YAML files no registration is needed (mark task complete-no-op). Predecessors: T503. Acceptance: YAML is discoverable by existing conformance tests.

### 5.2 Idempotency — verify the existing primitive covers Wave 1's needs

> **Note** (post-review spike, 2026-05-23): the original draft of this section proposed a `PosCaptureIdempotencyService` wrapper around 001's interceptor. **The existing primitive already covers FR-021 / FR-021a / FR-021b / FR-021c directly** — verified against `apps/api/src/idempotency/idempotency.interceptor.ts`:
>
> - **Dedup tuple** is `${method}:${route}:${clientId}:${key}` (line 117), where `clientId = req.context.userId` — for a POS principal, that **is** the device identity. **FR-021a per-device scoping is satisfied with no wrapper.**
> - **Replay TTL default = 72 hours** (line 226: `72 * 60 * 60 * 1000`). FR-021b requires ≥ 24h; 72h is comfortably above. **No TTL override needed.**
> - **Mismatched payload returns `409 ConflictException` with `error.code = "idempotency_key_conflict"`** (lines 252-261). `recordIdempotencyConflict` metric already fires. **FR-021c fails-closed semantics are satisfied.**
> - **Header name is `Idempotency-Key`** (lowercased), not `Idempotency-Token` as the spec and quickstart drafted. **The spec/quickstart text needs alignment** (tracked in Phase 6 polish; see T564 below).
>
> The original T505/T506 wrapper tasks collapse to a single decorator-application task (T505 below). What remains is the interceptor wiring on the capture route, which now lives entirely in Phase 4 (T531) where it belongs (US4 owns idempotency). T506 is removed.

- [ ] T505 [P] [TC] Verification spec — author `apps/api/test/catalog/unknown-items/idempotency/existing-primitive-coverage.spec.ts` confirming the existing `IdempotencyInterceptor` satisfies all four idempotency FRs against a fake POS-principal context: (a) FR-021 identical retry returns cached response (`Idempotent-Replayed: true` header); (b) FR-021c mismatched payload returns 409 with `idempotency_key_conflict`; (c) FR-021a two device principals with same key string produce independent state; (d) FR-021b 72h TTL default exceeds the 24h minimum (assert against `DEFAULT_REPLAY_TTL_SEC` or the equivalent constant — verify name during execution). Predecessors: T500. Acceptance: all four cases GREEN against the unmodified existing interceptor — **proving no wrapper is needed before Wave 1 commits to that architecture.**

### 5.3 Isolation-harness extension for `unknown_items`

Per plan §3.3 (regression test areas) and the 003 isolation harness pattern.

- [ ] T506 [P] [TC] Author `apps/api/test/catalog/__support__/seed-unknown-items.ts` — extension to the existing `isolation-harness.ts` that seeds fixture `unknown_items` rows across tenants A/B and stores X/Y. Schemas align with [data-model.md §1 + §2.1](./data-model.md). MUST NOT modify existing `isolation-harness.ts` (003-owned). Predecessors: T500. Acceptance: helper exported; existing isolation harness tests (T341, T342, T343, T344) untouched and still GREEN.
- [ ] T507 [TC] RED test — author `apps/api/test/catalog/unknown-items/isolation/cross-tenant.spec.ts` extending the T341 pattern with `unknown_items`-specific cases per [SI-001, FR-013](./spec.md#7-security--isolation-requirements). Use T506's seed helper. Predecessors: T506. Acceptance: test runs, cases fail (no `unknown_items` service exists yet to exercise; failure is on missing service, not on RLS).

**Checkpoint after Phase 2**: Contract YAML approved and authored. Existing idempotency primitive verified sufficient for Wave 1's needs (no wrapper). Isolation harness extension ready. **All US1/US4/US5 tasks can now begin.**

---

## 6. Phase 3 — User Story 1: POS captures an unknown item (Priority: P1) 🎯 MVP

**Goal**: A POS device authenticated to tenant T and store S can submit an item reference. If the identifier resolves to an active alias, return the resolved product. If not, create exactly one `pending` row in `unknown_items` scoped to (T, S) and return a stable reference. Cross-tenant access is non-disclosing.

**Independent Test**: A POS authenticated to tenant T and store S submits an identifier the tenant has never seen. Verify: (a) an unknown-item record exists scoped to (T, S) with status pending; (b) no `tenant_products` row was created; (c) the response is deterministic and references the captured record by a stable id; (d) a parallel POS authenticated to a different tenant cannot see this record by any means. (Mirrors spec §5 US1 Independent Test.)

### 6.1 Capture happy path

- [ ] T510 [P] [US1] [TC] RED test — `apps/api/test/catalog/unknown-items/capture/capture-happy-path.spec.ts` covering [FR-001, FR-010, FR-030, FR-070]: POS submits unknown identifier → 201-class response, exactly one `unknown_items` row exists with `resolution_status='pending'`, `tenant_id=T`, `store_id=S`, audit event subject `unknown_item.captured` emitted, metric `unknown_item_captured_total` incremented. Predecessors: T506, T507. Acceptance: test runs, fails (no controller / service exists yet).
- [ ] T511 [US1] Implement `apps/api/src/catalog/unknown-items/unknown-items.service.ts` `captureUnknownItem(...)` method per [data-model.md §2.1 + §2.4](./data-model.md): inside `runWithTenantContext`, look up alias → if no match, INSERT into `unknown_items` (single transaction) → emit audit event via `@Auditable("unknown_item.captured")` on the controller method (T512). Predecessors: T510. Acceptance: T510 GREEN.
- [ ] T512 [US1] Implement `apps/api/src/catalog/unknown-items/unknown-items.controller.ts` `POST /tenants/:tenant_id/stores/:store_id/catalog/unknown-items/capture` mapped to `posCaptureItem` operationId from T503. Decorate the route handler with `@Auditable("unknown_item.captured")` (subject convention matches existing 001 audit subjects per `apps/api/src/audit/auditable.decorator.ts`). Zod `.strict()` boundary validation per FR-070 / FR-071. Predecessors: T503, T511. Acceptance: T510 still GREEN; OpenAPI conformance test passes for the operationId.

### 6.2 Capture resolves to existing alias (FR-022, FR-030, FR-031)

- [ ] T513 [P] [US1] [TC] RED test — `apps/api/test/catalog/unknown-items/capture/capture-resolves-to-alias.spec.ts` covering [FR-022, FR-030, FR-031]: seed an active alias for `(T, 'barcode', '5449000000996')` bound to product P1; POS submits the same identifier → 200-class response references P1, **no** new `unknown_items` row created. Predecessors: T506, T507. Acceptance: test runs, fails (capture logic does not yet attempt resolution).
- [ ] T514 [US1] Extend `captureUnknownItem` in `unknown-items.service.ts` (from T511) with the alias-resolution prelude: before insert, query `product_aliases` via the partial index `idx_product_aliases_lookup` filtered to `retired_at IS NULL` and matching `(tenant_id, identifier_type, value, source_system?, store_id?)` per FR-030 alias scope rules. On match, return resolved outcome without insert. Predecessors: T513. Acceptance: T513 GREEN; T510 still GREEN.

### 6.3 Capture respects submitting-store scope (FR-030a)

- [ ] T515 [P] [US1] [TC] RED test — `apps/api/test/catalog/unknown-items/capture/capture-store-scope.spec.ts` covering [FR-030a]: seed a **store-scoped** alias bound to product P1 in store S1; POS at store S2 (same tenant) submits the same identifier → unknown-item row created at S2 (the S1 alias does **not** resolve), **separately** the same submission from S1 resolves to P1. Predecessors: T506, T507. Acceptance: test runs, fails.
- [ ] T516 [US1] Adjust the alias-lookup WHERE clause in `unknown-items.service.ts` (T514) to add `store_id IS NULL OR store_id = $current_store` — tenant-wide aliases resolve everywhere, store-scoped aliases only resolve at the bound store. Predecessors: T515. Acceptance: T515 GREEN; T513 + T510 still GREEN.

### 6.4 Capture deduplicates same-tenant same-store pending rows (FR-032)

- [ ] T517 [P] [US1] [TC] RED test — `apps/api/test/catalog/unknown-items/capture/capture-deduplicates-pending.spec.ts` covering [FR-032]: POS at (T, S) submits identifier I (no idempotency token — testing the natural dedup) → row created. POS at (T, S) submits same I again with a **different** idempotency token → returns the **same** `unknown_items.id`, no second row created. Predecessors: T506, T507. Acceptance: test runs, fails (idempotency-token-keyed dedup would pass but natural dedup is what's tested).
- [ ] T518 [US1] Extend `captureUnknownItem` (T514/T516) with the natural-dedup query: after alias lookup misses, query `unknown_items` filtered to `resolution_status='pending'` and the same `(tenant_id, store_id, identifier_type, value, source_system?)` via partial index `idx_unknown_items_lookup_value`. If found, return that row's id without insert. Predecessors: T517. Acceptance: T517 GREEN; all prior US1 tests still GREEN.

### 6.5 Capture rejects missing / malformed payloads (FR-070, FR-071, FR-072)

- [ ] T519 [P] [US1] [TC] RED test — `apps/api/test/catalog/unknown-items/capture/capture-validation.spec.ts` covering [FR-070, FR-071, FR-072]: each missing-required-field case (no identifier_type, no value, no store binding from auth principal), each malformed case (value length 0 or > 200, unsupported identifier_type, external_pos_id without source_system) → 400-class response with `error.code` from research §R2 taxonomy, **no** `unknown_items` row created, raw value NOT in any log line. Predecessors: T506. Acceptance: test runs, fails.
- [ ] T520 [US1] Author Zod schema `apps/api/src/catalog/unknown-items/dto/capture-request.dto.ts` enforcing the validation rules mirrored from 003's CHK constraints (`unknown_items_identifier_type_valid`, `unknown_items_value_length`, `unknown_items_source_system_required`). Wire `.strict()` at the controller boundary. Add a redaction guard around log statements emitting the raw `value` field. Predecessors: T503, T519. Acceptance: T519 GREEN; all prior US1 tests still GREEN.

### 6.6 Cross-tenant probe is non-disclosing (SI-001, FR-013, FR-092)

- [ ] T521 [P] [US1] [TC] RED test — extend the previously RED-failed `apps/api/test/catalog/unknown-items/isolation/cross-tenant.spec.ts` (from T507) to actually exercise the new capture endpoint: a POS authenticated to tenant A submits with an identifier that exists as a pending unknown item in tenant B → 200-class capture in A, **separately**, an attempt by tenant A to read tenant B's unknown item by guessed UUID → 404-class non-disclosing. Predecessors: T512 (controller exists). Acceptance: test runs, both cases fail (or non-disclosing not yet implemented).
- [ ] T522 [US1] Wire RLS-based 404-class non-disclosing in `unknown-items.service.ts` for any GET-by-id path that returns zero rows under RLS. (For Wave 1, GET-by-id is internal — the list endpoint is the public surface — but a service-layer helper consistent with the SI-004 invariant is authored now so it's available when the contract slice exposes a GET-by-id later.) Predecessors: T521. Acceptance: T521 GREEN; existing 003 cross-tenant tests (T341) still GREEN (regression).

### 6.7 List endpoint for the review queue (US1-adjacent; tenant-admin-facing)

> **Note**: List is technically US2 territory ("tenant admin reviews the queue") but the spec's US2 also covers link/create-new which are blocked. List is a pure read — no T350/T383 dependency — and it's needed for the dismiss action in Phase 5. Pulling it into Wave 1 alongside capture is the cleanest grouping.

- [ ] T523 [P] [US1] [TC] RED test — `apps/api/test/catalog/unknown-items/list/list-queue.spec.ts` covering [FR-014]: tenant admin lists pending items across two stores → sees both; store manager scoped to S1 lists → sees only S1's; cross-tenant probe → empty list, no error. Predecessors: T506, T507. Acceptance: test runs, fails.
- [ ] T524 [US1] Implement `listUnknownItems(...)` in `unknown-items.service.ts` and `GET /tenants/:tenant_id/catalog/unknown-items?status=pending` in `unknown-items.controller.ts` mapped to `tenantAdminListUnknownItems` operationId from T503. RLS does the cross-store filtering; the service does not add explicit `WHERE store_id = …` (rely on `app.current_store` GUC for store-scoped operators, empty-string for tenant-wide). Predecessors: T503, T523. Acceptance: T523 GREEN.

**Checkpoint after Phase 3**: POS capture endpoint works end-to-end. Tenant admins / store managers can list pending unknown items. Cross-tenant isolation verified. **US1 is independently testable and shippable as MVP.**

---

## 7. Phase 4 — User Story 4: Repeats and retries are idempotent (Priority: P2)

**Goal**: A retried POS submission of the same logical identifier with the same idempotency token produces no duplicate rows, no duplicate audit events, and the same response. Cross-device token reuse is independent. Payload mismatch within TTL fails closed.

**Independent Test**: Submit the same unknown identifier 5 times from the same authenticated POS in rapid succession. Verify exactly one `unknown_items` row, identical responses, retry telemetry increments but capture telemetry does not. (Mirrors spec §5 US4 Independent Test.)

> **Note**: T505 (Phase 2) already proved the existing `IdempotencyInterceptor` covers Wave 1's needs without modification. This phase wires the existing interceptor into the capture route via `@Idempotent('required')` and adds end-to-end coverage. **No wrapper service exists or is needed.**

- [ ] T530 [P] [US4] [TC] RED test — `apps/api/test/catalog/unknown-items/idempotency/retry-identical.spec.ts` covering [FR-021]: same `(tenant, device, idempotency-key, payload)` submitted 5 times in rapid succession → identical response each time (replay sets `Idempotent-Replayed: true` header), exactly one `unknown_items` row, exactly one audit event `unknown_item.captured`. Predecessors: T505, T518 (dedup is the natural fallback if interceptor misses). Acceptance: test runs, fails (interceptor not yet wired on the route).
- [ ] T531 [US4] Apply the `@Idempotent('required')` decorator (from `apps/api/src/idempotency/idempotent.decorator.ts`) to the `posCaptureItem` controller method in `unknown-items.controller.ts` (T512). Header name is `Idempotency-Key` (the existing primitive's convention). Predecessors: T512, T530. Acceptance: T530 GREEN; T510 still GREEN.
- [ ] T532 [P] [US4] [TC] RED test — `apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts` covering [FR-021c]: same `(tenant, device, Idempotency-Key)` + different payload (different `identifier_value`) → 409-class `idempotency_key_conflict` (the existing interceptor's existing outcome), **no** `unknown_items` row, **no** capture audit event, audit event `unknown_item.idempotency_mismatch_rejected` emitted, metric `idempotency_token_mismatch_total` incremented (in addition to the existing `recordIdempotencyConflict` metric the interceptor already fires). Predecessors: T531. Acceptance: test runs, fails (the existing interceptor returns 409 but does NOT emit the catalog-domain audit subject or our new mismatch counter).
- [ ] T533 [US4] Wire the mismatch-rejected audit subject + the new `idempotency_token_mismatch_total` counter. Two implementation options — pick during execution: (a) a small NestJS exception filter that catches `ConflictException` with `code: "idempotency_key_conflict"` on the capture route and emits the catalog-domain audit subject + increments the counter before re-throwing; (b) hook into the existing `recordIdempotencyConflict` call site via an injected `MetricsBus` that the catalog module subscribes to. Option (a) is the smaller diff and stays inside `apps/api/src/catalog/unknown-items/`. Predecessors: T532, T501 (counter registered). Acceptance: T532 GREEN; existing 001 idempotency tests still GREEN (T562 in Phase 6 verifies).
- [ ] T534 [P] [US4] [TC] RED test — `apps/api/test/catalog/unknown-items/idempotency/cross-device-keys.spec.ts` covering [FR-021a]: two devices in tenant T submit the same opaque `Idempotency-Key` header value with payloads that would mismatch if keyed only on `(tenant, key)` → both succeed independently because the dedup tuple already includes `clientId = req.context.userId` (which is the device principal per spec 002). Each device gets its own `unknown_items` row. Predecessors: T531. Acceptance: test runs, fails only if the existing interceptor's `clientId` extraction is somehow short-circuited for POS principals (which would be a bug in 001/002, not 005).
- [ ] T535 [P] [US4] [TC] RED test — `apps/api/test/catalog/unknown-items/idempotency/ttl-expiry.spec.ts` covering [FR-021b]: mocked clock advances past 72h (the existing interceptor's default TTL, which already exceeds the 24h minimum required by FR-021b); same `(tenant, device, key)` + same payload submitted again → treated as fresh request. The TTL itself is owned by the existing interceptor; this test only verifies behavior at the route, not the constant. Predecessors: T531. Acceptance: test runs, fails only if a Wave 1 task accidentally overrode `replayTtlSec` to something shorter than 72h.
- [ ] T536 [US4] [TC] RED test — `apps/api/test/catalog/unknown-items/idempotency/post-resolved.spec.ts` covering [FR-022]: POS submits identifier I → captured. Simulate Wave 2's link action by directly UPDATEing `unknown_items.resolution_status='resolved'` and INSERTing a matching `product_aliases` row. POS submits I again with a new `Idempotency-Key` → returns resolved-product outcome (alias lookup wins per T514's logic), **no** new `unknown_items` row. Predecessors: T514 (alias-resolution prelude). Acceptance: test GREEN — alias-lookup precedence over pending-dedup is verified.

- [x] **T539a** [P] [US4] [TC] RED test — `apps/api/test/idempotency/replay.spec.ts` covering [FR-021, FR-021a]: asserts a 200-returning handler under `@Idempotent("required")` replays as 200, not 201. Stands up an in-suite `Test200Controller` with `@Res({ passthrough: true })` + `res.status(HttpStatus.OK)` mirroring the capture-resolves-to-alias pattern from `UnknownItemsController`. Predecessors: T531 (interceptor is wired on a test route). Acceptance: test runs, fails before T539b lands; passes after.

- [x] **T539b** [US4] [GATED] GREEN fix — `apps/api/src/idempotency/idempotency.interceptor.ts:274` reads the original response's statusCode via `ExecutionContext` (`execCtx.switchToHttp().getResponse<{ statusCode: number }>().statusCode`) instead of hard-coding `HttpStatus.CREATED`. Also flips the `it.skip(...)` tripwire in `apps/api/test/catalog/unknown-items/capture/capture-resolves-to-alias.spec.ts` → active `it(...)` for end-to-end verification on the 005 resolved branch. Predecessors: T539a. Acceptance: T539a GREEN, capture-resolves-to-alias 3/3 GREEN with no skips, capture-happy-path 6/6 unchanged.

**Checkpoint after Phase 4**: Idempotent POS retries are correct on all four axes (identical replay, mismatch fails closed, cross-device independence, TTL expiry). **US4 is independently testable.** IdempotencyInterceptor status-code replay defect fixed via T539b, enabling LIST and DISMISS endpoints to return non-201 status on success with correct replay semantics.

---

## 8. Phase 5 — User Story 5 (audit + observability) + dismiss action (Priority: P2)

**Goal**: Every state transition in Wave 1 (capture, dismiss, idempotency-mismatch rejection) produces an audit event with `correlation_id`. Observability counters increment correctly. Dismiss transitions a pending unknown item to `dismissed` terminal state; subsequent POS resubmissions of the same identifier produce fresh `pending` rows per FR-005.

**Independent Test**: Drive the full Wave 1 lifecycle: capture → dismiss → resubmit. Verify each transition produced an audit event referencing the correct actor, tenant, store, and correlation id, plus a fresh `pending` row after the resubmit. (Mirrors spec §5 US5 Independent Test, scoped to Wave 1's audit subjects.)

### 8.1 Dismiss endpoint

- [ ] T540 [P] [US5] [TC] RED test — `apps/api/test/catalog/unknown-items/dismiss/dismiss-happy-path.spec.ts` covering [FR-002, FR-003, FR-004, dismiss path of US2 #3]: tenant admin (or store manager scoped to the item's store) dismisses a pending unknown item → row transitions to `resolution_status='dismissed'`, `resolved_at`, `resolved_by`, `resolution_action='dismissed'` all populated; no `product_aliases` written; no `tenant_products` written. Predecessors: T506. Acceptance: test runs, fails (no dismiss endpoint).
- [ ] T541 [US5] Implement `dismissUnknownItem(...)` in `unknown-items.service.ts` and `POST /tenants/:tenant_id/catalog/unknown-items/:id/dismiss` in `unknown-items.controller.ts` mapped to `tenantAdminDismissUnknownItem` operationId from T503. Decorate the route handler with `@Auditable("unknown_item.dismissed")`. UPDATE clause includes `WHERE resolution_status='pending'` to enforce FR-004 monotonicity. Predecessors: T503, T540. Acceptance: T540 GREEN.
- [ ] T542 [P] [US5] [TC] RED test — `apps/api/test/catalog/unknown-items/dismiss/dismiss-monotonic.spec.ts` covering [FR-004]: attempt to dismiss an already-resolved or already-dismissed row → 409-class or 404-class outcome (treat as `already-reconciled` per research §R2 taxonomy); row unchanged. Predecessors: T541. Acceptance: test runs, fails.
- [ ] T543 [US5] Map the no-row-updated case (T541's UPDATE returns rowCount=0) to the `already-reconciled` outcome from research §R2. Audit event subject for the rejected attempt is `unknown_item.dismissed` with a `rejected=true` discriminator (or the equivalent shape — verify against existing audit-event shape conventions during execution). Predecessors: T542. Acceptance: T542 GREEN.

### 8.2 FR-005 dismissed-then-resubmit

- [ ] T544 [P] [US5] [TC] RED test — `apps/api/test/catalog/unknown-items/capture/dismissed-then-resubmit.spec.ts` covering [FR-005]: capture identifier I at (T, S) → dismiss → POS submits the same logical identifier at (T, S) again → a **new** `pending` row is created (distinct UUID from the dismissed row); the dismissed row is unchanged. Predecessors: T541. Acceptance: test runs, fails if the natural-dedup logic (T518) incorrectly catches the dismissed row.
- [ ] T545 [US5] Tighten the natural-dedup query in `captureUnknownItem` (T518) to filter on `resolution_status='pending'` (not just same logical identifier). The partial index `idx_unknown_items_lookup_value` already includes this predicate, so this is a service-layer assertion rather than a query change. Predecessors: T544. Acceptance: T544 GREEN; T518 + T517 still GREEN.

### 8.3 Audit event emission verification

> **Note**: The `@Auditable` decorator was applied on the capture (T512) and dismiss (T541) route handlers. The existing `AuditEmitterInterceptor` (registered globally per 001's T232) reads the decorator metadata and emits the audit event automatically. The tests below verify the wiring; the implementation tasks are tightly-scoped fixups only if the verification reveals a gap.

- [ ] T546 [P] [US5] [TC] RED test — `apps/api/test/catalog/unknown-items/audit/capture-audit.spec.ts` covering [FR-080]: every successful capture emits exactly one `audit_events` row with subject `unknown_item.captured`, attributing to the POS device, with `correlation_id` matching the request correlation id. Predecessors: T511. Acceptance: test runs, fails if the `@Auditable` decorator on the capture route (T512) is missing or wired incorrectly.
- [ ] T547 [US5] If T546 fails, fixup the `@Auditable("unknown_item.captured")` decorator on the capture route (T512). The `AuditEmitterInterceptor` is already a global APP_INTERCEPTOR — verify it's registered in the API module. Predecessors: T546. Acceptance: T546 GREEN.
- [ ] T548 [P] [US5] [TC] RED test — `apps/api/test/catalog/unknown-items/audit/dismiss-audit.spec.ts` covering [FR-080]: dismiss emits `unknown_item.dismissed` audit event. Predecessors: T541. Acceptance: test runs, fails if the `@Auditable` decorator on the dismiss route (T541) is missing or wired incorrectly.
- [ ] T549 [US5] If T548 fails, fixup the `@Auditable("unknown_item.dismissed")` decorator on the dismiss route (T541). Predecessors: T548. Acceptance: T548 GREEN.
- [ ] T550 [P] [US5] [TC] [ABSORBED → `005-WAVE1-METRICS-MISMATCH-FOLLOWUP`, 2026-05-28] RED test — `apps/api/test/catalog/unknown-items/audit/idempotency-mismatch-audit.spec.ts` covering [FR-082]: idempotency-mismatch rejection emits `unknown_item.idempotency_mismatch_rejected` audit event (failed reconciliation attempts are first-class audit events). Predecessors: T533. Acceptance: test runs, fails if T533's exception filter / metric bus hook isn't also emitting the audit subject. **Absorption note**: blocked by the same harness pattern as T532/T552 (see `retry-mismatch.spec.ts:334-357`); PR #349 proved the `APP_INTERCEPTOR + TestingModule + @UseFilters` shape itself is broken for the mismatch path. Unit-level branch coverage exists at `filters/idempotency-mismatch.filter.unit.spec.ts` (IMF1–5); production audit emit is wired and live. FOLLOWUP slice closes T532 + T550 + T551 + T552-mismatch-case together via a harness refactor.
- [ ] T551 [US5] [ABSORBED → `005-WAVE1-METRICS-MISMATCH-FOLLOWUP`, 2026-05-28] If T550 fails, extend the mismatch handling (T533) to emit the catalog-domain audit subject. The existing `AuditEmitterInterceptor` short-circuits BEFORE handler on replay (see interceptor docs line 22-25), so on a mismatch (which raises 409 before next.handle resolves), the global interceptor would NOT emit. The audit emission for the mismatch is therefore an explicit call site inside T533's filter/hook, not a decorator-driven emission. Predecessors: T550. Acceptance: T550 GREEN. **Absorption note**: the emit call is already wired in `idempotency-mismatch.filter.ts:161-182` (PR #339); FOLLOWUP verifies T551's acceptance via the T550 integration spec after the harness refactor lands.

### 8.4 Observability counter verification

- [ ] T552 [P] [US5] [TC] RED test — `apps/api/test/catalog/unknown-items/audit/metrics.spec.ts` covering [FR-081, plan §3.4]: successful capture increments `unknown_item_captured_total`; dismiss increments `unknown_item_resolved_total{action='dismissed'}`; mismatch increments `idempotency_token_mismatch_total`. Predecessors: T511, T541, T533. Acceptance: test runs, fails if any counter isn't incremented at the right call site.
- [ ] T553 [US5] Add explicit counter-increment calls at each emission site (capture in T511, dismiss in T541, mismatch in T533) if T552 fails. All three counters were registered in T501. Predecessors: T552. Acceptance: T552 GREEN.

**Checkpoint after Phase 5**: Dismiss endpoint works. FR-005 dismissed-then-resubmit creates fresh `pending` rows. All Wave 1 audit subjects emit correctly with correlation ids. All Wave 1 metrics increment at the right call sites. **US5 + dismiss are independently testable.**

---

## 9. Phase 6 — Polish & cross-cutting

**Purpose**: Performance smoke test, regression-sweep validation, lightweight closeout docs. No new business logic.

- [ ] T560 [P] [TC] Performance smoke test — author `apps/api/test/catalog/unknown-items/perf/capture-latency.spec.ts` per [research.md §R3](./research.md#r3--performance-budget-is-sc-008-achievable): seed a tenant with 50,000 `tenant_products` and 100,000 `product_aliases`, then run 100 capture submissions back-to-back from a single device. Assert `p95 ≤ 500ms`, `p99 ≤ 1s` at the API surface (excluding test-harness overhead). Predecessors: T531 (full capture path wired). Acceptance: test runs, p95 / p99 within budget on local Testcontainers Postgres 16.
- [ ] T561 [P] [TC] Regression sweep — confirm the four 003 isolation suites stay GREEN after Wave 1's reads/writes are wired: `cross-tenant-read.spec.ts` (T341, 31/31), `cross-store-read.spec.ts` (T342, 17 + 4 todo), `rls-bypass-probe.spec.ts` (T343, 35 + 4 todo), `malicious-override.spec.ts` (T344). No new failures introduced. Predecessors: T531 + T541. Acceptance: all four suites still pass at the counts recorded in [plan.md §4.1](./plan.md#41-003--merged-and-usable).
- [ ] T562 [P] [TC] Regression sweep — confirm 001's idempotency tests still pass after T533's exception filter / metric hook is wired alongside the existing interceptor. The existing primitive is **not** modified by Wave 1; this sweep only verifies that 005's filter/hook does not alter the interceptor's existing behavior on routes 005 doesn't own. Identify the existing 001 idempotency test path during execution (likely `apps/api/test/idempotency/**`). Predecessors: T533. Acceptance: no new failures in 001 idempotency suite.
- [ ] T563 [P] [TC] Regression sweep — confirm the existing audit-fanout worker tests pass after Wave 1 emits new audit subjects. Identify path during execution (likely `apps/worker/test/audit/**`). Predecessors: T547, T549, T551. Acceptance: no new failures; new subjects pass through the fanout consumer without a new consumer test path required.
- [ ] T564 Author `specs/005-pos-catalog-sync-reconciliation/wave-status.md` modeled on `specs/003-catalog-foundation/wave-status.md`: short human-readable summary of Wave 1 closeout, list of merged slices with PR / commit references, active findings (if any), what's still pending for Wave 2 (link + create-new + alias-conflict). Also fix the **`Idempotency-Token` → `Idempotency-Key`** drift in `spec.md` §5 and `quickstart.md` (the existing primitive uses `Idempotency-Key`; the spec/quickstart drafts used `Idempotency-Token` — both must align to the implementation reality). Predecessors: all Wave 1 tasks merged. Acceptance: file exists with all Wave 1 PR references; structure matches 003's wave-status.md; spec.md + quickstart.md header-name references corrected.

**Checkpoint after Phase 6**: Wave 1 is shippable. Performance verified. No regressions. Wave 1 closeout documented. **MVP is complete.**

---

## 10. Dependencies & ordering

### 10.1 Phase ordering (strict)

```
Phase 1 (Setup: T500, T501)
   ↓
Phase 2 (Foundational: T503-T507)   ← [GATED] T503 + T504 require approval first
   ↓
Phase 3 (US1 capture: T510-T524)
   ↓
Phase 4 (US4 idempotency: T530-T536)
   ↓
Phase 5 (US5 audit + dismiss: T540-T553)
   ↓
Phase 6 (Polish: T560-T564)
```

### 10.2 Cross-phase dependencies

- **T531** (wire idempotency interceptor) is the lynchpin for Phase 4 — depends on T512 (controller) from Phase 3.
- **T545** (FR-005 dedup tightening) refines T518 (Phase 3 dedup) — Phase 5 depends on Phase 3 here.
- **T560** (perf smoke) requires the full capture path wired (T531) — runs in Phase 6, depends on Phase 4.
- **T564** (wave-status closeout) depends on every Wave 1 slice being merged.

### 10.3 Parallel opportunities within each phase

- **Phase 1**: T501 in parallel with T500 — actually, T501 depends on nothing (the metrics file is unrelated to the module dir), so it can land in any order with T500.
- **Phase 2**: T504 + T505 + T506 + T507 in parallel after T503 (disjoint files; T504 is the YAML registration, T505 is the idempotency verification spec, T506 is a test helper, T507 is the cross-tenant RED test).
- **Phase 3 RED tests**: T510 + T513 + T515 + T517 + T519 + T521 + T523 — ALL parallel-safe (each in its own spec file). The GREEN implementations must serialize through the shared `unknown-items.service.ts` and `unknown-items.controller.ts` files.
- **Phase 4 RED tests**: T530 + T532 + T534 + T535 + T536 — all parallel-safe. GREENs through the shared service file serialize.
- **Phase 5 RED tests**: T540 + T542 + T544 + T546 + T548 + T550 + T552 — all parallel-safe across distinct spec files.
- **Phase 6**: T560 + T561 + T562 + T563 all parallel; T564 last.

---

## 11. Implementation strategy

### 11.1 MVP scope

**Phase 3 (US1) alone is the MVP**: capture works end-to-end, cross-tenant isolation verified, validation enforced, list endpoint available. Demoable in isolation.

Phases 4 and 5 add idempotency robustness and audit completeness — required for production but not for the first internal demo.

Phase 6 is shipping polish — required before merging Wave 1 to `main`.

### 11.2 Recommended slice dispatch (under Maestro)

Per [maestro-playbook.md](../../docs/agent-os/maestro-playbook.md), each numbered task block is a candidate slice. The natural slice boundaries:

| Slice | Tasks | Approval | Reviewer focus |
|---|---|---|---|
| 005-WAVE1-SETUP | T500, T501 | none | module skeleton, metric registration |
| 005-WAVE1-CONTRACT | T503, T504 | **`[GATED]`** | OpenAPI YAML — verify operationIds + schemas |
| 005-WAVE1-IDEMP-VERIFY | T505 | none | verify existing interceptor covers FR-021/021a/021b/021c |
| 005-WAVE1-HARNESS | T506, T507 | none | fixture seeding additive to 003's harness |
| 005-WAVE1-CAPTURE-HAPPY | T510–T512 | none | first end-to-end capture |
| 005-WAVE1-CAPTURE-RESOLVE | T513, T514 | none | alias-resolution prelude |
| 005-WAVE1-CAPTURE-STORE-SCOPE | T515, T516 | none | FR-030a |
| 005-WAVE1-CAPTURE-DEDUP | T517, T518 | none | FR-032 natural dedup |
| 005-WAVE1-VALIDATION | T519, T520 | none | Zod boundary |
| 005-WAVE1-NON-DISCLOSING | T521, T522 | none | SI-004 |
| 005-WAVE1-LIST | T523, T524 | none | tenant-admin queue read |
| 005-WAVE1-IDEMP-WIRE | T530, T531 | none | `@Idempotent('required')` on capture route |
| 005-WAVE1-IDEMP-MISMATCH | T532, T533 | none | FR-021c: catalog-domain audit + counter on existing 409 |
| 005-WAVE1-IDEMP-EDGES | T534, T535, T536 | none | FR-021a, FR-021b, FR-022 |
| 005-WAVE1-DISMISS | T540–T543 | none | dismiss + monotonicity |
| 005-WAVE1-FR005 | T544, T545 | none | dismissed-then-resubmit |
| 005-WAVE1-AUDIT | T546–T551 | none | audit emission |
| 005-WAVE1-METRICS | T552, T553 | none | counter emission |
| 005-WAVE1-POLISH | T560–T564 | none | perf, regressions, closeout |

Approx **19 slices** for Wave 1. Each is a single concern, RED-then-GREEN paired, reviewable in one pass.

### 11.3 Stop conditions (per Standing Rules §7)

A slice MUST stop and report rather than silently work around the following:

- Any task would touch `packages/db/drizzle/**` or `packages/db/src/schema/**` — Wave 1 introduces zero schema work (data-model.md §5). If you find yourself wanting to add a column, the spec premise is wrong.
- Any task would touch `specs/003-catalog-foundation/**` — 003 is read-only for 005.
- T503 (contract YAML) is being worked on without explicit user `[GATED]` approval.
- A Phase 4/5 RED test still fails after the corresponding GREEN task completes — investigate before moving to the next task.
- T561 (regression sweep) detects any new failure in T341 / T342 / T343 / T344 — Wave 1 must not regress 003 isolation guarantees.
- T562 / T563 (idempotency / audit-fanout regression sweeps) detects any new failure — fix before merging Wave 1.

---

## 12. Out of scope for Wave 1 (re-stated)

- ❌ Link reconciliation (US2 #1, FR-050–FR-053) — Wave 2.
- ❌ Create-new reconciliation (US2 #2, FR-060–FR-063) — Wave 2.
- ❌ Alias-conflict fail-closed behavior (US3, FR-040–FR-043) — Wave 2 (US3 is reconciliation-only; capture-time conflict detection is naturally covered by RLS unique-index violations on retry, which are already tested via Phase 4's idempotency mismatch path).
- ❌ Cross-store reconciliation by tenant admin (US2 generally) — Wave 2.
- ❌ Concurrent reconciliation race resolution (US3 #3) — Wave 2.
- ❌ Audit event subjects `unknown_item.resolved.linked`, `unknown_item.resolved.created`, `unknown_item.reconciliation_conflict_rejected` — Wave 2 owns their registration and emission.
- ❌ Dashboard UI for the review queue — separate future feature.
- ❌ POS app implementation — separate repo.
- ❌ Any new SQL migration — data-model.md §5 forbids.
- ❌ Any edits to 003 files — plan.md §3 + §9 forbid.
- ❌ Performance load test (vs. smoke test) — SC-008 production verification is observability-based per spec, not a Wave 1 task.

---

---

# Wave 2 — Reconciliation path (US2 link + create-new, US3 alias-conflict fail-closed)

**Wave**: 2 of 2
**Dependency cleared**: `003 PHASE3_RED_WAVE` merged 2026-05-23 (PR #300 `TenantCatalogService.create`, PR #301, PR #302, PR #303 `ProductAliasesService.create`). T336 `MISSING_WITHSTORE_HELPER` merged 2026-05-24 (PR #310).
**Task range**: T600–T699
**Status**: Draft (planning only — no code authored)
**Authored**: 2026-05-24

---

> **Architecture note — why `ReconciliationService` does NOT compose T351 or T384**
>
> FR-053 requires that a link operation be fully atomic: alias INSERT + unknown_items UPDATE must both commit or both roll back. FR-063 requires the same guarantee for create-new: tenant_products INSERT + alias INSERT + unknown_items UPDATE.
>
> `TenantCatalogService.create` (T351) and `ProductAliasesService.create` (T384) each open their own `runWithTenantContext` call, which acquires a separate pool connection and begins its own transaction. Calling them from inside a second `runWithTenantContext` call would produce TWO independent transactions — violating the atomicity requirement and also creating a dual-audit row from `TenantCatalogService.create`'s inline `catalog.product.create` audit INSERT (see T351 header warning, lines 30–39).
>
> **Resolution**: `ReconciliationService` owns the multi-row SQL for all three writes inline, inside a single `runWithTenantContext` transaction. It does NOT delegate to `TenantCatalogService.create` or `ProductAliasesService.create` for any atomic writes. The 003 services remain the authoritative reference for interface shapes and constraint semantics — they are read as documentation, not called at runtime.
>
> This pattern mirrors `StoresService` (raw Pool + `runWithTenantContext`), which is established as the multi-tenant write primitive on this repo.

> **Scope**
>
> - New NestJS module: `apps/api/src/catalog/reconciliation/` containing `reconciliation.module.ts` + `reconciliation.service.ts` + `reconciliation.controller.ts`.
> - No new SQL migrations (data-model.md §5: Wave 2 also introduces zero new tables, columns, indexes, constraints, RLS policies, or migration files).
> - No edits to `specs/003-catalog-foundation/**` — read-only for 005.
> - No edits to `apps/api/src/modules/catalog/tenant-catalog.service.ts` or `product-aliases.service.ts` — those are 003-owned.
> - The Wave 1 fixture helper `apps/api/test/catalog/__support__/seed-unknown-items.ts` (T506 / PR #307) is reused — no new harness needed.

---

## 13. Wave 2 approval-gated tasks (`[GATED]`)

| Task | Reason for gating |
|---|---|
| `T600 [GATED]` — extend `packages/contracts/openapi/catalog/unknown-items.yaml` with Wave 2 operationIds (`tenantAdminLinkUnknownItem`, `tenantAdminCreateProductFromUnknownItem`) | OpenAPI YAML — `packages/contracts/openapi/**` is a forbidden surface per Standing Rules §3 |
| `T601 [GATED]` — register any new YAML path entries in the conformance-test entrypoint if needed | OpenAPI directory of record |

**No new SQL migrations are gated for Wave 2.** data-model.md §5 explicitly states Wave 2 also introduces zero schema work. Any Wave 2 task that would touch `packages/db/drizzle/**` or `packages/db/src/schema/**` is a defect — stop the slice and report.

---

## 14. Wave 2 user scenarios in scope

| US# | Scenario (spec §5) | Phase |
|---|---|---|
| **US3** | Alias conflicts fail closed | Phase 3 (safety floor — precedes link + create-new) |
| **US2 #1** | Tenant admin links unknown item to existing product | Phase 4 |
| **US2 #2** | Tenant admin creates new product from unknown item | Phase 5 |

---

## 15. Phase 2 (Wave 2) — Gated contract extension

**Purpose**: Extend the already-merged Wave 1 contract YAML (`packages/contracts/openapi/catalog/unknown-items.yaml`) with the two Wave 2 operationIds. **No Phase 3–5 Wave 2 task can start until this is approved and authored.**

- [ ] T600 [GATED] Request explicit approval, then extend `packages/contracts/openapi/catalog/unknown-items.yaml` with two new operationIds: `tenantAdminLinkUnknownItem` (POST `…/unknown-items/:id/link`, request body carries `{ productId: string }`, tenant admin role required) and `tenantAdminCreateProductFromUnknownItem` (POST `…/unknown-items/:id/create-product`, request body carries `{ name: string, taxCategory: string }`, tenant admin role required). Both endpoints follow the error taxonomy from [research.md §R2](./research.md): `alias_conflict` → 409, `target_unavailable` → 409, `already_reconciled` → 409, cross-tenant `not-found` → 404 non-disclosing. Schema shapes align with [data-model.md §2.6–§2.7](./data-model.md). Predecessors: T503 (Wave 1 YAML already merged). Acceptance: YAML lints clean; both operationIds are present and ref-resolved.
- [ ] T601 [GATED] [P] If the conformance-test entrypoint requires an explicit registration step for the updated YAML, perform it. If the validator auto-discovers YAML files mark complete-no-op. Predecessors: T600. Acceptance: conformance test covers both new operationIds.

---

## 16. Phase 3 (Wave 2) — US3: Alias conflicts fail closed (safety floor)

**Goal**: When a link or create-new action would produce a `product_aliases` row that violates one of the three partial unique indexes, the operation fails closed with 409 `alias_conflict`, emits the `duplicate_alias_conflict` signal defined in 003 §9 (FR-043), and leaves `unknown_items` in its prior `pending` state. Non-disclosing: the conflicting product is NOT named in the response (FR-042).

**Why US3 precedes US2**: Both link and create-new attempt an alias INSERT. The conflict-rejection path is the error branch every service test must be able to trigger. Authoring the conflict test harness first (Phase 3) means Phase 4 and Phase 5 RED tests can exercise the conflict rejection alongside the happy path within the same spec file.

> **Note — FR-043 `catalog_duplicate_alias_conflict_total` counter**: spec §7 and data-model.md §9 anchor this to a Prometheus counter defined in 003 §9. The 003 canonical name is **`catalog_duplicate_alias_conflict_total`** (see `specs/003-catalog-foundation/tasks.md` lines 581/594). As of 2026-05-24 this counter is NOT yet registered in `CATALOG_METRIC_NAMES` in `apps/api/src/observability/metrics/api.metrics.ts` — it is a 003 Wave 2 task, not Wave 1. Before authoring T650's RED test, verify if `catalog_duplicate_alias_conflict_total` has since landed. If absent: add it to `CATALOG_METRIC_NAMES` and the corresponding `assertMetricLabels` call in `api.metrics.ts` as a prerequisite step within the `005-WAVE2-METRICS` slice (that slice's `allowed_files` includes `api.metrics.ts` for this purpose), then note the addition as a finding in `wave-status.md`.

- [ ] T610 [P] [TC] RED test — `apps/api/test/catalog/reconciliation/conflict/alias-conflict.spec.ts` covering [FR-040, FR-041, FR-042, FR-043]: seed two tenants (T_A, T_B) and two pending unknown items in T_A (U1 with `barcode='X'`, U2 with `barcode='X'`). Tenant admin at T_A attempts to link U1 to product P1 (which already has an alias for `barcode='X'`) → 409 `alias_conflict`, U1 status remains `pending`, no `product_aliases` row added, no resolved product name in response body (FR-042). Separately verify `catalog_duplicate_alias_conflict_total` counter increments (verify registration per Phase 3 Note above). Cross-tenant probe: T_B attempting to link T_A's unknown item → 404 non-disclosing. Predecessors: T600, T506 (seed helper). Acceptance: test runs, all cases fail (no reconciliation service exists).
- [ ] T611 [TC] RED test — `apps/api/test/catalog/reconciliation/conflict/store-scoped-conflict.spec.ts` covering [FR-040] store-scoped alias variant: seed a store-scoped alias for `(T_A, S1, barcode, 'Y')` bound to product P2. Admin at T_A links a pending unknown item with `barcode='Y'` from store S1 → 409 `alias_conflict`. Same admin links a pending unknown item from store S2 → this should succeed (different store scope). Predecessors: T600, T506. Acceptance: test runs, fails.

---

## 17. Phase 4 (Wave 2) — US2 #1: Tenant admin links unknown item to existing product (Priority: P1)

**Goal**: A tenant admin or store manager submits a link action on a pending unknown item referencing an existing, active `tenant_products` row. The result: exactly one `product_aliases` row is created linking the item's identifier to the product, and `unknown_items` is updated to `resolved` in the same transaction (FR-053). The action emits audit subject `unknown_item.resolved.linked`.

**Independent test**: Admin links U1 → P1. Verify: (a) exactly one `product_aliases` row for `(T, identifier_type, value)`; (b) `unknown_items.resolution_status = 'resolved'`, `resolution_action = 'linked'`, `resolved_product_id = P1.id`; (c) one audit event `unknown_item.resolved.linked`; (d) `unknown_item_resolved_total{action='linked'}` incremented; (e) parallel admin at another tenant cannot see T's product or alias.

> **FR-051 active-product check**: `TenantCatalogService` has no `findActive` method (T350 only ships `create`). Wave 2 reads `tenant_products` directly under the existing RLS inside the same `runWithTenantContext` transaction — a cross-tenant or non-existent product returns 0 rows from the SELECT, producing a non-disclosing 404 (never "product not found in tenant X").

> **Race / already-reconciled (US3 #3)**: The final UPDATE uses `WHERE resolution_status='pending'`. If `rowCount = 0` after a successful alias INSERT the item was concurrently resolved — rollback the alias INSERT (the entire transaction aborts) and return `already_reconciled` 409.

### 17.1 Link happy path

- [ ] T620 [P] [US2] [TC] RED test — `apps/api/test/catalog/reconciliation/link/link-happy-path.spec.ts` covering [FR-050, FR-051, FR-052, FR-053]: seed one pending unknown item U1 (barcode 'A') and one active product P1 (with no alias for 'A'). Tenant admin links U1 → P1. Assert: (a) `product_aliases` row exists for `(T, product_id=P1.id, identifier_type='barcode', value='A')`; (b) `unknown_items.resolution_status='resolved'`, `resolved_product_id=P1.id`, `resolution_action='linked'`; (c) one audit event `unknown_item.resolved.linked`; (d) counter `unknown_item_resolved_total{action='linked'}` increments; (e) the two writes committed atomically — simulate by injecting a fault between alias INSERT and unknown_items UPDATE and verify neither persists. Predecessors: T600, T610 (conflict harness exists). Acceptance: test runs, fails (no reconciliation service).
- [ ] T621 [US2] Create `apps/api/src/catalog/reconciliation/reconciliation.service.ts` with method `linkUnknownItem(principal: CatalogPrincipal, unknownItemId: string, productId: string): Promise<ReconciliationResult>`. Inside a single `runWithTenantContext` call: (1) SELECT `unknown_items` WHERE `id=$1 AND resolution_status='pending'` — 0 rows → `not-found` or `already-reconciled` discriminated by `resolution_status` of the existing row; (2) SELECT `tenant_products` WHERE `id=$2 AND retired_at IS NULL` — 0 rows → `target-unavailable` 404 (non-disclosing — do not expose whether the product exists cross-tenant); (3) INSERT into `product_aliases` the linking row — unique violation → `alias-conflict` 409 (FR-040/FR-042); (4) UPDATE `unknown_items SET resolution_status='resolved', resolved_at=now(), resolved_by=$actor, resolution_action='linked', resolved_product_id=$productId WHERE id=$1 AND resolution_status='pending'` — `rowCount=0` → rollback + `already-reconciled` 409. Map `23505` unique violation to `ConflictException` with `error.code='alias_conflict'`. All other Postgres errors re-thrown. Predecessors: T620. Acceptance: T620 GREEN.
- [ ] T622 [US2] Create `apps/api/src/catalog/reconciliation/reconciliation.controller.ts` with `POST /tenants/:tenant_id/catalog/unknown-items/:id/link` mapped to `tenantAdminLinkUnknownItem` operationId from T600. Decorate with `@Auditable("unknown_item.resolved.linked")`. Zod `.strict()` validation on `{ productId: string (UUID) }`. Tenant-admin or store-manager role check via existing `@Roles(...)` guard. Predecessors: T600, T621. Acceptance: T620 still GREEN; conformance test for `tenantAdminLinkUnknownItem` passes.

### 17.2 Link against retired or cross-tenant product (FR-051 non-disclosing)

- [ ] T623 [P] [US2] [TC] RED test — `apps/api/test/catalog/reconciliation/link/link-target-unavailable.spec.ts` covering [FR-051, FR-092]: (a) link U1 → retired product P_retired → 409 `target_unavailable`; (b) link U1 → UUID belonging to another tenant's product (cross-tenant) → 404 non-disclosing (never reveals the product exists); (c) link U1 → non-existent UUID → 404 non-disclosing. In all three cases: U1 status remains `pending`, no alias row written. Predecessors: T621. Acceptance: test runs, fails.
- [ ] T624 [US2] Map the zero-row SELECT result in `linkUnknownItem` to the correct outcome: `retired_at IS NOT NULL` branch → `target-unavailable` 409; rows=0 branch (RLS filtered the row — cross-tenant or does not exist) → 404 with non-disclosing message per FR-092. Adjust the SELECT to include `retired_at` in the RETURNING columns so the service can discriminate. Predecessors: T623. Acceptance: T623 GREEN; T620 still GREEN.

### 17.3 Link of already-resolved item (race / monotonicity)

- [ ] T625 [P] [US2] [TC] RED test — `apps/api/test/catalog/reconciliation/link/link-already-reconciled.spec.ts` covering [FR-052, US3 #3]: simulate a concurrent resolution by directly UPDATEing `unknown_items.resolution_status='resolved'` via superuser pool (bypassing RLS) before the link service reads it. Then attempt link → 409 `already_reconciled`; no alias written; no audit event. Predecessors: T621. Acceptance: test runs, fails.
- [ ] T626 [US2] The `WHERE resolution_status='pending'` on the final UPDATE (step 4 of T621's implementation) already handles this race. This task verifies the already-reconciled discriminator is propagated as the correct HTTP shape (T623's test runs the assertion). If T625 fails for a different reason — e.g., the initial SELECT in step 1 fetched the row before the concurrent UPDATE landed — extend step 1 to re-check after alias INSERT using `SELECT … FOR UPDATE SKIP LOCKED`. Predecessors: T625. Acceptance: T625 GREEN; T620 still GREEN.

---

## 18. Phase 5 (Wave 2) — US2 #2: Tenant admin creates new product from unknown item (Priority: P1)

**Goal**: A tenant admin or store manager creates a new `tenant_products` row directly from a pending unknown item. The result: exactly one `tenant_products` row + exactly one `product_aliases` row (linking the new product to the identifier) + `unknown_items` updated to `resolved` — all three in a single transaction (FR-063). Audit subject: `unknown_item.resolved.created`.

**Independent test**: Admin creates product from U1 with `{ name: "Widget", taxCategory: "standard" }`. Verify: (a) one `tenant_products` row with correct `tenant_id` from principal (body-supplied `tenantId` discarded per Constitution §III / spec §5.2); (b) one `product_aliases` row for U1's identifier; (c) `unknown_items.resolution_status='resolved'`, `resolution_action='created'`; (d) one audit event `unknown_item.resolved.created`; (e) `unknown_item_resolved_total{action='created'}` incremented; (f) all three writes atomic.

> **No call to `TenantCatalogService.create`**: That service emits its own `catalog.product.create` audit event in-transaction (T351 lines 199–215). Calling it from `ReconciliationService` would produce a dual-audit row. `ReconciliationService.createProductFromUnknownItem` owns the raw `INSERT INTO tenant_products` SQL directly, using its existing `runWithTenantContext` client. The audit subject emitted is `unknown_item.resolved.created` — NOT `catalog.product.create`.

> **Constitution §III backend authority**: The body-supplied `tenantId`, if any, is discarded. The persisted `tenant_products.tenant_id` is always taken from `principal.tenantId` (mirrors T351's approach).

### 18.1 Create-new happy path

- [ ] T630 [P] [US2] [TC] RED test — `apps/api/test/catalog/reconciliation/create/create-happy-path.spec.ts` covering [FR-060, FR-061, FR-062, FR-063]: seed one pending unknown item U1 (identifier `barcode='B'`). Admin submits `{ name: "Widget", taxCategory: "standard" }`. Assert: (a) new `tenant_products` row with `name='Widget'`, `tenant_id=T_A`, `retired_at=null`; (b) `product_aliases` row for `(T_A, product_id=<new>, identifier_type='barcode', value='B')`; (c) `unknown_items.resolution_status='resolved'`, `resolution_action='created'`, `resolved_product_id=<new>`; (d) one audit event `unknown_item.resolved.created`; (e) counter `unknown_item_resolved_total{action='created'}` increments; (f) atomicity fault injection: simulate INSERT tenant_products succeeds but alias INSERT fails → both tenant_products row AND unknown_items UPDATE must be absent. Predecessors: T600, T610 (conflict harness). Acceptance: test runs, fails.
- [ ] T631 [US2] Extend `ReconciliationService` (T621) with method `createProductFromUnknownItem(principal: CatalogPrincipal, unknownItemId: string, input: { name: string; taxCategory: string }): Promise<ReconciliationResult>`. Inside the same `runWithTenantContext` pattern: (1) SELECT `unknown_items` WHERE `id=$1 AND resolution_status='pending'` — 0 rows → discriminate `not-found` vs `already-reconciled`; (2) validate `name.trim()` + `taxCategory.trim()` non-empty (throw 400 before any write if either empty — mirrors T351's validation); (3) INSERT into `tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)` with `tenant_id=principal.tenantId` (body-supplied tenantId discarded per Constitution §III); (4) INSERT into `product_aliases` linking `(tenantId, productId=<new>, identifierType=U1.identifier_type, value=U1.value, sourceSystem=U1.source_system, storeId=U1.store_id)` — unique violation → `alias_conflict` 409 (rollback both product + unknown_items UPDATE); (5) UPDATE `unknown_items SET resolution_status='resolved', resolution_action='created', resolved_product_id=<new>, resolved_at=now(), resolved_by=$actor WHERE id=$1 AND resolution_status='pending'` — rowCount=0 → rollback all + `already_reconciled` 409. Predecessors: T630. Acceptance: T630 GREEN.
- [ ] T632 [US2] Create `POST /tenants/:tenant_id/catalog/unknown-items/:id/create-product` in `ReconciliationController` mapped to `tenantAdminCreateProductFromUnknownItem` operationId from T600. Decorate with `@Auditable("unknown_item.resolved.created")`. Zod `.strict()` validation on `{ name: string, taxCategory: string }` (both required non-empty). Tenant-admin role check. Predecessors: T600, T631. Acceptance: T630 still GREEN; conformance test for `tenantAdminCreateProductFromUnknownItem` passes.

### 18.2 Create-new with alias conflict (US3 path from create side)

- [ ] T633 [P] [US2] [TC] RED test — `apps/api/test/catalog/reconciliation/create/create-alias-conflict.spec.ts` covering [FR-040, FR-042, FR-063]: seed P_existing with an alias for `(T_A, barcode, 'C')`. Seed U1 with `barcode='C'`. Admin creates product from U1 → 409 `alias_conflict`, no new `tenant_products` row, U1 status remains `pending`, `duplicate_alias_conflict` counter increments, conflicting product not named in response (FR-042). Predecessors: T631. Acceptance: test runs, fails.
- [ ] T634 [US2] Verify that the `23505` catch in `createProductFromUnknownItem` (step 4 in T631) correctly rolls back the `tenant_products` INSERT as well as the unknown_items UPDATE. Since all three writes are in the same `runWithTenantContext` transaction, a PG-level rollback triggered by the re-thrown `ConflictException` is sufficient — the transaction client aborts automatically when the `work` callback throws. Add the `duplicate_alias_conflict` counter increment to the conflict catch site. Predecessors: T633. Acceptance: T633 GREEN; T630 still GREEN.

### 18.3 Create-new body validation and Constitution §III non-trust

- [ ] T635 [P] [US2] [TC] RED test — `apps/api/test/catalog/reconciliation/create/create-validation.spec.ts` covering [FR-063, Constitution §III]: (a) missing `name` → 400; (b) empty string `name` after trim → 400; (c) body supplies `tenantId: "attacker-tenant"` — persisted `tenant_products.tenant_id` is always `principal.tenantId`, not body value; (d) missing `taxCategory` → 400. Predecessors: T631. Acceptance: test runs, fails.
- [ ] T636 [US2] Ensure the Zod DTO for the create-product endpoint uses `.strict()` and explicitly rejects any body-supplied `tenantId` field (or silently ignores it — the service already discards it; the DTO should not accept it to avoid confusion). Predecessors: T635. Acceptance: T635 GREEN.

---

## 19. Phase 6 (Wave 2) — Audit, metrics, and cross-cutting verification

**Purpose**: Verify that all three Wave 2 audit subjects emit correctly, all Wave 2 counters increment at the right sites, and Wave 1 regression suites are not perturbed.

### 19.1 Audit event emission verification (Wave 2 subjects)

- [ ] T640 [P] [US5] [TC] RED test — `apps/api/test/catalog/reconciliation/audit/link-audit.spec.ts` covering [FR-080]: link action emits exactly one `audit_events` row with subject `unknown_item.resolved.linked`, attributed to the tenant admin actor, with correct `target_id = unknown_item.id` and `correlation_id`. Predecessors: T621. Acceptance: test runs, fails if `@Auditable` on the link route is missing or wired incorrectly.
- [ ] T641 [US5] If T640 fails, fixup the `@Auditable("unknown_item.resolved.linked")` decorator on the link route (T622) or the inline emit call. Predecessors: T640. Acceptance: T640 GREEN.
- [ ] T642 [P] [US5] [TC] RED test — `apps/api/test/catalog/reconciliation/audit/create-audit.spec.ts` covering [FR-080]: create-new action emits exactly one `audit_events` row with subject `unknown_item.resolved.created`. No `catalog.product.create` audit row present (dual-emission guard). Predecessors: T631. Acceptance: test runs, fails.
- [ ] T643 [US5] If T642 fails or if the dual-emission guard trips (two audit rows), fixup the `@Auditable` decorator or service call. The `ReconciliationService` must NOT emit `catalog.product.create` — only `unknown_item.resolved.created`. Predecessors: T642. Acceptance: T642 GREEN, dual-emission guard GREEN.
- [ ] T644 [P] [US5] [TC] RED test — `apps/api/test/catalog/reconciliation/audit/conflict-audit.spec.ts` covering [FR-043, FR-082]: alias-conflict rejection (from either link or create-new) emits `unknown_item.reconciliation_conflict_rejected{reason="alias_conflict"}` audit event. Target-unavailable rejection emits `unknown_item.reconciliation_conflict_rejected{reason="target_unavailable"}`. Already-reconciled rejection emits `unknown_item.reconciliation_conflict_rejected{reason="already_reconciled"}`. Predecessors: T621, T631. Acceptance: test runs, fails.
- [ ] T645 [US5] Wire the conflict-rejection audit emissions at the service catch sites in `ReconciliationService`. These are explicit calls — the `AuditEmitterInterceptor` short-circuits before the handler on exception paths, so decorator-driven emission does not fire for 4xx rejections. Predecessors: T644. Acceptance: T644 GREEN.

### 19.2 Observability counter verification (Wave 2)

- [ ] T650 [P] [US5] [TC] RED test — `apps/api/test/catalog/reconciliation/audit/metrics.spec.ts` covering [FR-081]: (a) successful link → `unknown_item_resolved_total{action='linked'}` increments; (b) successful create-new → `unknown_item_resolved_total{action='created'}` increments; (c) alias conflict rejection → `catalog_duplicate_alias_conflict_total` (003 canonical name — see Phase 3 Note above; verify registration in `CATALOG_METRIC_NAMES` before authoring, add if absent) increments. Predecessors: T621, T631, T610 (conflict path). Acceptance: test runs, fails.
- [ ] T651 [US5] Add explicit counter-increment calls at each Wave 2 emission site. All three action labels (`linked`, `created`, `dismissed`) on `unknown_item_resolved_total` were registered in T501 — Wave 2 just adds the `linked` and `created` increment call sites. Predecessors: T650. Acceptance: T650 GREEN; Wave 1 counter tests (T552) still GREEN.

### 19.3 Regression sweeps

- [ ] T660 [P] [TC] Regression sweep — confirm Wave 1 capture + idempotency + dismiss tests are all still GREEN after Wave 2 service + controller are registered in the NestJS module graph. Predecessors: T621, T631, T622, T632. Acceptance: all Wave 1 spec files pass at the counts recorded after each Wave 1 slice merged.
- [ ] T661 [P] [TC] Regression sweep — confirm 003 isolation suites (T341–T344) are still GREEN after Wave 2 reconciliation writes are wired. Predecessors: T621, T631. Acceptance: 003 isolation suites pass at their established counts.
- [ ] T662 [P] [TC] SC-007 transactional integrity verification — the spec requires atomicity (FR-053, FR-063). Author `apps/api/test/catalog/reconciliation/integrity/atomicity.spec.ts` injecting faults at each write boundary (alias INSERT throws → verify `unknown_items` not updated; unknown_items UPDATE rowCount=0 → verify alias INSERT rolled back for link; tenant_products INSERT throws → verify alias + unknown_items not persisted for create-new). Use Testcontainers + `ROLLBACK TO SAVEPOINT` or connection-level error injection. Predecessors: T621, T631. Acceptance: all fault-injection cases confirm full rollback.

---

## 20. Phase 7 (Wave 2) — Polish & Wave 2 closeout

**Purpose**: Update wave-status.md with Wave 2 authoring and execution state; update slice dispatch table with Wave 2 slices.

- [ ] T670 Update `specs/005-pos-catalog-sync-reconciliation/wave-status.md` to reflect Wave 2 tasks authored (T600–T670), slices proposed (`005-WAVE2-CONTRACT`, `005-WAVE2-CONFLICT`, `005-WAVE2-LINK-HAPPY`, `005-WAVE2-LINK-EDGES`, `005-WAVE2-CREATE-HAPPY`, `005-WAVE2-CREATE-EDGES`, `005-WAVE2-AUDIT`, `005-WAVE2-METRICS`, `005-WAVE2-POLISH`), dependency-cleared note referencing PR #300, #301, #302, #303, #310. Predecessors: all Wave 2 tasks merged. Acceptance: file updated; Wave 2 slices listed under "Proposed".

---

## 21. Wave 2 — Dependencies & ordering

### 21.1 Phase ordering (strict)

```
Phase 2-W2 (Gated contract: T600–T601)   ← [GATED] requires approval first
   ↓
Phase 3-W2 (US3 conflict safety floor: T610–T611)
   ↓
Phase 4-W2 (US2 #1 link: T620–T626)   ← T610/T611 conflict harness must pre-exist
   ↓
Phase 5-W2 (US2 #2 create-new: T630–T636)   ← T621 (ReconciliationService) already exists
   ↓
Phase 6-W2 (Audit + metrics + regressions: T640–T662)
   ↓
Phase 7-W2 (Polish: T670)
```

### 21.2 Parallel opportunities within Wave 2

- **Phase 3**: T610 + T611 are parallel-safe (disjoint spec files, different alias-conflict scenarios).
- **Phase 4 RED tests**: T620 + T623 + T625 are parallel-safe (disjoint spec files). GREENs (T621, T624, T626) serialize through `reconciliation.service.ts`.
- **Phase 5 RED tests**: T630 + T633 + T635 are parallel-safe. GREENs (T631, T634, T636) serialize through `reconciliation.service.ts`.
- **Phase 6**: T640 + T642 + T644 + T650 + T660 + T661 + T662 are all parallel-safe. Fixup tasks (T641, T643, T645, T651) follow their respective RED results.

### 21.3 Recommended Wave 2 slice dispatch (under Maestro)

| Slice | Tasks | Approval | Reviewer focus |
|---|---|---|---|
| `005-WAVE2-CONTRACT` | T600, T601 | **`[GATED]`** | OpenAPI YAML — verify operationIds, error shapes, role annotations |
| `005-WAVE2-CONFLICT` | T610, T611 | none | US3 conflict harness; disjoint spec files, parallel-safe |
| `005-WAVE2-LINK-HAPPY` | T620, T621, T622 | none | Link happy path; `ReconciliationService` created here |
| `005-WAVE2-LINK-EDGES` | T623, T624, T625, T626 | none | Target-unavailable + already-reconciled |
| `005-WAVE2-CREATE-HAPPY` | T630, T631, T632 | none | Create-new happy path; extends `ReconciliationService` |
| `005-WAVE2-CREATE-EDGES` | T633, T634, T635, T636 | none | Create alias conflict + validation |
| `005-WAVE2-AUDIT` | T640–T645 | none | All three Wave 2 audit subjects; dual-emission guard |
| `005-WAVE2-METRICS` | T650, T651 | none | Counter increments at link + create-new sites |
| `005-WAVE2-POLISH` | T660, T661, T662, T670 | none | Regression sweeps, atomicity verification, closeout |

Approx **9 slices** for Wave 2.

### 21.4 Stop conditions (Wave 2)

A slice MUST stop and report rather than silently work around the following:

- Any task would touch `packages/db/drizzle/**` or `packages/db/src/schema/**` — Wave 2 introduces zero schema work (data-model.md §5). Stop and report.
- Any task would touch `specs/003-catalog-foundation/**` — 003 is read-only for 005.
- T600 (Wave 2 contract YAML extension) is being worked without explicit `[GATED]` approval.
- A phase 4/5 GREEN task passes locally but a Wave 1 regression suite has a new failure — fix before proceeding.
- T642 reveals a dual-audit row (both `catalog.product.create` and `unknown_item.resolved.created`) — stop, investigate the `@Auditable` decorator placement and the `ReconciliationService` call site, fix before T643.
- T662 (atomicity) reveals any partial-commit case — Wave 2 may not ship with known atomicity gaps.
