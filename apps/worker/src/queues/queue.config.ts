/**
 * Worker-side queue configuration — T301.
 *
 * Two responsibilities:
 *
 * 1. Forwarding shim
 *    Re-exports the shared BullMQ defaults from `@data-pulse-2/shared` so
 *    existing intra-app import paths stay stable. New consumers should import
 *    from `@data-pulse-2/shared` directly.
 *
 * 2. Per-queue DLQ metric registry (`DLQ_METRIC_REGISTRY`)
 *    A frozen, enumerable list that maps every active worker queue to the
 *    metric key the observability layer (T303 / OTel) will emit when jobs
 *    exhaust all retry attempts and land in the BullMQ failed-jobs set.
 *
 *    Why here and not in shared?
 *    ----------------------------
 *    Queue names are a worker-side implementation detail. `packages/shared`
 *    publishes the *policy* (retry count, backoff shape, retention windows);
 *    `apps/worker` owns the *topology* (which queues exist and what their
 *    metric identifiers are called). Mixing topology into shared would force
 *    every non-worker consumer of shared to carry knowledge of queues it
 *    never uses.
 *
 *    Why a static registry instead of per-worker-class metadata?
 *    -----------------------------------------------------------
 *    A single registry that an integration test (or a future T303 observer)
 *    can iterate is safer than scattered per-class constants that are easy
 *    to forget when a new queue is added. The spec enforces that every known
 *    queue appears here; a missing entry fails CI.
 *
 *    Shape — `DlqMetricDescriptor`
 *    --------------------------------
 *    - `queueName`  — canonical BullMQ queue identifier; MUST match the
 *                     constant in the corresponding `*Worker` file and the
 *                     API-side producer.
 *    - `metricKey`  — dotted-lowercase identifier for the metric counter
 *                     (`"queue.<name>.dlq"` convention).
 *
 *    session-revoke is explicitly out of scope (T302) and MUST NOT appear
 *    here until the queue is implemented end-to-end.
 */

export {
  DEFAULT_JOB_OPTIONS,
  DEFAULT_WORKER_OPTIONS,
  deepFreeze,
  type DefaultJobOptionsShape,
  type DefaultWorkerOptionsShape,
} from "@data-pulse-2/shared/queues/queue-config";

import { EMAIL_QUEUE_NAME } from "../email/email.worker";
import { AUDIT_QUEUE_NAME } from "../audit/audit.worker";
import { deepFreeze } from "@data-pulse-2/shared/queues/queue-config";

/** One entry per active worker queue. */
export interface DlqMetricDescriptor {
  readonly queueName: string;
  readonly metricKey: string;
}

/**
 * Frozen registry of all active worker queues and their DLQ metric keys.
 *
 * Add an entry here (and tests) when wiring a new queue.
 * Remove it when decommissioning a queue.
 *
 * Invariant: every queue consumed by a `*Worker` class in this app has
 * exactly one entry. The spec enforces this.
 */
export const DLQ_METRIC_REGISTRY: readonly DlqMetricDescriptor[] = deepFreeze([
  {
    queueName: EMAIL_QUEUE_NAME,
    metricKey: `queue.${EMAIL_QUEUE_NAME}.dlq`,
  },
  {
    queueName: AUDIT_QUEUE_NAME,
    metricKey: `queue.${AUDIT_QUEUE_NAME}.dlq`,
  },
]);
