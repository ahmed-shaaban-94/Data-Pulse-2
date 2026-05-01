<!--
Constitution-Check PR template — Data-Pulse-2 v2.0.0
Per .specify/memory/constitution.md §Governance, every PR MUST include a
Constitution Check identifying which principles the change touches.
-->

## Summary

<!-- One paragraph: what changes and why. -->

## Constitution Check (v2.0.0)

Tick every principle this PR touches. For ticked items, briefly note how
the change complies (or, if it does not, link to the amendment PR that
revises the constitution).

- [ ] **I. Reference, Not Source of Truth** — no legacy `Data-Pulse` content copied.
- [ ] **II. Multi-Tenant SaaS by Default** — tenant scoping at DB + API + tests.
- [ ] **III. Backend Authority & Data Integrity** (NON-NEGOTIABLE) — server-side authz, DB constraints, no cache-as-truth.
- [ ] **IV. Contract-First POS Integration** — versioned, authenticated, idempotent APIs.
- [ ] **V. Async Work Belongs in Workers** — webhooks, sync, retries, scheduled jobs.
- [ ] **VI. Test-First Quality** — tests written first; ≥80% coverage.
- [ ] **VII. Observable Systems** — structured logs with `tenant_id`/`request_id`, metrics, no secrets in logs.
- [ ] **VIII. Reproducible & Versioned Releases** — pinned envs, numbered migrations, versioned APIs.

## Scope confirmation

This PR does **not** introduce any of the following without an explicit
spec amendment:

- [ ] Dashboard / web UI work (deferred to a separate dashboard feature).
- [ ] POS application or POS sync endpoints (separate POS repository).
- [ ] Product catalog / inventory / orders / payments.
- [ ] Billing / subscriptions / metering.
- [ ] Reports / analytics dashboards / dbt or analytics pipelines.

## Test plan

<!-- Bulleted list. For backend changes: include cross-tenant + cross-store
isolation tests. For DB changes: include migration up/down + RLS verification. -->

- [ ] …

## Deployment / migration notes

<!-- Lock duration risk on large tables, rollback plan, feature-flag, etc.
Required for migrations or schema changes per Constitution Principle VIII. -->

## Linked spec / plan / tasks

<!-- e.g., specs/001-foundation-auth-tenant-store/plan.md §6 task T100 -->
