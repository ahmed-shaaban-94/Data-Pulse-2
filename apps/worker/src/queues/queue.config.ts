/**
 * Re-export from `@data-pulse-2/shared/queues/queue-config`.
 *
 * The defaults moved up to the shared package (T301-partial) so the
 * api-side producer and the worker-side `BullMqWorkerFactory` consume
 * one source of truth. This file keeps existing intra-app import paths
 * stable and exists purely as a forwarding shim — there is no policy
 * here. New consumers should import from `@data-pulse-2/shared`.
 */
export {
  DEFAULT_JOB_OPTIONS,
  DEFAULT_WORKER_OPTIONS,
  deepFreeze,
  type DefaultJobOptionsShape,
  type DefaultWorkerOptionsShape,
} from "@data-pulse-2/shared/queues/queue-config";
