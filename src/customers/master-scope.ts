import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/** Master IDs are opaque, case-sensitive strings. Missing/empty means all masters. */
@Injectable()
export class MasterIdPipe implements PipeTransform {
  transform(value: unknown): string | undefined {
    if (value == null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new BadRequestException('masterId must be a single string of at most 128 characters');
    }
    return value.trim() || undefined;
  }
}

export function customerScope(tenantId: string, masterId?: string) {
  return { tenantId, ...(masterId ? { masterId } : {}) };
}

export function transactionScope(tenantId: string, masterId?: string) {
  return { tenantId, ...(masterId ? { customer: { is: { tenantId, masterId } } } : {}) };
}
