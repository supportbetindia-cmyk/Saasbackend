import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { HealthModule } from './health/health.module';
import { AccountModule } from './account/account.module';
import { CustomersModule } from './customers/customers.module';
import { TransactionsModule } from './transactions/transactions.module';
import { ImportsModule } from './imports/imports.module';
import { ClassificationModule } from './classification/classification.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { TargetsModule } from './targets/targets.module';
import { AllocationsModule } from './allocations/allocations.module';
import { ReportsModule } from './reports/reports.module';
import { DepartmentsModule } from './departments/departments.module';
import { BudgetsModule } from './budgets/budgets.module';
import { WinbackModule } from './winback/winback.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { InboxModule } from './inbox/inbox.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    AuditModule,
    HealthModule,
    AccountModule,
    CustomersModule,
    TransactionsModule,
    ImportsModule,
    ClassificationModule,
    DashboardModule,
    WebhooksModule,
    TargetsModule,
    AllocationsModule,
    ReportsModule,
    DepartmentsModule,
    BudgetsModule,
    WinbackModule,
    LifecycleModule,
    InboxModule,
  ],
})
export class AppModule {}
