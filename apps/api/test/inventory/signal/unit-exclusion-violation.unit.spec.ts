/**
 * unit-exclusion-violation.unit.spec.ts — 009 follow-up (issue #465, part A).
 *
 * Docker-FREE unit test for `isUnitExclusionViolation` — the predicate that
 * recognises the established-unit EXCLUDE violation (migration 0015) so the
 * service can translate the rare concurrent-race 23P01 into a 400 CrossUnitError
 * instead of a 500. This is tested DIRECTLY (not through the integration
 * harness) because the violation is sequentially unreachable: the pre-INSERT
 * `assertUnitMatchesEstablished` throws CrossUnitError first on any path where an
 * established unit exists, so the DB constraint only fires under TRUE
 * concurrency (two txns both pass the pre-check, both insert) — which a
 * single-threaded harness can't deterministically reproduce. A synthetic
 * pg-error object exercises the only new branch.
 */
import {
  isUnitExclusionViolation,
  UNIT_GUARD_CONSTRAINT,
} from '../../../src/inventory/inventory.service';

describe('isUnitExclusionViolation (issue #465 / migration 0015)', () => {
  it('is true for a 23P01 on the established-unit constraint', () => {
    expect(
      isUnitExclusionViolation({ code: '23P01', constraint: UNIT_GUARD_CONSTRAINT }),
    ).toBe(true);
  });

  it('is false for 23P01 on a DIFFERENT constraint (e.g. the provenance dedup index)', () => {
    expect(
      isUnitExclusionViolation({
        code: '23P01',
        constraint: 'uq_stock_movements_tenant_source_external',
      }),
    ).toBe(false);
  });

  it('is false for a different SQLSTATE on the same constraint name', () => {
    expect(
      isUnitExclusionViolation({ code: '23505', constraint: UNIT_GUARD_CONSTRAINT }),
    ).toBe(false);
  });

  it('is false for non-error / shapeless values', () => {
    expect(isUnitExclusionViolation(null)).toBe(false);
    expect(isUnitExclusionViolation(undefined)).toBe(false);
    expect(isUnitExclusionViolation('23P01')).toBe(false);
    expect(isUnitExclusionViolation(new Error('boom'))).toBe(false);
    expect(isUnitExclusionViolation({ code: '23P01' })).toBe(false); // no constraint
  });

  it('pins the constraint name to the migration-0015 identifier', () => {
    expect(UNIT_GUARD_CONSTRAINT).toBe('stock_movements_one_unit_per_product');
  });
});
