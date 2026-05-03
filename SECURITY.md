# Security Policy

Data-Pulse-2 is a multi-tenant SaaS backend foundation. Security-sensitive
changes include authentication, authorization, tenant isolation, session and
token handling, database migrations, worker queues, logging, and OpenAPI
contracts.

## Reporting a Vulnerability

If GitHub private vulnerability reporting is enabled for this repository, use
that channel first.

If private reporting is not available, contact the maintainers through GitHub
and request a private disclosure channel. Do not publish exploit details,
secrets, credentials, tokens, tenant data, or proof-of-concept payloads in a
public issue.

## What To Include

- A concise description of the affected component.
- The impact, including whether tenant isolation or backend authorization can
  be bypassed.
- Minimal reproduction steps that avoid real user, tenant, or credential data.
- Suggested remediation if known.

## Security Expectations

- Passwords use argon2id helpers from `packages/auth`.
- Bearer tokens are stored only as server-side SHA-256 hashes.
- Tenant-owned data must be scoped at API and database layers.
- Logs must include useful request and tenant context without secrets or PII.
- Redis must never become the source of truth for durable domain state.
- Production API and worker runtime wiring should fail closed when required
  infrastructure is missing.
