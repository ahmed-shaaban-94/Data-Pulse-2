# PR Readiness Checklist: [PR Title]

**PR**: #NNN
**Author**: [name or role]
**Date**: YYYY-MM-DD
**Spec / Task**: [spec-id or T-NNN — omit if no associated task]
**Constitution**: vX.Y.Z

---

## Scope

- Change type: feat | fix | refactor | docs | test | chore
- Architecture impact level: None | Low | Medium | High | Critical

---

## Approval-Gated Changes (stop if any box is unchecked)

The following require explicit approval recorded before the PR is opened
(Constitution §VIII):

- [ ] No `package.json` or `pnpm-lock.yaml` changes — or approval recorded at: [link]
- [ ] No DB schema / Drizzle schema changes — or approval recorded at: [link]
- [ ] No SQL migration changes — or approval recorded at: [link]
- [ ] No OpenAPI / contract YAML changes — or approval recorded at: [link]

*(If none of the above apply, mark all four checked and note "N/A" after each.)*

---

## Architecture Impact Map

- [ ] Impact map is present in the spec or plan — or "Impact level: None" is
      asserted with a `Reason:` line
- Map location: [path to §Architecture Impact Map section, or "None — impact level None"]

---

## Constitution Check

Which Core Principles does this PR touch? State the relationship.

| Principle | Touched? | Notes |
|---|---|---|
| II. Multi-Tenant SaaS by Default | yes / no | |
| III. Backend Authority & Data Integrity | yes / no | |
| IV. Contract-First POS Integration | yes / no | |
| V. Async Work Belongs in Workers | yes / no | |
| VI. Test-First Quality | yes / no | |
| VII. Observable Systems | yes / no | |
| VIII. Reproducible & Versioned Releases | yes / no | |
| IX. Source-of-Truth Model | yes / no | |
| X. Retail Temporal Semantics | yes / no | |
| XI. Idempotency & External IDs | yes / no | |
| XII. Authorization & Object Safety | yes / no | |
| XIII. Auditability & Provenance | yes / no | |
| XIV. PII & Data Lifecycle Discipline | yes / no | |

---

## Testing (Principle VI)

- [ ] Tests written before implementation merged (RED → GREEN → IMPROVE)
- [ ] Cross-tenant sweep tests present (required for every new tenant-scoped endpoint)
- [ ] RLS bypass probe present (required for every new or changed RLS policy)
- [ ] Malicious-override tests present (required for new write endpoints with
      security-sensitive fields: `tenant_id`, `store_id`, `role`, `status`,
      `acceptedAt`, `createdBy`, etc.)
- [ ] Line coverage ≥ 80% for application code (or justify below)
- RLS test matrix: [link or "N/A — no new or changed RLS policy"]

Coverage justification if below 80%: ___

---

## Security (Principles III, XII)

- [ ] No hardcoded secrets, API keys, or tokens in any committed file
- [ ] All user inputs validated with `Zod.strict()` or equivalent (unknown keys
      rejected, not silently ignored)
- [ ] Authorization re-checked server-side on every protected operation
- [ ] Mass-assignment fields excluded from request schemas (`tenant_id`,
      `store_id`, `role`, `status`, `acceptedAt`, `createdBy`,
      `is_platform_admin`, `password_hash`, and equivalents)
- [ ] Cross-tenant lookups return safe 404 (not 403 or a resource-exists signal)

---

## Observability (Principle VII)

- [ ] Structured logs carry `request_id` / `correlation_id` and `tenant_id`
      where applicable
- [ ] No secrets, tokens, invitation secrets, payment data, raw POS payloads,
      or PII beyond actor identity in any log line or audit metadata field
- [ ] Audit events emitted for all sensitive operations (auth, role changes,
      tenant/store/membership mutations, platform-admin cross-tenant access)

---

## Supplementary Artifacts

Link to filled artifact, or mark "N/A" with the reason.

| Artifact | Link or N/A |
|---|---|
| Migration safety checklist | [link] / N/A — no migration |
| Redaction matrix | [link] / N/A — no new PII fields or log paths |
| Failure classification | [link] / N/A — no external provider |
| ADR | [link] / N/A — impact level not Critical |

---

> **When to use this template**
> Use as a personal self-check before opening or requesting review on any
> non-trivial PR: feature slices, architecture changes, migrations, worker
> additions, or contract changes. Fill it in the PR description or as a
> linked file. It consolidates the overlapping requirements from Principles
> II–XIV into one scannable surface so reviewer round-trips are fewer.
>
> **When NOT to use this template**
> Trivial documentation fixes (typos, wording, comment changes). Test-only
> changes to existing test fixtures with no production code change.
> Automated or bot PRs. Dependency bumps (those use the Constitution §VIII
> approval-gated path which is a different gate entirely).
