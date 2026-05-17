/**
 * T582 — Outbox consumer registry.
 *
 * Maps `event_type` string → `OutboxConsumer` instance. The drainer
 * resolves the concrete consumer from this registry before dispatching
 * each claimed event.
 *
 * Only one consumer per event type is supported in Slice 1B. Multi-consumer
 * fan-out (e.g., same event type consumed by both audit and analytics) is
 * deferred to a later slice.
 *
 * The registry is a plain class (no NestJS DI) so the drainer can
 * construct it with explicit dependencies in tests without booting the
 * Nest module graph.
 */
import type { OutboxConsumer } from "@data-pulse-2/shared";

export class OutboxConsumerRegistry {
  private readonly consumers = new Map<string, OutboxConsumer<unknown>>();

  /**
   * Register a consumer. Throws if a consumer is already registered for the
   * same `eventType` — silent last-write-wins replacement masks wiring bugs
   * (two modules each trying to own the same event type, a test forgetting
   * to start from a fresh registry, etc.). The drainer module wires every
   * consumer exactly once at boot; a second registration is always a bug.
   */
  register(consumer: OutboxConsumer<unknown>): void {
    const existing = this.consumers.get(consumer.eventType);
    if (existing) {
      throw new Error(
        `OutboxConsumerRegistry: duplicate registration for event_type="${consumer.eventType}" ` +
          `(existing consumerId="${existing.consumerId}", new consumerId="${consumer.consumerId}"). ` +
          `Each event type may have at most one consumer in Slice 1B.`,
      );
    }
    this.consumers.set(consumer.eventType, consumer);
  }

  /**
   * Resolve the consumer for a given event type. Returns `undefined` if
   * no consumer is registered for the type.
   *
   * The drainer logs an unroutable event and marks it `failed` (not
   * `dead_lettered` directly) when `resolve` returns undefined, so the
   * event can be triage-inspected and re-driven manually later.
   */
  resolve(eventType: string): OutboxConsumer<unknown> | undefined {
    return this.consumers.get(eventType);
  }
}
