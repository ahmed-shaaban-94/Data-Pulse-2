/**
 * DB metric definitions — T471 / Track B / P4.
 *
 * Registers every DB-layer signal from `docs/observability/signals.md` §2
 * with the OTel global Meter and exposes typed emission helpers.
 *
 * Label-policy enforcement (two layers):
 *   1. `assertMetricLabels` is called at module load for each signal.
 *      A forbidden or unregistered label throws immediately — it cannot
 *      reach a live SDK (FR-B-006, FR-B-012).
 *   2. Helper parameter types admit only the declared label keys. A call
 *      site cannot pass `tenant_id` because the helper's TypeScript
 *      signature excludes it (compile-time enforcement of FR-B-006).
 *
 * Observable gauges:
 *   - `db_pool_in_use` + `db_pool_waiters` → wired via `registerDbPoolGauges`,
 *     called from `AppModule`'s `ApiDbPoolGaugeRegistrar` on Nest init.
 *   - `db_migration_status` → addCallback deferred to migration-runner slice.
 *
 * Emission sites:
 *   - `db_rls_context_failure_total` → TenantContextGuard.withBootstrapCtx
 *     when runWithTenantContext fails at the GUC-setting layer (T476).
 *   - `db_slow_query_total` → DB query hook (deferred to pool integration).
 *
 * No API or worker signals — those are T470 (api) and T472 (worker).
 *
 * Constitution §VII / FR-B-002 / FR-B-006 / FR-B-012.
 */
import type { Pool } from "pg";

import {
  assertMetricLabels,
  getMeter,
  type Attributes,
  type Counter,
  type ObservableGauge,
} from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Module-load label-policy validation
// ---------------------------------------------------------------------------
// assertMetricLabels throws if a label is forbidden or not in the closed
// allowlist (ALLOWED_METRIC_LABELS in packages/shared). Called once at
// registration time; cannot be deferred to emit time.

assertMetricLabels("db_pool_in_use", []);
assertMetricLabels("db_pool_waiters", []);
assertMetricLabels("db_slow_query_total", ["query_class"]);
assertMetricLabels("db_rls_context_failure_total", []);
assertMetricLabels("db_migration_status", ["state"]);

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

const meter = getMeter("db");

// Observable gauges — registered; addCallback wiring deferred to T483.
// Pool introspection requires a pool-observer hook that depends on the
// SDK metrics extension (plan §10). The instruments are registered now
// so signal-presence tests and the ALLOWED_METRIC_LABELS allowlist hold.
const _dbPoolInUse: ObservableGauge = meter.createObservableGauge("db_pool_in_use", {
  description: "Number of connections currently checked out from the DB pool.",
});
const _dbPoolWaiters: ObservableGauge = meter.createObservableGauge("db_pool_waiters", {
  description: "Number of requests currently waiting for a DB pool connection.",
});
// Migration-status gauge: each migration state is observed as 1 (in that
// state) or 0. The addCallback is registered by the migration-runner
// bootstrap once integrated. Until then, zero observations are produced.
const _dbMigrationStatus: ObservableGauge = meter.createObservableGauge(
  "db_migration_status",
  {
    description:
      "Migration status indicator (1 = in state). Labels: state ∈ {pending, applied, failed}.",
  },
);

// _dbMigrationStatus: addCallback wiring deferred to migration-runner slice.
void _dbMigrationStatus;

// Counters — directly emittable at call sites.
const _dbSlowQuery: Counter = meter.createCounter("db_slow_query_total", {
  description:
    "Total DB queries exceeding the slow-query threshold " +
    "(default 500 ms), labelled by parameterized-statement class. " +
    "query_class is a hash of the SQL template — NEVER the rendered query text.",
});
const _dbRlsContextFailure: Counter = meter.createCounter(
  "db_rls_context_failure_total",
  {
    description:
      "Total DB RLS context bootstrap failures. No per-tenant labels — " +
      "alertable on any non-zero increment (FR-B-009). " +
      "tenant_id is forbidden as a metric label (FR-B-006).",
  },
);

// ---------------------------------------------------------------------------
// Attribute types — TypeScript compile-time label enforcement (FR-B-006)
// ---------------------------------------------------------------------------
// Each type admits ONLY the allowed label keys for its signal. A call site
// that adds `tenant_id` or any forbidden key won't compile.

export interface DbSlowQueryAttrs {
  query_class: string;
}

export interface DbMigrationStatusAttrs {
  state: "pending" | "applied" | "failed";
}

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

/**
 * Increment db_rls_context_failure_total (no labels — alertable counter).
 *
 * Called from the DB bootstrap path when `runWithTenantContext` fails at
 * the GUC-setting layer — i.e., before the work function is invoked.
 * Normal authorization failures (NotFoundException, UnauthorizedException)
 * are NOT DB/RLS context failures and MUST NOT trigger this counter.
 * Only non-HttpException errors from the bootstrap context indicate a real
 * DB-layer failure (connection refused, GUC cast error, pool exhaustion).
 *
 * Emission site: TenantContextGuard.withBootstrapCtx (T476).
 */
export function recordDbRlsContextFailure(): void {
  _dbRlsContextFailure.add(1);
}

/**
 * Increment db_slow_query_total for a parameterized-statement class.
 *
 * The `query_class` value MUST be a stable hash of the parameterized SQL
 * template (e.g., the first 8 hex digits of SHA-256 of the statement
 * with `$1`/`$2` placeholders). It MUST NOT be the rendered query text,
 * a parameter value, or any user-derived string (redaction matrix §3.3).
 *
 * Emission site: DB query hook (deferred to pool-integration slice).
 */
export function recordDbSlowQuery(attrs: DbSlowQueryAttrs): void {
  _dbSlowQuery.add(1, attrs as unknown as Attributes);
}

// ---------------------------------------------------------------------------
// db_pool_in_use + db_pool_waiters — ObservableGauge addCallback registrar
// ---------------------------------------------------------------------------

/**
 * Register addCallbacks for `db_pool_in_use` and `db_pool_waiters` against
 * the given pg.Pool.
 *
 * Behavior:
 *   - `deps.pool === null` → returns a no-op `{ stop }` handle. No callbacks
 *     are registered. Gauges stay unobserved for the scrape window.
 *   - Otherwise → registers one callback per gauge. Each callback reads
 *     synchronous in-memory counters from the pool object:
 *       db_pool_in_use   = pool.totalCount − pool.idleCount
 *       db_pool_waiters  = pool.waitingCount
 *     No DB round-trip, no async I/O, no re-entrancy risk.
 *
 * The returned `{ stop }` handle removes both callbacks. `AppModule`'s
 * `ApiDbPoolGaugeRegistrar.onModuleDestroy` calls it during graceful shutdown.
 */
export function registerDbPoolGauges(deps: {
  readonly pool: Pool | null;
}): { stop: () => void } {
  const pool = deps.pool;
  if (pool === null) {
    return { stop: () => undefined };
  }

  const inUseCallback = (result: {
    observe(value: number, attributes: Attributes): void;
  }): void => {
    result.observe(pool.totalCount - pool.idleCount, {} as Attributes);
  };

  const waitersCallback = (result: {
    observe(value: number, attributes: Attributes): void;
  }): void => {
    result.observe(pool.waitingCount, {} as Attributes);
  };

  _dbPoolInUse.addCallback(inUseCallback);
  _dbPoolWaiters.addCallback(waitersCallback);

  return {
    stop: () => {
      _dbPoolInUse.removeCallback(inUseCallback);
      _dbPoolWaiters.removeCallback(waitersCallback);
    },
  };
}

// ---------------------------------------------------------------------------
// Signal-name registry — used by T463 signal-presence tests
// ---------------------------------------------------------------------------

/**
 * Canonical names of all DB signals registered by this module.
 * Tests import this to verify every signal is in ALLOWED_METRIC_LABELS and
 * obeys the label policy. Drift between this array and the actual instrument
 * creation above fails CI.
 */
export const DB_METRIC_NAMES = [
  "db_pool_in_use",
  "db_pool_waiters",
  "db_slow_query_total",
  "db_rls_context_failure_total",
  "db_migration_status",
] as const satisfies readonly string[];

export type DbMetricName = (typeof DB_METRIC_NAMES)[number];
