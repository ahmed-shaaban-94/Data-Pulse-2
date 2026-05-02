import { z } from "zod";

export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

const SLUG_PATTERN = /^[a-z0-9](?:-?[a-z0-9])*$/;

export const Slug = z
  .string()
  .min(1)
  .max(63)
  .regex(SLUG_PATTERN, "must be lowercase alphanumeric with single hyphens");
export type Slug = z.infer<typeof Slug>;

export const Email = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .email()
  .transform((s) => s.toLowerCase());
export type Email = z.infer<typeof Email>;
