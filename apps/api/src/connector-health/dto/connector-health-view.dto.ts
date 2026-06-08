/**
 * 020-US1 (T013) — the operator-facing connector health wire projection.
 *
 * `toConnectorHealthView` joins the 018 registration identity with the (possibly
 * absent) `connector_health` row and the read-derived liveness verdict. It OMITS
 * the health-row `id`, `tenant_id`, and ALL secret material (§IV — explicit wire
 * projection, never a raw DB entity). Mirrors the contract `ConnectorHealthView`
 * in `packages/contracts/openapi/erpnext-connector/connector-health.yaml`.
 */
import {
  deriveLiveness,
  DEFAULT_STALENESS_THRESHOLD_MS,
  type LivenessVerdict,
  secondsSinceLastSeen,
} from "../connector-health.liveness";

export interface ConnectorHealthViewBody {
  connectorId: string;
  displayName: string;
  environment: string;
  erpnextSiteRef: string;
  lastSeenAt: string | null;
  liveness: LivenessVerdict;
  secondsSinceLastSeen: number | null;
  connectorVersion: string | null;
  backlogIndicator: number | null;
  erpnextReachable: boolean | null;
  reportedFieldsAt: string | null;
}

/** The joined registration + health shape the read query produces (camelCase). */
export interface ConnectorHealthJoinRow {
  connectorId: string;
  displayName: string;
  environment: string;
  erpnextSiteRef: string;
  disabledAt: Date | null;
  // Health columns — null when no heartbeat row exists yet (left join).
  lastSeenAt: Date | null;
  connectorVersion: string | null;
  backlogIndicator: number | null;
  erpnextReachable: boolean | null;
  reportedFieldsAt: Date | null;
}

/**
 * Project a joined registration ⟕ health row to the wire shape, deriving the
 * liveness verdict against `now` (injected for determinism) and the staleness
 * threshold. The verdict is NEVER stored (data-model.md) — recomputed here.
 */
export function toConnectorHealthView(
  row: ConnectorHealthJoinRow,
  now: Date,
  thresholdMs: number = DEFAULT_STALENESS_THRESHOLD_MS,
): ConnectorHealthViewBody {
  return {
    connectorId: row.connectorId,
    displayName: row.displayName,
    environment: row.environment,
    erpnextSiteRef: row.erpnextSiteRef,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    liveness: deriveLiveness(row.lastSeenAt, now, thresholdMs, row.disabledAt),
    secondsSinceLastSeen: secondsSinceLastSeen(row.lastSeenAt, now),
    connectorVersion: row.connectorVersion,
    backlogIndicator: row.backlogIndicator,
    erpnextReachable: row.erpnextReachable,
    reportedFieldsAt: row.reportedFieldsAt
      ? row.reportedFieldsAt.toISOString()
      : null,
  };
}
