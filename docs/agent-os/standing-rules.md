# Data-Pulse-2 — Agent OS v1 Standing Rules

> These rules apply to **every** agent action in this repo unless the user
> explicitly overrides them. They are not negotiable defaults — they are
> hard contracts. When an agent says "Use Agent OS", these rules load with
> the slice.

---

## 1. Branch hygiene

- **Always start from latest `origin/main`.** `git fetch origin && git pull --ff-only origin main` before creating any branch or worktree. If the local `main` is dirty or cannot fast-forward, stop and report.
- **One worktree per slice.** Worktrees live under `C:\Users\user\Documents\GitHub\dp2-<short-slug>`. Never reuse a worktree across unrelated slices.
- **Branch names match slice intent:** `feat/`, `fix/`, `test/`, `docs/`, `chore/`, `refactor/`, `perf/`, `ci/`. Include the spec ID or task ID when one applies (e.g. `fix/003-catalog-rls-cross-store-read`).
- **Untracked sentinels are not yours.** `bin/`, `externals/`, and `docs/observability/operator-validation-report.md` are flagged in `CLAUDE.md` as "leave them alone". Do not stage, commit, or delete them.

## 2. Slice discipline

- **Small, reviewable slices.** One concern per branch. If a task brief lists more than ~3 logically related files to modify, ask whether it should be split before writing.
- **No combining unrelated work.** A test slice does not also rename variables. A migration slice does not also restructure helpers.
- **RED-then-GREEN where applicable.** Bug fixes ship as two commits when the proof is non-trivial: a test commit that reproduces the defect, then a fix commit that makes it pass. Reviewers benefit from being able to check out the RED commit alone.

## 3. Forbidden surfaces — gates required

Every slice's brief must list `allowed_files` and `forbidden_files`. By default, the following are **forbidden** and require explicit `[GATED]` approval in the slice brief:

- `package.json` (root) and any package-level `package.json`
- `pnpm-lock.yaml`
- `packages/db/drizzle/**` — SQL migrations
- `packages/contracts/openapi/**` — OpenAPI spec
- `.github/**` — CI workflows and configs
- Codecov / coverage / CI config files anywhere
- `packages/db/src/schema/**` when the change is structural (not type-only)

When a slice legitimately needs to touch one of these, the brief includes that path in `allowed_files` and the user has approved before any tool call.

## 4. Out-of-scope surfaces — never touch unless requested

These exist in the broader Data Pulse vision but are **not active work** and must not be modified unless the user explicitly asks:

- **POS** (separate repo — never edit POS code from this repo)
- **Dashboard / admin frontend** (future feature, deferred)
- **Billing**, **reports**, **analytics**
- **dbt**, **ClickHouse**, **Dagster** (data platform layer — not on this repo's roadmap)

If a brief implies touching one of these, stop and confirm before proceeding.

## 5. Git operations — never autonomous

- **Never `git add -A` or `git add .`.** Always stage by exact path. The user's CLAUDE.md is explicit about this — `-A` has accidentally swept in secrets and untracked dev artifacts in the past.
- **Never commit, push, open a PR, or merge without explicit instruction.** Asking once for a session does not authorize a second commit. Asking for commit does not authorize push. Asking for push does not authorize PR.
- **Never `--no-verify`, `--no-gpg-sign`, or force-push to `main`.** If a pre-commit hook fails, fix the underlying issue and create a new commit.
- **Never amend a published commit.** Always make a new commit.

## 6. Validation contract

Every slice's brief includes a `validation` block listing the test commands to run **before** declaring done. The agent runs them, reports the result verbatim, and **does not declare GREEN without empirical evidence** — a passing self-test is not evidence the slice works; only the user-specified validation commands are.

Standard local checks before commit:
- `git diff --check` (whitespace)
- forbidden-path audit (`git status --porcelain` filtered for forbidden surfaces)
- the slice's own `validation` commands

If Docker / Testcontainers is required and unavailable, **report clearly and do not weaken tests.** Do not add a default-skip behavior to make red turn green.

## 7. Stop conditions

The agent stops and reports — does not silently work around — when:

- The working tree is dirty in unexpected ways (files outside the slice's allowed list).
- A required input (file, helper, prior commit) does not exist.
- The slice brief implies touching a forbidden surface without a `[GATED]` allow.
- Validation produces a result that doesn't match the brief's `expected` field.
- A claimed predecessor (e.g. "this builds on PR #X") is not actually merged or accessible.
- Anything in the prompt is ambiguous about whether a gate is open.

"Scope creep" — making the slice 20% larger to fix something tangential — is a stop condition.

## 8. Reporting

End-of-slice reports always include:

- Worktree path and branch name
- Changed files (exact list, with line counts)
- Validation results (each command, pass/fail, key output)
- Forbidden-path check result (empty / list of violations)
- Confirmation that no commit/push/PR happened unless explicitly authorized
- Next recommended slice or next prompt the user can issue

## 9. Persistent context

- **Read `CLAUDE.md`** at session start. It carries machine-specific context (Windows + WSL Docker, miniforge3 Python, encoding rules) and project-specific rules.
- **Read `~/.claude/global-lessons.md` first** when debugging — many problems are already solved there.
- **Update memory** when you learn something durable (user preference, gotcha, project state change). Use the `MEMORY.md` index — do not write memory content into the index itself.

## 10. Maestro pattern

Long-running multi-slice work goes through a **Maestro** (Opus, orchestrator) who:

1. Loads the spec's `execution-map.yaml` to know slice state.
2. Selects the next slice based on dependency graph + user instruction.
3. Dispatches the slice with the per-slice brief.
4. Updates the execution map and `wave-status.md` when the slice lands.

This makes prompts short: **"Use Agent OS. Execute slice X. Stop before commit."** is enough because the slice ID resolves to the full brief in the execution map.
