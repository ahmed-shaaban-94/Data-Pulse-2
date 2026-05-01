<!--
Sync Impact Report
==================
Version change: (none) → 1.0.0
Modified principles: N/A (initial ratification)
Added sections:
  - Core Principles (I–V)
  - Reference Repository Policy
  - dbt Architecture Standards
  - Governance
Removed sections: N/A
Templates requiring updates:
  ⚠ pending  .specify/templates/plan-template.md (not yet created)
  ⚠ pending  .specify/templates/spec-template.md (not yet created)
  ⚠ pending  .specify/templates/tasks-template.md (not yet created)
Follow-up TODOs:
  - TODO(RATIFICATION_DATE): confirmed as today by initial author; revise if formal adoption date differs.
  - Generate plan/spec/tasks templates via /speckit-plan, /speckit-specify, /speckit-tasks.
-->

# Data-Pulse-2 Constitution

## Core Principles

### I. Reference, Not Source of Truth
The legacy `Data-Pulse` repository (https://github.com/ahmed-shaaban-94/Data-Pulse) is
reference material **only**. Code, models, macros, and configurations from it MUST NOT
be copied verbatim into this repository without deliberate review and re-justification
against current standards. The legacy repo, when cloned locally for inspection, MUST
live under `/reference/` and MUST be listed in `.gitignore` so it never enters version
control. Decisions ("we did X in the old repo") require restatement in this repo's
specs before they become binding.

**Rationale**: Avoids inheriting unreviewed technical debt, naming drift, and stale
business logic. Forces every carry-over to pass the current Constitution Check.

### II. DataGraph-Driven dbt Architecture
All non-trivial dbt transformations MUST be designed as an explicit data graph (DAG)
before implementation. For any model whose lineage exceeds **5 upstream sources** OR
**3 layers of staging→intermediate→marts**, a graph artifact (dbt docs DAG export,
Mermaid diagram, or equivalent) MUST be committed under `docs/lineage/` and referenced
from the model's spec. Cross-cutting "huge routes" (long lineage chains, fan-out joins,
recursive SCD logic) MUST be decomposed via the graph so each node remains testable in
isolation.

**Rationale**: dbt's complexity grows multiplicatively with model count. A visible
graph keeps refactors safe, makes ownership explicit, and prevents the silent emergence
of hard-to-debug transformation routes.

### III. Test-First Data Quality (NON-NEGOTIABLE)
Every dbt model and Python data utility MUST ship with tests **written before** the
implementation is merged:
- dbt models: at minimum `unique` + `not_null` on the grain key, plus relationship and
  accepted-values tests where applicable.
- Python utilities: pytest with ≥80% line coverage, including one negative-path test.
- Pipelines: a contract test asserting expected schema and row-count bounds.

PRs that reduce coverage or remove tests without an explicit Constitution-level
justification MUST be rejected.

**Rationale**: Data bugs are silent and expensive. Tests are the only mechanism that
survives refactors and personnel changes.

### IV. Observable Pipelines
Every scheduled run (dbt build, Python ingest, orchestrator job) MUST emit:
- Structured logs (JSON or key=value) — no bare `print()` in production paths.
- A run summary record (status, duration, rows processed, tests passed/failed) to a
  durable location (database table, log aggregator, or run artifact).
- Clear failure exit codes; silent partial-success is forbidden.

Secrets MUST come from environment variables or a secret manager — never hardcoded,
never in `profiles.yml` committed to the repo.

**Rationale**: A pipeline you cannot observe is a pipeline you cannot trust. Silent
failure is the most expensive class of data incident.

### V. Reproducible & Versioned Transformations
- Every dbt model and Python module MUST be reproducible from a checked-out commit
  plus a documented environment (`requirements.txt`, `packages.yml`, `.python-version`).
- Schema-affecting changes MUST be released via a version bump and a migration note
  in `CHANGELOG.md`.
- One-off scripts that mutate data MUST be checked in under `scripts/oneoff/` with a
  dated filename and a header comment stating purpose, date, and operator.

**Rationale**: "It worked on my machine" and undocumented hotfixes are the two leading
causes of long-tail data incidents. Reproducibility is the floor, not a feature.

## Reference Repository Policy

The legacy `Data-Pulse` repo is treated as **read-only inspiration**:
- Clone it under `./reference/Data-Pulse/` only when actively consulting it.
- `.gitignore` MUST exclude `/reference/` and `**/Data-Pulse-old/`.
- Any pattern, model name, or macro lifted from it MUST be re-spec'd via
  `/speckit-specify` before being implemented here.
- Do not link to legacy paths in this repo's docs as if they were authoritative.

## dbt Architecture Standards

- **Layering**: `staging → intermediate → marts`. Cross-layer skips require justification
  in the model's spec.
- **Naming**: `stg_<source>__<entity>`, `int_<purpose>`, `<domain>__<entity>` for marts.
- **Materialization defaults**: `view` for staging, `table` for intermediate, `incremental`
  or `table` for marts (justify `incremental` strategy in model config comment).
- **DataGraph artifacts**: Lineage diagrams under `docs/lineage/` MUST be regenerated when
  a model gains/loses an upstream source. Stale diagrams are a CI-blockable offense once
  CI is wired up.

## Governance

This Constitution supersedes ad-hoc conventions and prior-repo habits. All PRs MUST
include a "Constitution Check" line in the description identifying which principles
the change touches. PRs that violate a principle MUST either (a) bring the change into
compliance, or (b) propose an amendment in the same PR with version bump and rationale.

**Amendment procedure**:
1. Open a PR that edits `.specify/memory/constitution.md` and increments the version.
2. Update the Sync Impact Report comment at the top.
3. Propagate changes to `.specify/templates/*.md` and any agent guidance files.
4. Merge requires explicit acknowledgement that dependent artifacts were reviewed.

**Versioning policy** (semantic):
- **MAJOR**: Backward-incompatible removal or redefinition of a principle/section.
- **MINOR**: New principle or materially expanded section.
- **PATCH**: Clarifications, wording fixes, non-semantic edits.

**Compliance review**: A lightweight review of constitution adherence SHOULD occur at
the close of each milestone or quarterly, whichever comes first. Findings feed back
into amendments.

**Version**: 1.0.0 | **Ratified**: 2026-05-01 | **Last Amended**: 2026-05-01
