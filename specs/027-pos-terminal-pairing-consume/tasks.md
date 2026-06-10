# Tasks — 027 POS Terminal-Pairing CONSUME

> One vertical, one migration (`0024`), anonymous consume. Stop at the commit
> boundary.

## T001 — Migration `0024_pairing_codes.sql` (+ `.down.sql`)
Create `pairing_codes` per data-model.md: FK `tenant_id`/`store_id`, UNIQUE
`code_hash` BYTEA, inline snapshot columns with CHECKs (non-empty + printer hex
pattern), `status` CHECK, `expires_at`, attempt accounting, nullable
`device_id` FK → devices, RLS ENABLE+FORCE with empty-GUC CASE guard + SELECT /
INSERT / UPDATE policies (no DELETE), `updated_at` trigger. DOWN drops the table.

## T002 — DTO `dto/terminal-pair.dto.ts`
Zod `TerminalPairRequestSchema` (`pairing_code` 6–32, `additionalProperties:false`
via `.strict()`); `TerminalPairResponseBody` type; `toBody()` projection mapping
DB row + raw token → the 11-field snake_case envelope (printer_com_port nullable).

## T003 — Repository `pairing.repository.ts`
`findByCodeHash` (bare admin pool, hash probe, returns row or null);
`incrementAttempt`; `burnAndProvision` (inside `runWithTenantContext`: guarded
`UPDATE … WHERE status='pending'` → insert `devices` row with
`hashToken(rawToken)` → set `device_id`,`used_at`). `findActiveDeviceForTerminal`
for the ALREADY_PAIRED / BRANCH_MISMATCH check.

## T004 — Service `pairing.service.ts`
Orchestrate the consume flow + the closed result union
(`ok|invalid|expired|already_paired|branch_mismatch|rate_limited`). Mint
`generateRawToken()`. NEVER log token/code.

## T005 — Controller `pairing.controller.ts`
`@Controller()` NO guard. `@Post("api/pos/v1/terminals/pair")` `@HttpCode(200)`.
ZodValidationPipe on the body. Map the service result union → the exact HTTP
status + `error.code` (set `Retry-After` for 429). Return `toBody` on ok.

## T006 — Module + registration
`PairingModule` imports `AuthModule` (for `PG_POOL`). Register in `app.module.ts`
imports array (tail-append, no reorder).

## T007 — Tests
- Keep `apps/api/test/pos-terminal-pairing/pairing.contract.spec.ts` GREEN
  (structural; do not edit).
- Unit: error-code mapping for each branch; redaction (token/code never logged).
- DB-integration (Testcontainers): migration applies; RLS fail-closed; seeded
  pending code → 200 with token; replay → 410; unknown → 404; expired → 410;
  already-paired same/diff branch → 409; the returned token resolves via
  `DeviceRepository.findActiveByAttestation` (the PosDeviceAuthGuard path).
- Migration spec `0024-pairing-codes.spec.ts` mirroring `0021`'s structure.

## T008 — Validation
`pnpm -r run build`; pairing contract test; db-integration; lint. Report real
output. STOP at commit boundary; produce the COMMIT READY block.
