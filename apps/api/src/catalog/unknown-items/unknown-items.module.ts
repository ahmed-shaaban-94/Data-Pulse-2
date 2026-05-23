/**
 * UnknownItemsModule — 005 Wave 1 skeleton.
 *
 * T500: empty Nest module created during 005-WAVE1-SETUP. No providers,
 * controllers, or imports yet. Subsequent Wave 1 slices populate this
 * module:
 *   - T511 / 005-WAVE1-CAPTURE-HAPPY: `UnknownItemsService`
 *   - T512 / 005-WAVE1-CAPTURE-HAPPY: `UnknownItemsController` (POST capture)
 *   - T520 / 005-WAVE1-VALIDATION:   `CaptureRequestDto` (Zod boundary)
 *   - T524 / 005-WAVE1-LIST:         GET list endpoint
 *   - T533 / 005-WAVE1-IDEMP-MISMATCH: `IdempotencyMismatchFilter`
 *   - T541 / 005-WAVE1-DISMISS:      POST dismiss endpoint
 *
 * This module is intentionally not wired into `AppModule` yet — that
 * happens in 005-WAVE1-CAPTURE-HAPPY (T512) once the controller exists,
 * to avoid registering an empty module with the DI container.
 *
 * Spec: specs/005-pos-catalog-sync-reconciliation/spec.md
 * Tasks: specs/005-pos-catalog-sync-reconciliation/tasks.md §4 (T500)
 */
import { Module } from "@nestjs/common";

@Module({})
export class UnknownItemsModule {}
