// Partition naming and bounds for the tiered storage, kept free of DB imports so it can be tested.
// All boundaries are UTC: online_raw_YYYYMMDD covers one day, online_hourly_YYYYMM one month.

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS

export interface Partition {
  name: string
  from: Date
  to: Date
}

export function startOfHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS)
}

export function startOfDay(d: Date): Date {
  return new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS)
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

function nextMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function dayPartition(table: string, d: Date): Partition {
  const from = startOfDay(d)
  return {
    name: `${table}_${from.getUTCFullYear()}${pad(from.getUTCMonth() + 1)}${pad(from.getUTCDate())}`,
    from,
    to: new Date(from.getTime() + DAY_MS),
  }
}

export function monthPartition(table: string, d: Date): Partition {
  const from = startOfMonth(d)
  return { name: `${table}_${from.getUTCFullYear()}${pad(from.getUTCMonth() + 1)}`, from, to: nextMonth(from) }
}

// Every day partition that holds a moment of [from, to]
export function dayPartitions(table: string, from: Date, to: Date): Partition[] {
  const result: Partition[] = []
  for (let t = startOfDay(from).getTime(); t <= to.getTime(); t += DAY_MS) result.push(dayPartition(table, new Date(t)))
  return result
}

// Every month partition that holds a moment of [from, to]
export function monthPartitions(table: string, from: Date, to: Date): Partition[] {
  const result: Partition[] = []
  for (let d = startOfMonth(from); d.getTime() <= to.getTime(); d = nextMonth(d)) result.push(monthPartition(table, d))
  return result
}

// The upper bound of a partition, read back from its name; null for a name this module did not make
export function partitionEnd(table: string, name: string): Date | null {
  const m = new RegExp(`^${table}_(\\d{4})(\\d{2})(\\d{2})?$`).exec(name)
  if (!m) return null
  const [year, month] = [Number(m[1]), Number(m[2]) - 1]
  return m[3] === undefined ? new Date(Date.UTC(year, month + 1, 1)) : new Date(Date.UTC(year, month, Number(m[3]) + 1))
}

// Partitions that end at or before the cutoff: every row in them is older than the cutoff
export function expiredPartitions(table: string, names: string[], cutoff: Date): string[] {
  return names.filter((name) => {
    const end = partitionEnd(table, name)
    return end !== null && end.getTime() <= cutoff.getTime()
  })
}
