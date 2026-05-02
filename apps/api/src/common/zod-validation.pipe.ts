import {
  ArgumentMetadata,
  Injectable,
  PipeTransform,
} from "@nestjs/common";
import type { ZodTypeAny, infer as ZodInfer } from "zod";

/**
 * Validates incoming request payloads against a Zod schema.
 *
 *   - Per-route: `@Body(new ZodValidationPipe(SignInSchema)) body: SignIn`
 *   - Global no-op: `app.useGlobalPipes(new ZodValidationPipe())` — when no
 *     schema is attached, the pipe simply returns the value unchanged.
 *
 * On validation failure, the pipe throws the raw `ZodError`. The
 * `GlobalExceptionFilter` formats the issues array into the uniform
 * `{ error: { code: 'validation_error', details: [...], ... } }`
 * envelope.
 */
@Injectable()
export class ZodValidationPipe<TSchema extends ZodTypeAny | undefined = undefined>
  implements PipeTransform
{
  constructor(private readonly schema?: TSchema) {}

  transform(
    value: unknown,
    _metadata: ArgumentMetadata,
  ): TSchema extends ZodTypeAny ? ZodInfer<TSchema> : unknown {
    if (!this.schema) {
      return value as never;
    }
    // `parse` throws ZodError on failure — caught by GlobalExceptionFilter.
    return this.schema.parse(value) as never;
  }
}
