import { Module } from "@nestjs/common";

/**
 * Auth module — slice 3a foundation.
 *
 * The repositories and AuthService are exported here so future slices can
 * import them, but the module is empty of providers/controllers right now
 * because slice 3a doesn't expose any HTTP routes:
 *
 *   - AuthGuard / AuthController land in slices 3b and 3c.
 *   - Providers are wired only when something injects them; for slice 3a
 *     the classes are instantiated directly in their integration tests.
 *
 * Keeping this module empty is deliberate: AppModule still has zero
 * controllers (per the FR-API-1 "skeleton has no domain endpoints yet"
 * stance carried over from PR #10), and Phase 3 will turn that on slice
 * by slice.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class AuthModule {}
