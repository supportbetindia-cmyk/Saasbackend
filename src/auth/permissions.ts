import type { MembershipRole } from '@prisma/client';

// Permission keys (grouped, mirrors the TRD RBAC model). Extend as modules land.
export const PERMISSIONS = {
  customersRead: 'customers.read',
  customersWrite: 'customers.write',
  customersExport: 'customers.export',
  transactionsRead: 'transactions.read',
  transactionsWrite: 'transactions.write',
  financialDashboardRead: 'financial.dashboard.read',
  allocationsRead: 'allocations.read',
  allocationsManage: 'allocations.manage',
  allocationsActivate: 'allocations.activate',
  budgetsRead: 'budgets.read',
  budgetsManage: 'budgets.manage',
  targetsRead: 'targets.read',
  targetsManage: 'targets.manage',
  whatsappRead: 'whatsapp.read',
  whatsappManage: 'whatsapp.manage',
  reportsRead: 'reports.read',
  reportsExport: 'reports.export',
  importsCreate: 'imports.create',
  importsCommit: 'imports.commit',
  rulesManage: 'rules.manage',
  integrationsManage: 'integrations.manage',
  usersManage: 'users.manage',
  permissionsManage: 'permissions.manage',
  auditRead: 'audit.read',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL: PermissionKey[] = Object.values(PERMISSIONS);

// Default role → permission map (per-tenant DB overrides can extend later).
export const ROLE_DEFAULTS: Record<MembershipRole, PermissionKey[]> = {
  OWNER: ALL,
  ADMIN: ALL.filter((p) => p !== PERMISSIONS.permissionsManage),
  MANAGER: [
    PERMISSIONS.customersRead, PERMISSIONS.customersWrite, PERMISSIONS.customersExport,
    PERMISSIONS.transactionsRead, PERMISSIONS.transactionsWrite,
    PERMISSIONS.whatsappRead, PERMISSIONS.reportsRead, PERMISSIONS.reportsExport,
    PERMISSIONS.budgetsRead, PERMISSIONS.targetsRead, PERMISSIONS.allocationsRead,
    PERMISSIONS.importsCreate,
  ],
  VIEWER: [
    PERMISSIONS.customersRead, PERMISSIONS.transactionsRead, PERMISSIONS.reportsRead,
    PERMISSIONS.budgetsRead, PERMISSIONS.targetsRead, PERMISSIONS.allocationsRead,
    PERMISSIONS.whatsappRead,
  ],
};

export function roleHasPermission(role: MembershipRole, key: PermissionKey): boolean {
  return ROLE_DEFAULTS[role]?.includes(key) ?? false;
}
