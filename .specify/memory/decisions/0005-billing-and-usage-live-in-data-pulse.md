# ADR 0005 — Billing and Usage Metering Live in Data-Pulse-2

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Feature / Ref**: Architecture operating model — [docs/architecture/](../../../docs/architecture/retail-tower-operating-model.md)

---

## Context

Billing/subscriptions and usage metering are commercial (Business) capabilities.
A recurring temptation is to spin them into a standalone "billing service" repo
early. But billing truth is tightly coupled to tenant identity and is PII- and
money-sensitive: the Constitution designates billing/subscriptions and
reports/analytics as owned by Data-Pulse-2 (§Repository Scope), requires backend
authority over data integrity (§III), tenant isolation (§II), and PII/data-
lifecycle discipline (§XIV). This ADR records that billing and usage metering
remain **backend modules in Data-Pulse-2** — not a separate repository — with
their management screens in Retail-Tower-Console.

This ADR is documentation only.

---

## Decisions

### D1. Billing and usage metering are backend modules in Data-Pulse-2

The billing backend (subscriptions, invoices, plan logic) and usage metering
(usage events, aggregation) live as modules in Data-Pulse-2, alongside the tenant
and audit data they depend on.

### D2. Console owns billing UI; backend owns billing truth

Retail-Tower-Console renders billing/usage screens and workflows. All amounts,
plan state, and metered usage are computed and stored authoritatively in the
backend (§III). Money follows the Constitution's money/tax/rounding standards.

### D3. No separate billing repository now

Billing does not earn its own repository on size or "it's billing" alone. A split
would require a clear deployment/data-lifecycle/security/team boundary per
[future-repo-split-criteria.md](../../../docs/architecture/future-repo-split-criteria.md)
— none exists today.

| Alternative considered | Ruled out because |
|---|---|
| Standalone billing service repo now | Billing truth is tenant- and PII-coupled; splitting early adds a cross-repo contract over the most sensitive data with no lifecycle benefit yet. |
| Billing logic in Retail-Tower-Console | Puts money/authorization decisions in a UI repo; violates §III. |
| Third-party billing as source of truth | Defers tenant-coupled truth outside the backend; revisit only if a provider integration is specced. |

---

## Consequences

- Billing and usage stay close to tenant identity, audit, and PII controls — one
  RLS-protected boundary instead of two.
- Commercial features ship as modules without standing up new infrastructure.
- **Tradeoff**: the backend repo carries commercial concerns alongside core
  platform; accepted because the data coupling is real and the split criteria are
  not yet met.
- A future payment-provider integration (Stripe et al.) is compatible with this
  decision — the provider is a dependency of the backend module, not a relocation
  of truth.

---

## Rejected alternatives

- **Standalone billing repo now** — rejected (D3 table): premature.
- **Billing logic in the Console UI** — rejected (D3 table): §III violation.
- **External provider as source of truth** — rejected (D3 table): truth must stay
  tenant-coupled in the backend.

---

## Hard out-of-scope

- Implementing billing, subscriptions, invoicing, or usage metering.
- Selecting a payment provider.

---

## Constitution Alignment

| Principle | Relationship |
|---|---|
| II. Multi-Tenant SaaS by Default | strengthened — billing data is tenant-scoped under RLS |
| III. Backend Authority & Data Integrity | strengthened — money/plan truth in the backend |
| XIV. PII & Data Lifecycle Discipline | strengthened — billing PII stays under backend controls |
| §Money, Tax, and Rounding | applies to all amounts |

No principle tension.

---

## Open Questions

1. Will a third-party payment provider be integrated, and under what spec?
   (Deferred.)

---

## Follow-up work

- An implementation spec for billing/usage when prioritized.
- If a provider integration is added, record the data-flow and PII implications.

---

## References

- [docs/architecture/product-capability-map.md](../../../docs/architecture/product-capability-map.md)
- [Constitution §II, §III, §XIV, §Repository Scope, §Money, Tax, and Rounding](../constitution.md)
- [docs/architecture/future-repo-split-criteria.md](../../../docs/architecture/future-repo-split-criteria.md)
