/**
 * invitation.dto.spec.ts — InvitationCreateSchema unit coverage.
 *
 * Pure Zod schema tests: no NestJS bootstrap, no DB, no network.
 * Exercises the .strict() + .superRefine() cross-field rules plus
 * the email transform chain (trim + toLowerCase).
 */

import { InvitationCreateSchema } from "../../src/memberships/invitation.dto";

const VALID_UUID = "0b000000-0000-7000-8000-000000000001";
const VALID_UUID_2 = "0b000000-0000-7000-8000-000000000002";

function issueMessages(result: ReturnType<typeof InvitationCreateSchema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((i) => i.message);
}

function issuePaths(result: ReturnType<typeof InvitationCreateSchema.safeParse>): string[][] {
  if (result.success) return [];
  return result.error.issues.map((i) => i.path.map(String));
}

const BASE_VALID = {
  email: "User@Example.COM",
  role_code: "member",
  store_access_kind: "all" as const,
};

describe("InvitationCreateSchema", () => {
  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  describe("accepts valid payloads", () => {
    it("all-stores invite", () => {
      const r = InvitationCreateSchema.safeParse(BASE_VALID);
      expect(r.success).toBe(true);
    });

    it("normalizes email — trims whitespace and lowercases", () => {
      const r = InvitationCreateSchema.safeParse({
        ...BASE_VALID,
        email: "  ADMIN@EXAMPLE.COM  ",
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBe("admin@example.com");
    });

    it("specific-store invite with one valid UUID", () => {
      const r = InvitationCreateSchema.safeParse({
        ...BASE_VALID,
        store_access_kind: "specific",
        store_ids: [VALID_UUID],
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.store_ids).toEqual([VALID_UUID]);
    });

    it("specific-store invite with multiple valid UUIDs", () => {
      const r = InvitationCreateSchema.safeParse({
        ...BASE_VALID,
        store_access_kind: "specific",
        store_ids: [VALID_UUID, VALID_UUID_2],
      });
      expect(r.success).toBe(true);
    });

    it("store_access_kind='all' with explicitly empty store_ids", () => {
      const r = InvitationCreateSchema.safeParse({
        ...BASE_VALID,
        store_ids: [],
      });
      expect(r.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection: email field
  // ---------------------------------------------------------------------------

  describe("email field validation", () => {
    it("rejects invalid email format", () => {
      const r = InvitationCreateSchema.safeParse({ ...BASE_VALID, email: "not-an-email" });
      expect(r.success).toBe(false);
    });

    it("rejects empty string email", () => {
      const r = InvitationCreateSchema.safeParse({ ...BASE_VALID, email: "" });
      expect(r.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection: role_code field
  // ---------------------------------------------------------------------------

  describe("role_code field validation", () => {
    it("rejects empty string role_code", () => {
      const r = InvitationCreateSchema.safeParse({ ...BASE_VALID, role_code: "" });
      expect(r.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection: store_access_kind='specific' without store_ids
  // ---------------------------------------------------------------------------

  describe("store_access_kind='specific' without store_ids", () => {
    it("rejects when store_ids is omitted", () => {
      const r = InvitationCreateSchema.safeParse({
        ...BASE_VALID,
        store_access_kind: "specific",
      });
      expect(r.success).toBe(false);
      expect(issueMessages(r)).toContain(
        "store_ids must be non-empty when store_access_kind is 'specific'",
      );
      expect(issuePaths(r).some((p) => p.includes("store_ids"))).toBe(true);
    });

    it("rejects when store_ids is an empty array", () => {
      const r = InvitationCreateSchema.safeParse({
        ...BASE_VALID,
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
  // Rejection: store_access_kind='all' with non-empty store_ids
  // ---------------------------------------------------------------------------

  describe("store_access_kind='all' with non-empty store_ids", () => {
    it("rejects and names the store_ids path", () => {
      const r = InvitationCreateSchema.safeParse({
        ...BASE_VALID,
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
  // Rejection: invalid UUID in store_ids
  // ---------------------------------------------------------------------------

  describe("invalid UUID in store_ids", () => {
    it("rejects non-UUID string with per-element message", () => {
      const r = InvitationCreateSchema.safeParse({
        ...BASE_VALID,
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
    it("rejects unknown top-level keys", () => {
      const r = InvitationCreateSchema.safeParse({
        ...BASE_VALID,
        unexpected_key: "boom",
      } as object);
      expect(r.success).toBe(false);
    });
  });
});
