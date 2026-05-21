# Wave Status — `<spec-id>`

> Human-readable summary of where the spec stands. Mirrors and condenses
> `execution-map.yaml`. Maestro updates both together when a slice lands.

**Last updated:** `<YYYY-MM-DD>` by `<author>`
**Spec:** `<spec-id>` (`specs/<spec-id>/`)
**Base:** `origin/main` at `<short-sha>`
**Active finding(s):** `<count>` — see [Active findings](#active-findings)

---

## TL;DR

One paragraph. What is done, what is blocked, what is the next move.

---

## Merged on `main`

| Slice ID | Subject | Commit / PR |
|---|---|---|
| `<T-NUM>` or `<SLICE_ID>` | `<short description>` | `<PR #>` or `<commit sha>` |

---

## Local only — committed/uncommitted, not on `main`

| Slice ID | Branch | Commit | Notes |
|---|---|---|---|
| `<SLICE_ID>` | `<branch>` | `<sha>` | `<why not merged yet>` |

If empty, write "_None._"

---

## Active findings

For each finding in `execution-map.yaml`, list:

### `<FINDING_ID>`

- **Summary:** one sentence
- **Affected:** `<components>`
- **Severity:** `<critical|high|medium|low>`
- **Proof:** `<commit sha or test path>`
- **Blocks:** `<slice ids>`
- **Resolved by:** `<slice id, if known>`

If empty, write "_None._"

---

## Blocked

| Slice ID | Blocked by | Notes |
|---|---|---|
| `<SLICE_ID>` | `<finding or slice id>` | `<one-line reason>` |

---

## Ready / approved — next to dispatch

| Slice ID | Type | Agent | Approval needed? | Notes |
|---|---|---|---|---|
| `<SLICE_ID>` | `<type>` | `<agent profile>` | `yes/no` | `<one-line>` |

---

## Proposed (awaiting approval)

Future slices that exist in the map as `status: proposed` — not yet
authorized for execution.

---

## Next recommended action

One paragraph. Which slice to run next, and why.

---

## Next short Maestro prompt

```text
Use Agent OS. Execute slice <SLICE_ID>. Stop before commit.
```

Substitute the slice ID. If the slice is gated, the user will be asked
to confirm approval before dispatch.
