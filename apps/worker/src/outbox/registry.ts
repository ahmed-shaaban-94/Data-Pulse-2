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
   * Register a consumer. A second registration for the same event type
   * replaces the first (last-write-wins). In production, each event type
   * should have exactly one consumer; the drainer module enforces this
   * by construction.
   */
  register(consumer: OutboxConsumer<unknown>): void {
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
