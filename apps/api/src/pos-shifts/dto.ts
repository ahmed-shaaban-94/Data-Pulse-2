import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const StuckShiftsQuerySchema = z.object({
  branch_id: z
    .string({ required_error: "branch_id is required" })
    .regex(UUID_RE, "branch_id must be a valid UUID"),
});

export type StuckShiftsQuery = z.infer<typeof StuckShiftsQuerySchema>;

export interface StuckShiftItem {
  shift_id: string;
  cashier_display_name: string;
  terminal_label: string;
  opened_at: string;
  duration_minutes: number;
}

export interface StuckShiftsResponseBody {
  kind: "ok";
  shifts: StuckShiftItem[];
}
