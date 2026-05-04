import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { RolesGuard } from "../auth/roles.guard";
import { MembershipsController } from "./memberships.controller";
import { MembershipsRepository } from "./memberships.repository";
import { MembershipsService } from "./memberships.service";
import { InvitationsController } from "./invitations.controller";
import { InvitationsRepository } from "./invitations.repository";
import { InvitationsService } from "./invitations.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [MembershipsController, InvitationsController],
  providers: [
    MembershipsRepository,
    MembershipsService,
    InvitationsRepository,
    InvitationsService,
    RolesGuard,
  ],
})
export class MembershipsModule {}
