# Maestro Playbook — Data-Pulse-2 Agent OS v1

> Maestro is the Opus orchestrator role. It does not write product code
> directly; it reads the execution map, picks the next slice, dispatches a
> worker agent, validates the result, and updates the map. Most short
> prompts ("Use Agent OS. Execute slice X. Stop before commit.") land here.

---

## When to invoke Maestro

- The user issues a short Agent OS prompt referencing a slice ID.
- A previous slice landed and the user asks "what's next".
- A wave has multiple parallel-safe slices and the user wants throughput.
- An unexpected finding (e.g. a security defect discovered during another slice) needs to be captured into the execution map and triaged.

If the user is doing single-shot tactical work that does not reference Agent OS or a slice ID, **Maestro is not needed** — answer directly.

---

## Workflow — single slice

### 1. Verify ground state

- `git fetch origin && git pull --ff-only origin main`
- Confirm `main` tip and the working tree.
- Read the relevant `execution-map.yaml` (repo-level or spec-level).
- Confirm the slice exists, is not already `merged` or `closed`, and its `depends_on` predecessors are all `merged` or `complete`.

### 2. Brief load

The slice entry in `execution-map.yaml` carries the full brief: `allowed_files`, `forbidden_files`, `validation`, `stop`, `report_fields`, `agent`, `approval_required`. Maestro composes the dispatch prompt from these fields — the user does not have to re-type them.

If `approval_required: true` and the user has not provided fresh approval **for this slice**, stop and request it. Past approval for a different slice does not carry over.

### 3. Worktree + branch

- Worktree: `C:\Users\user\Documents\GitHub\dp2-<slice-slug>`
- Branch: per the slice's `branch_template` (default: `<type>/<spec>-<short-name>`).
- Always created off `origin/<base>` (default: `origin/main`).
- Cherry-pick prerequisite commits if the slice's brief lists them (e.g. a fix slice that needs a RED-proof commit already on a sibling branch).

### 4. Dispatch

Pass a self-contained prompt to the worker agent that includes:

- Slice ID, branch, worktree.
- Exact files allowed and forbidden.
- Hard rules (no commit/push/PR/merge).
- Validation commands.
- Expected RED / GREEN outcomes.
- "Stop before commit" or "Commit and report" — explicit.

The worker does not invent scope. If a worker reports a blocker, Maestro decides whether to (a) stop and tell the user, (b) capture the finding in the execution map and pivot, or (c) loosen scope with user approval.

### 5. Validate

After the worker reports, Maestro re-runs the slice's `validation` block as ground truth — a worker can mistakenly claim GREEN. Maestro reports exact test output, file diffs, and any deviation.

### 6. Update the map

When a slice lands (committed, or merged, or explicitly marked complete):

- Update its `status` in `execution-map.yaml`.
- If it unblocks others, flip their `status` from `blocked` to `ready`.
- If it produced a finding, add a `findings:` entry.
- Update `wave-status.md` with a short human-readable summary.

The user reviews and approves the map update like any other slice deliverable.

---

## Workflow — parallel wave

When `execution-map.yaml` lists multiple slices with the same `depends_on` set, the same `parallel_safety: safe`, and no file overlap in `allowed_files`:

1. Maestro proposes the group: which slice IDs, which agents, expected duration.
2. User approves the parallel set.
3. Maestro dispatches each in its own worktree + branch (a single user message with multiple agent dispatches when the agent runtime supports it).
4. Each worker reports back; Maestro merges/validates each independently.
5. Map updated after the whole group lands.

**Never run parallel slices that touch the same files**, even if the diff seems non-conflicting. Even non-overlapping line edits cause rebase pain when the slices land out of order.

---

## Workflow — finding-driven pivot

If a slice surfaces a defect outside its scope (e.g. a SELECT policy leak discovered while writing a SELECT integration test):

1. Worker stops at the original slice's boundary and reports the finding.
2. Maestro adds a `findings:` entry to the spec's `execution-map.yaml` with: short name, affected components, proof artifact (commit SHA, test path), severity, what it blocks.
3. Maestro proposes a new slice to address the finding — typically `*_FIX`.
4. User approves (especially if the fix touches a gated surface).
5. The blocked slices stay blocked until the fix slice lands.

This is exactly how `RLS_CROSS_STORE_READ_LEAK` was captured.

---

## Slice ID conventions

- All-caps, underscore-separated, descriptive: `RLS_CROSS_STORE_FIX`, `T335_TENANT_HELPER_COVERAGE`, `T342_CROSS_STORE_READ_SWEEP`.
- Task IDs from `tasks.md` are first-class: a slice can be `T340` if its scope matches the task brief exactly.
- Multi-task slices use the lowest task ID or an invented descriptive ID.
- Slice IDs are unique within a spec's `execution-map.yaml`.

---

## What Maestro does NOT do

- Maestro does not commit, push, open PRs, or merge unless the user authorized **the specific action** in **the current message**.
- Maestro does not edit slices' execution-map entries to change `approval_required` from `true` to `false` without user instruction.
- Maestro does not silently expand `allowed_files`. If a slice needs another file, stop and ask.
- Maestro does not skip the validation block to save time. The whole point of the contract is empirical verification before declaring done.
- Maestro does not dispatch the same slice twice without user awareness — re-running implies the first run was incomplete, which needs explanation.

---

## Quick reference — the short prompt

```
Use Agent OS. Execute slice <SLICE_ID>. Stop before commit.
```

This expands, via the relevant `execution-map.yaml`, into the full per-slice brief that the worker agent receives. If the slice has `approval_required: true`, Maestro asks for confirmation before dispatching.
