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

describe("outbox event-types registry: audit.event.created + inventory.movement.created + sale.captured + erpnext.posting.requested + erpnext.reconciliation.requested", () => {
  // Originally T599 pinned a single type (audit.event.created). 009 issue #465
  // part B added a SECOND type, inventory.movement.created. DP-008-LIVELOOP
  // adds a THIRD, sale.captured (the worker-side consumer bridges it to the
  // existing sale-processing BullMQ queue). 015 adds a FOURTH,
  // erpnext.posting.requested (a processed sale / terminal event becomes a
  // pending erpnext_posting_status row). 017-RECON-WIRING adds a FIFTH,
  // erpnext.reconciliation.requested (an on-demand stock reconciliation run is
  // triggered → the worker-side consumer invokes ReconciliationRunProcessor).
  // 021 adds a SIXTH, erpnext.product_reconciliation.requested (an on-demand
  // product-master reconciliation run → the worker-side consumer invokes
  // ProductReconciliationRunProcessor) — this drift test is updated in lockstep
  // with each registration, which is exactly its purpose: a new outbox type
  // cannot land silently.
  const EXPECTED_EVENT_TYPES = [
    "audit.event.created",
    "inventory.movement.created",
    "sale.captured",
    "erpnext.posting.requested",
    "erpnext.reconciliation.requested",
    "erpnext.product_reconciliation.requested",
  ] as const;

  it("OUTBOX_EVENT_TYPES has exactly the expected entries", () => {
    expect(Object.values(OUTBOX_EVENT_TYPES).sort()).toEqual(
      [...EXPECTED_EVENT_TYPES].sort(),
    );
  });

  it("each key resolves to its canonical string literal", () => {
    expect(OUTBOX_EVENT_TYPES.AUDIT_EVENT_CREATED).toBe("audit.event.created");
    expect(OUTBOX_EVENT_TYPES.INVENTORY_MOVEMENT_CREATED).toBe(
      "inventory.movement.created",
    );
    expect(OUTBOX_EVENT_TYPES.SALE_CAPTURED).toBe("sale.captured");
    expect(OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED).toBe(
      "erpnext.posting.requested",
    );
    expect(OUTBOX_EVENT_TYPES.ERPNEXT_RECONCILIATION_REQUESTED).toBe(
      "erpnext.reconciliation.requested",
    );
    expect(OUTBOX_EVENT_TYPES.ERPNEXT_PRODUCT_RECONCILIATION_REQUESTED).toBe(
      "erpnext.product_reconciliation.requested",
    );
  });

  it("the const is shape-frozen — keys are exactly the expected set", () => {
    expect(Object.keys(OUTBOX_EVENT_TYPES).sort()).toEqual(
      [
        "AUDIT_EVENT_CREATED",
        "INVENTORY_MOVEMENT_CREATED",
        "SALE_CAPTURED",
        "ERPNEXT_POSTING_REQUESTED",
        "ERPNEXT_RECONCILIATION_REQUESTED",
        "ERPNEXT_PRODUCT_RECONCILIATION_REQUESTED",
      ].sort(),
    );
  });

  it("OutboxEventType union is satisfied by the canonical literals at compile time", () => {
    const cases: ReadonlyArray<OutboxEventType> = [
      "audit.event.created",
      "inventory.movement.created",
      "sale.captured",
      "erpnext.posting.requested",
      "erpnext.reconciliation.requested",
      "erpnext.product_reconciliation.requested",
    ];
    expect(cases).toHaveLength(EXPECTED_EVENT_TYPES.length);
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
