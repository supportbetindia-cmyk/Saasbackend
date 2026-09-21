import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { TenantsController } from './tenants.controller';

@Module({
  controllers: [UsersController, TenantsController],
})
export class AccountModule {}
