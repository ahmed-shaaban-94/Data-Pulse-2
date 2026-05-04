import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { RolesGuard } from "../auth/roles.guard";
import { MembershipsController } from "./memberships.controller";
import { MembershipsRepository } from "./memberships.repository";
import { MembershipsService } from "./memberships.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [MembershipsController],
  providers: [MembershipsRepository, MembershipsService, RolesGuard],
})
export class MembershipsModule {}
