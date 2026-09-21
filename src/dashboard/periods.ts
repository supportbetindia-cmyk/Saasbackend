// Period math for the Company Dashboard (PRD 12). Compares a current window to the
// equivalent previous window (same elapsed duration), aligned to the tenant timezone.
// IST has no DST, so a fixed offset-at-now is accurate across the window.

export type PeriodKey = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'custom';
export type Range = { start: Date; end: Date };
export type PeriodRanges = { label: string; current: Range; previous: Range };

/** tz offset in minutes (local - UTC) at a given instant, via Intl (no deps). */
function tzOffsetMinutes(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUtc - at.getTime()) / 60000;
}

export function computeRanges(
  tz: string,
  period: PeriodKey,
  now: Date = new Date(),
  customFrom?: string,
  customTo?: string,
): PeriodRanges {
  if (period === 'custom' && customFrom && customTo) {
    const start = new Date(customFrom);
    const end = new Date(customTo);
    const span = end.getTime() - start.getTime();
    return {
      label: 'Custom period',
      current: { start, end },
      previous: { start: new Date(start.getTime() - span), end: start },
    };
  }

  const offsetMin = tzOffsetMinutes(tz, now);
  const toUtc = (localMs: number) => new Date(localMs - offsetMin * 60000);
  // "local" is a Date whose UTC getters read the tenant's wall clock.
  const local = new Date(now.getTime() + offsetMin * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const dow = local.getUTCDay(); // 0=Sun

  let curStart: Date;
  let prevStart: Date;
  let label: string;

  switch (period) {
    case 'today': {
      curStart = toUtc(Date.UTC(y, m, d));
      prevStart = toUtc(Date.UTC(y, m, d - 1));
      label = 'Today vs yesterday';
      break;
    }
    case 'week': {
      const mondayOffset = (dow + 6) % 7; // days since Monday
      curStart = toUtc(Date.UTC(y, m, d - mondayOffset));
      prevStart = toUtc(Date.UTC(y, m, d - mondayOffset - 7));
      label = 'This week vs last week';
      break;
    }
    case 'quarter': {
      const qMonth = m - (m % 3);
      curStart = toUtc(Date.UTC(y, qMonth, 1));
      prevStart = toUtc(Date.UTC(y, qMonth - 3, 1));
      label = 'This quarter vs last quarter';
      break;
    }
    case 'year': {
      curStart = toUtc(Date.UTC(y, 0, 1));
      prevStart = toUtc(Date.UTC(y - 1, 0, 1));
      label = 'This year vs last year';
      break;
    }
    case 'month':
    default: {
      curStart = toUtc(Date.UTC(y, m, 1));
      prevStart = toUtc(Date.UTC(y, m - 1, 1));
      label = 'This month vs last month';
      break;
    }
  }

  const elapsed = now.getTime() - curStart.getTime();
  return {
    label,
    current: { start: curStart, end: now },
    // Same elapsed time into the previous period → fair partial-period comparison.
    previous: { start: prevStart, end: new Date(prevStart.getTime() + elapsed) },
  };
}

export type Growth = {
  current: number;
  previous: number;
  changePct: number | null; // null when previous = 0 (no base)
  changeX: number | null; // multiple; null when previous = 0
  mode: 'normal' | 'new_base' | 'flat';
};

/** Growth % and Growth X with zero-base handling (PRD 12). */
export function growth(current: number, previous: number): Growth {
  if (previous === 0) {
    return {
      current, previous,
      changePct: current === 0 ? 0 : null,
      changeX: null,
      mode: current === 0 ? 'flat' : 'new_base',
    };
  }
  return {
    current, previous,
    changePct: Math.round(((current - previous) / previous) * 1000) / 10,
    changeX: Math.round((current / previous) * 100) / 100,
    mode: 'normal',
  };
}
