/**
 * The minimal CSV reader the operator scripts share.
 *
 * Enough of RFC 4180 for a spreadsheet export — quoted fields, embedded commas,
 * doubled quotes — and nothing more, because a spreadsheet export is the only thing
 * any of these scripts will ever read. `seedTesters`, `sendInvites` and
 * `backfillEmails` all take the same shape of file; this is the one implementation
 * of it, so a fix to the parser doesn't have to be found in three places.
 */

/** Splits one line into trimmed cells. */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell.trim())
  return cells
}

/** A header row plus its data rows, with blank lines dropped. */
export interface CsvTable {
  /** Lower-cased, with spaces/underscores/hyphens removed — see `columnIndex`. */
  header: string[]
  /** `line` is the 1-based line number in the original file, for error messages. */
  rows: { line: number; cells: string[] }[]
}

/**
 * Reads a whole CSV. Header names are normalized so `Email Address`, `email_address`
 * and `emailaddress` are all the same column — form builders and spreadsheets
 * disagree about spacing and case, and an operator shouldn't have to hand-edit a
 * header row to make an export usable.
 */
export function readCsvTable(text: string): CsvTable {
  const lines = text.split(/\r?\n/)
  const rows: CsvTable['rows'] = []
  let header: string[] = []

  lines.forEach((line, i) => {
    if (line.trim().length === 0) return
    const cells = parseCsvLine(line)
    if (header.length === 0) {
      header = cells.map((h) => h.toLowerCase().replace(/[\s_-]/g, ''))
      return
    }
    rows.push({ line: i + 1, cells })
  })

  return { header, rows }
}

/** First matching column index, or -1. Pass aliases in order of preference. */
export function columnIndex(header: string[], ...names: string[]): number {
  for (const name of names) {
    const at = header.indexOf(name)
    if (at >= 0) return at
  }
  return -1
}

/**
 * Does this text look like a CSV rather than a plain list?
 *
 * Used to let one argument accept either format. A header row is the giveaway: a
 * comma plus a recognisable column name. A names file is explicitly *not* allowed to
 * contain commas (`seedTesters` rejects them), so there is no ambiguous case.
 */
export function looksLikeCsv(text: string, ...knownColumns: string[]): boolean {
  const first = text.split(/\r?\n/).find((l) => l.trim().length > 0 && !l.startsWith('#'))
  if (!first || !first.includes(',')) return false
  const header = parseCsvLine(first).map((h) => h.toLowerCase().replace(/[\s_-]/g, ''))
  return knownColumns.some((c) => header.includes(c))
}

/**
 * Renders one row, quoting whatever needs it.
 *
 * Not optional politeness: display names now come from a signup form, where
 * "Dewi, Sinta" is an ordinary thing to type. Written raw, that row grows an extra
 * field and every column after it shifts — and the scripts that read these files back
 * (`send:invites`, `backfill:emails`) address columns by index, so the silent result
 * is mailing one tester another tester's password.
 */
export function toCsvRow(cells: (string | null | undefined)[]): string {
  return cells
    .map((raw) => {
      const cell = raw ?? ''
      return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
    })
    .join(',')
}
