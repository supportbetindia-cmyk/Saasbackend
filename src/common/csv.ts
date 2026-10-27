// Minimal, safe CSV serializer. No dependency.
// - Quotes fields containing comma/quote/newline and escapes embedded quotes.
// - Neutralizes CSV/formula injection (a leading = + - @ tab) so a cell can't be
//   executed as a formula when the file is opened in Excel/Sheets.

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? String(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // formula-injection guard
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize rows to CSV text using the given column order (keys of each row). */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(cell).join(',');
  const body = rows.map((r) => columns.map((c) => cell(r[c])).join(',')).join('\n');
  return rows.length ? `${header}\n${body}\n` : `${header}\n`;
}
