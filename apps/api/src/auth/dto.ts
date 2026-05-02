/**
 * Auth DTOs (Zod schemas).
 *
 * The sign-in schema lives here so the controller (slice 3c) can attach it
 * to its `@Body(new ZodValidationPipe(SignInSchema))` route. AuthService
 * accepts already-parsed `SignInInput` so unit tests can construct it
 * directly without going through HTTP.
 */
import { Email } from "@data-pulse-2/shared";
import { z } from "zod";

export const SignInSchema = z.object({
  email: Email,
  password: z.string().min(1).max(1024),
});

export type SignInInput = z.infer<typeof SignInSchema>;

/**
 * What a successful sign-in returns to the controller. The raw session id
 * is what becomes the cookie value (slice 3c handles serialization +
 * cookie attributes).
 */
export interface SignInResult {
  sessionId: string;
  userId: string;
  absoluteExpiresAt: Date;
}
