import "reflect-metadata";

import { NoOpEmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";

describe("NoOpEmailJobEnqueuer", () => {
  const enqueuer = new NoOpEmailJobEnqueuer();

  it("enqueuePasswordReset resolves without error", async () => {
    await expect(
      enqueuer.enqueuePasswordReset({ email: "test@example.com", rawToken: "tok", userId: "uid" }),
    ).resolves.toBeUndefined();
  });

  it("enqueueEmailVerification resolves without error", async () => {
    await expect(
      enqueuer.enqueueEmailVerification({ email: "test@example.com", rawToken: "tok", userId: "uid" }),
    ).resolves.toBeUndefined();
  });

  it("enqueueInvitation resolves without error", async () => {
    await expect(
      enqueuer.enqueueInvitation({ email: "test@example.com", rawToken: "tok", tenantId: "tenant-1" }),
    ).resolves.toBeUndefined();
  });
});
