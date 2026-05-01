# @data-pulse-2/auth

Authentication primitives shared between `apps/api` and `apps/worker`.

## Planned contents (not yet implemented)

Per [research T-3](../../specs/001-foundation-auth-tenant-store/research.md)
and [tasks T040–T045](../../specs/001-foundation-auth-tenant-store/tasks.md):

- **argon2id password helper** — hash/verify using the `argon2` Node package
  with OWASP 2025 defaults. Constant-time verify.
- **Token-hash helper** — SHA-256 hashing of bearer tokens. Server stores only
  the hash; the wire token is never written to disk or logged.
- **Session/token shape types** — the type contract used by repositories in
  `apps/api`.

## Status

Skeleton only. No source files. No dependencies. Implementation lands in a
later branch.

## Out of scope here

Concrete repository implementations (`SessionRepository`, `AuthTokenRepository`,
`AuthService`, `AuthController`, `AuthGuard`, rate-limit helper) live in
`apps/api/src/auth/` and are not in this package — this package is the
shared foundation only.
