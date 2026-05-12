import { pgTable, uuid, text, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { stores } from "./stores";
import { users } from "./users";
import { devices } from "./devices";

export const shifts = pgTable(
  "shifts",
  {
    shiftId: uuid("shift_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    openingCashierUserId: uuid("opening_cashier_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    openingDeviceId: uuid("opening_device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "restrict" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    lifecycleState: text("lifecycle_state").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("shifts_lifecycle_state_check", sql`${t.lifecycleState} IN ('open', 'closed', 'closed_forced')`),
  ],
);
