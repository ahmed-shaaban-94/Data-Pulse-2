/**
 * memberships.dto.spec.ts — MembershipUpdateSchema unit coverage.
 *
 * Pure Zod schema tests: no NestJS bootstrap, no DB, no network.
 * Exercises every branch in the .strict() + .superRefine() chain.
 */

import { MembershipUpdateSchema } from "../../src/memberships/dto";

const VALID_UUID = "0b000000-0000-7000-8000-000000000001";
const VALID_UUID_2 = "0b000000-0000-7000-8000-000000000002";

function issueMessages(result: ReturnType<typeof MembershipUpdateSchema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((i) => i.message);
}

function issuePaths(result: ReturnType<typeof MembershipUpdateSchema.safeParse>): string[][] {
  if (result.success) return [];
  return result.error.issues.map((i) => i.path.map(String));
}

describe("MembershipUpdateSchema", () => {
  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  describe("accepts valid payloads", () => {
    it("role_code only", () => {
      const r = MembershipUpdateSchema.safeParse({ role_code: "tenant_admin" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.role_code).toBe("tenant_admin");
    });

    it("store_access_kind='all' with no store_ids", () => {
      const r = MembershipUpdateSchema.safeParse({ store_access_kind: "all" });
      expect(r.success).toBe(true);
    });

    it("store_access_kind='all' with explicitly empty store_ids", () => {
      const r = MembershipUpdateSchema.safeParse({ store_access_kind: "all", store_ids: [] });
      expect(r.success).toBe(true);
    });

    it("store_access_kind='specific' with one valid UUID", () => {
      const r = MembershipUpdateSchema.safeParse({
        store_access_kind: "specific",
        store_ids: [VALID_UUID],
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.store_ids).toEqual([VALID_UUID]);
    });

    it("store_access_kind='specific' with multiple valid UUIDs", () => {
      const r = MembershipUpdateSchema.safeParse({
        store_access_kind: "specific",
        store_ids: [VALID_UUID, VALID_UUID_2],
      });
      expect(r.success).toBe(true);
    });

    it("all three fields together (specific)", () => {
      const r = MembershipUpdateSchema.safeParse({
        role_code: "member",
        store_access_kind: "specific",
        store_ids: [VALID_UUID],
      });
      expect(r.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection: at-least-one guard
  // ---------------------------------------------------------------------------

  describe("rejects empty object", () => {
    it("produces the at-least-one custom issue", () => {
      const r = MembershipUpdateSchema.safeParse({});
      expect(r.success).toBe(false);
      expect(issueMessages(r)).toContain(
        "At least one of role_code, store_access_kind, or store_ids must be provided",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection: store_access_kind='all' conflicts
  // ---------------------------------------------------------------------------

  describe("store_access_kind='all' with non-empty store_ids", () => {
    it("rejects and names the store_ids path", () => {
      const r = MembershipUpdateSchema.safeParse({
        store_access_kind: "all",
        store_ids: [VALID_UUID],
      });
      expect(r.success).toBe(false);
      expect(issueMessages(r)).toContain(
        "store_ids must be omitted or empty when store_access_kind is 'all'",
      );
      expect(issuePaths(r).some((p) => p.includes("store_ids"))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection: store_access_kind='specific' without store_ids
  // ---------------------------------------------------------------------------

  describe("store_access_kind='specific' without store_ids", () => {
    it("rejects when store_ids is omitted", () => {
      const r = MembershipUpdateSchema.safeParse({ store_access_kind: "specific" });
      expect(r.success).toBe(false);
      expect(issueMessages(r)).toContain(
        "store_ids must be non-empty when store_access_kind is 'specific'",
      );
      expect(issuePaths(r).some((p) => p.includes("store_ids"))).toBe(true);
    });

    it("rejects when store_ids is an empty array", () => {
      const r = MembershipUpdateSchema.safeParse({
        store_access_kind: "specific",
        store_ids: [],
      });
      expect(r.success).toBe(false);
      expect(issueMessages(r)).toContain(
        "store_ids must be non-empty when store_access_kind is 'specific'",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection: invalid UUID in store_ids
  // ---------------------------------------------------------------------------

  describe("invalid UUID in store_ids", () => {
    it("rejects non-UUID string with per-element message", () => {
      const r = MembershipUpdateSchema.safeParse({
        store_access_kind: "specific",
        store_ids: ["not-a-uuid"],
      });
      expect(r.success).toBe(false);
      expect(issueMessages(r)).toContain("each store_id must be a UUID");
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection: .strict() — unknown keys
  // ---------------------------------------------------------------------------

  describe(".strict() enforcement", () => {
    it("rejects unknown keys", () => {
      const r = MembershipUpdateSchema.safeParse({
        role_code: "member",
        unexpected_key: "boom",
      } as object);
      expect(r.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection: role_code field-level validation
  // ---------------------------------------------------------------------------

  describe("role_code field validation", () => {
    it("rejects empty string role_code", () => {
      const r = MembershipUpdateSchema.safeParse({ role_code: "" });
      expect(r.success).toBe(false);
    });
  });
});
