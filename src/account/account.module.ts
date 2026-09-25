import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { TenantsController } from './tenants.controller';
import { TeamController } from './team.controller';

@Module({
  controllers: [UsersController, TenantsController, TeamController],
})
export class AccountModule {}
