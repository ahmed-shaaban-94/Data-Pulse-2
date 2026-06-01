/**
 * T599 — Outbox event-types registry invariant.
 *
 * Pins the P7 exit-gate invariant from `tasks.md` line 390:
 *
 *   "Validate: no catalog-specific event types added; only
 *    `audit.event.created`."
 *
 * The invariant is structurally enforced by the TypeScript literal-type
 * shape of `OUTBOX_EVENT_TYPES` in `packages/db/src/outbox/producer.ts` —
 * `OutboxEventType` is `typeof OUTBOX_EVENT_TYPES[keyof typeof OUTBOX_EVENT_TYPES]`,
 * so the only strings the producer's `eventType: OutboxEventType` parameter
 * will accept are the values in this const object. Adding a new event type
 * requires a code change that this spec will fail loudly on.
 *
 * Why a runtime test on top of compile-time enforcement:
 *   - The exit-gate (T597–T600) is a green-CI artifact, not just a static
 *     analysis pass. A failing spec is easier for a reviewer to spot than
 *     a missing tsc error in a PR diff.
 *   - The repo's house style for similar invariants — see the
 *     `worker-signals.spec.ts` cardinality + label-policy pins — is to
 *     re-state the type-level invariant as a runtime assertion.
 *   - If the const object is ever mutated at runtime (it shouldn't be —
 *     it's declared `as const`), this spec catches it.
 *
 * No Docker, no Postgres, no Nest — pure unit test against the
 * compile-time-frozen const.
 */
import {
  OUTBOX_EVENT_TYPES,
  type OutboxEventType,
} from "../../src/outbox/producer";

describe("T599 — outbox event-types registry: only audit.event.created", () => {
  it("OUTBOX_EVENT_TYPES has exactly one entry", () => {
    const values = Object.values(OUTBOX_EVENT_TYPES);
    expect(values).toHaveLength(1);
  });

  it("the single registered event type is 'audit.event.created'", () => {
    expect(Object.values(OUTBOX_EVENT_TYPES)).toEqual(["audit.event.created"]);
  });

  it("AUDIT_EVENT_CREATED key resolves to the canonical string literal", () => {
    expect(OUTBOX_EVENT_TYPES.AUDIT_EVENT_CREATED).toBe("audit.event.created");
  });

  it("the const is shape-frozen — keys are exactly { AUDIT_EVENT_CREATED }", () => {
    expect(Object.keys(OUTBOX_EVENT_TYPES).sort()).toEqual(["AUDIT_EVENT_CREATED"]);
  });

  it("OutboxEventType union is satisfied by the canonical literal at compile time", () => {
    // Compile-time type-narrowing assertion — if a future PR widens
    // OUTBOX_EVENT_TYPES, this line still compiles, but cases above fail
    // loudly. The pair (type assertion + value assertion) makes both axes
    // of T599 explicit.
    const cases: ReadonlyArray<OutboxEventType> = ["audit.event.created"];
    expect(cases).toHaveLength(1);
  });

  it("no catalog-related event-type strings have been added", () => {
    // Defensive: explicitly check that none of the strings a future catalog
    // slice MIGHT have introduced are present. T599's task text calls these
    // out by category — keep the explicit list small and add to it only
    // when a new catalog-adjacent event type is *intentionally* deferred.
    const forbidden = [
      "catalog.product.created",
      "catalog.product.updated",
      "catalog.product.deleted",
      "catalog.price.updated",
      "catalog.alias.created",
    ];
    const registered = Object.values(OUTBOX_EVENT_TYPES) as readonly string[];
    for (const name of forbidden) {
      expect(registered).not.toContain(name);
    }
  });
});
