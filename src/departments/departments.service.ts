import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type DepartmentRow = {
  id: string; tenantId: string; name: string; sortOrder: number;
  archivedAt: Date | null; createdAt: Date; updatedAt: Date;
};

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string) {
    return this.prisma.$queryRawUnsafe<DepartmentRow[]>(
      `select id, tenant_id as "tenantId", name, sort_order as "sortOrder", archived_at as "archivedAt", created_at as "createdAt", updated_at as "updatedAt"
       from saas.departments where tenant_id = $1 order by archived_at nulls first, sort_order, name`, tenantId,
    );
  }

  async create(tenantId: string, name: string) {
    const clean = name.trim();
    const duplicate = await this.prisma.$queryRawUnsafe<{ id: string }[]>(`select id from saas.departments where tenant_id = $1 and name = $2 limit 1`, tenantId, clean);
    if (duplicate.length) throw new ConflictException('A department with this name already exists');
    const rows = await this.prisma.$queryRawUnsafe<DepartmentRow[]>(
      `insert into saas.departments (id, tenant_id, name, sort_order, created_at, updated_at)
       values (gen_random_uuid()::text, $1, $2, (select coalesce(max(sort_order), -1) + 1 from saas.departments where tenant_id = $1), now(), now())
       returning id, tenant_id as "tenantId", name, sort_order as "sortOrder", archived_at as "archivedAt", created_at as "createdAt", updated_at as "updatedAt"`, tenantId, clean,
    );
    return rows[0];
  }

  async rename(tenantId: string, id: string, name: string) {
    const current = await this.find(tenantId, id);
    const clean = name.trim();
    const duplicate = await this.prisma.$queryRawUnsafe<{ id: string }[]>(`select id from saas.departments where tenant_id = $1 and name = $2 and id <> $3 limit 1`, tenantId, clean, id);
    if (duplicate.length) throw new ConflictException('A department with this name already exists');
    const rows = await this.prisma.$queryRawUnsafe<DepartmentRow[]>(
      `update saas.departments set name = $3, updated_at = now() where tenant_id = $1 and id = $2
       returning id, tenant_id as "tenantId", name, sort_order as "sortOrder", archived_at as "archivedAt", created_at as "createdAt", updated_at as "updatedAt"`, tenantId, id, clean,
    );
    return { old: current, value: rows[0] };
  }

  async setArchived(tenantId: string, id: string, archived: boolean) {
    const current = await this.find(tenantId, id);
    const rows = await this.prisma.$queryRawUnsafe<DepartmentRow[]>(
      `update saas.departments set archived_at = case when $3::boolean then now() else null end, updated_at = now()
       where tenant_id = $1 and id = $2
       returning id, tenant_id as "tenantId", name, sort_order as "sortOrder", archived_at as "archivedAt", created_at as "createdAt", updated_at as "updatedAt"`, tenantId, id, archived,
    );
    return { old: current, value: rows[0] };
  }

  async reorder(tenantId: string, ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Department IDs must be unique');
    const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(`select id from saas.departments where tenant_id = $1 and archived_at is null`, tenantId);
    if (rows.length !== ids.length || rows.some((row) => !ids.includes(row.id))) throw new BadRequestException('Include every active department exactly once');
    await this.prisma.$transaction(ids.map((id, sortOrder) => this.prisma.$executeRawUnsafe(
      `update saas.departments set sort_order = $3, updated_at = now() where tenant_id = $1 and id = $2`, tenantId, id, sortOrder,
    )));
    return this.list(tenantId);
  }

  private async find(tenantId: string, id: string) {
    const rows = await this.prisma.$queryRawUnsafe<DepartmentRow[]>(
      `select id, tenant_id as "tenantId", name, sort_order as "sortOrder", archived_at as "archivedAt", created_at as "createdAt", updated_at as "updatedAt"
       from saas.departments where tenant_id = $1 and id = $2 limit 1`, tenantId, id,
    );
    if (!rows[0]) throw new NotFoundException('Department not found');
    return rows[0];
  }
}
