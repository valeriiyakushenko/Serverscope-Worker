import { AppDataSource } from '../config/database'
import { logger } from '../logger'
import {
  DAY_MS,
  HOUR_MS,
  Partition,
  dayPartitions,
  expiredPartitions,
  monthPartitions,
  startOfDay,
  startOfHour,
} from './storagePartitions'

// Tiered storage next to online_records: 15-minute points for 48 hours, hourly rows for 90 days, daily rows and
// the hourly history of each game forever. Old data leaves by dropping a whole partition, never by DELETE.
// Nothing here may break the collection: every entry point logs its own failure and returns.

const RAW_KEEP_MS = 48 * HOUR_MS
const HOURLY_KEEP_MS = 90 * DAY_MS

const COPY_POINTS_SQL = `
  INSERT INTO online_raw (recorded_at, server_id, players, bots)
  SELECT recorded_at, server_id, LEAST(players, 32767), LEAST(bots, 32767)
  FROM online_records
  WHERE recorded_at >= $1 AND recorded_at < $2
  ON CONFLICT DO NOTHING`

const ROLL_SERVER_HOURS_SQL = `
  INSERT INTO online_hourly (hour, server_id, players_sum, bots_sum, players_max, samples)
  SELECT date_trunc('hour', recorded_at, 'UTC'), server_id, SUM(players), SUM(bots), MAX(players), COUNT(*)
  FROM online_raw
  WHERE recorded_at >= $1 AND recorded_at < $2
  GROUP BY 1, 2
  ON CONFLICT (server_id, hour) DO UPDATE SET
    players_sum = EXCLUDED.players_sum,
    bots_sum    = EXCLUDED.bots_sum,
    players_max = EXCLUDED.players_max,
    samples     = EXCLUDED.samples`

// one collection of a game = one recorded_at shared by all its servers
const ROLL_GAME_HOURS_SQL = `
  INSERT INTO game_hourly (appid, hour, players_sum, servers_sum, players_max, samples)
  SELECT appid, date_trunc('hour', recorded_at, 'UTC'), SUM(players), SUM(servers), MAX(players), COUNT(*)
  FROM (
    SELECT s.appid, r.recorded_at, SUM(r.players) AS players, COUNT(*) AS servers
    FROM online_raw r
    JOIN servers s ON s.id = r.server_id
    WHERE r.recorded_at >= $1 AND r.recorded_at < $2
    GROUP BY s.appid, r.recorded_at
  ) collections
  GROUP BY 1, 2
  ON CONFLICT (appid, hour) DO UPDATE SET
    players_sum = EXCLUDED.players_sum,
    servers_sum = EXCLUDED.servers_sum,
    players_max = EXCLUDED.players_max,
    samples     = EXCLUDED.samples`

const ROLL_DAYS_SQL = `
  INSERT INTO online_daily (day, server_id, players_sum, bots_sum, players_max, samples)
  SELECT (hour AT TIME ZONE 'UTC')::date, server_id, SUM(players_sum), SUM(bots_sum), MAX(players_max), SUM(samples)
  FROM online_hourly
  WHERE hour >= $1 AND hour < $2
  GROUP BY 1, 2
  ON CONFLICT (server_id, day) DO UPDATE SET
    players_sum = EXCLUDED.players_sum,
    bots_sum    = EXCLUDED.bots_sum,
    players_max = EXCLUDED.players_max,
    samples     = EXCLUDED.samples`

const SET_STATE_SQL = `
  INSERT INTO storage_state (name, done_until) VALUES ($1, $2)
  ON CONFLICT (name) DO UPDATE SET done_until = EXCLUDED.done_until`

// set once the migrations have run: without the tables every call below would only fill the log with errors
let ready = false
export function enableStorage(): void {
  ready = true
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// partitions this process has already seen, so a collection does not repeat the same DDL every 15 minutes
const known = new Set<string>()

async function createPartitions(parent: string, partitions: Partition[]): Promise<void> {
  for (const p of partitions) {
    if (known.has(p.name)) continue
    await AppDataSource.query(
      `CREATE TABLE IF NOT EXISTS ${p.name} PARTITION OF ${parent}
       FOR VALUES FROM ('${p.from.toISOString()}') TO ('${p.to.toISOString()}')`,
    )
    known.add(p.name)
  }
}

// A point or an hourly row can only be written into a partition that exists: make today's and the next one ahead
export async function ensurePartitions(now: Date): Promise<void> {
  if (!ready) return
  try {
    await createPartitions('online_raw', dayPartitions('online_raw', now, new Date(now.getTime() + DAY_MS)))
    await createPartitions('online_hourly', monthPartitions('online_hourly', now, new Date(now.getTime() + 31 * DAY_MS)))
  } catch (err: unknown) {
    logger.error(`Storage: creating partitions failed: ${errorText(err)}`)
  }
}

// Double write: the points one game has just stored under recordedAt, repeated in online_raw.
// shortcut: copied from online_records so both tables hold exactly the same points while they are compared;
// when online_records goes away, insert the parsed points here instead
export async function mirrorPoints(recordedAt: Date): Promise<void> {
  if (!ready) return
  try {
    await AppDataSource.query(COPY_POINTS_SQL, [recordedAt, new Date(recordedAt.getTime() + 1)])
  } catch (err: unknown) {
    logger.error(`Storage: copying points to online_raw failed: ${errorText(err)}`)
  }
}

async function readState(): Promise<Map<string, Date>> {
  const rows = await AppDataSource.query<Array<{ name: string; done_until: Date }>>(
    'SELECT name, done_until FROM storage_state',
  )
  return new Map(rows.map((r) => [r.name, r.done_until]))
}

// First run: the levels start at the first point ever collected, so the whole history is rolled up, not only new hours
async function loadState(now: Date): Promise<{ hourly: Date; daily: Date }> {
  let state = await readState()
  if (!state.has('hourly') || !state.has('daily')) {
    const [{ min }] = await AppDataSource.query<Array<{ min: Date | null }>>(
      'SELECT MIN(recorded_at) AS min FROM online_records',
    )
    const origin = min ?? now
    await AppDataSource.query(
      `INSERT INTO storage_state (name, done_until) VALUES ('hourly', $1), ('daily', $2) ON CONFLICT (name) DO NOTHING`,
      [startOfHour(origin), startOfDay(origin)],
    )
    state = await readState()
  }
  return { hourly: state.get('hourly')!, daily: state.get('daily')! }
}

// Rolls every finished hour that is not rolled yet, a day of data per transaction. Returns how far the hours are done.
async function rollHours(from: Date, now: Date): Promise<Date> {
  const to = startOfHour(now)
  while (from.getTime() < to.getTime()) {
    const end = new Date(Math.min(from.getTime() + DAY_MS, to.getTime()))
    await createPartitions('online_raw', dayPartitions('online_raw', from, end))
    await createPartitions('online_hourly', monthPartitions('online_hourly', from, end))
    // fills what the double write missed (first run: the whole history; later: a collection whose copy failed)
    await AppDataSource.query(COPY_POINTS_SQL, [from, end])
    await AppDataSource.transaction(async (db) => {
      await db.query(ROLL_SERVER_HOURS_SQL, [from, end])
      await db.query(ROLL_GAME_HOURS_SQL, [from, end])
      await db.query(SET_STATE_SQL, ['hourly', end])
    })
    logger.info(`Storage: hours rolled up to ${end.toISOString()}`)
    from = end
  }
  return from
}

// Rolls every day whose 24 hours are all rolled. Returns how far the days are done.
async function rollDays(from: Date, hoursDoneUntil: Date): Promise<Date> {
  const to = startOfDay(hoursDoneUntil)
  while (from.getTime() < to.getTime()) {
    const end = new Date(from.getTime() + DAY_MS)
    await AppDataSource.transaction(async (db) => {
      await db.query(ROLL_DAYS_SQL, [from, end])
      await db.query(SET_STATE_SQL, ['daily', end])
    })
    logger.info(`Storage: days rolled up to ${end.toISOString()}`)
    from = end
  }
  return from
}

async function dropExpired(parent: string, cutoff: Date): Promise<void> {
  const rows = await AppDataSource.query<Array<{ name: string }>>(
    `SELECT c.relname AS name
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = $1::regclass`,
    [parent],
  )
  for (const name of expiredPartitions(parent, rows.map((r) => r.name), cutoff)) {
    await AppDataSource.query(`DROP TABLE ${name}`)
    known.delete(name)
    logger.info(`Storage: dropped partition ${name}`)
  }
}

export async function runStorageJob(now: Date = new Date()): Promise<void> {
  if (!ready) return
  const startTime = Date.now()
  logger.info('--- Starting storage job ---')
  try {
    const state = await loadState(now)
    const hoursDoneUntil = await rollHours(state.hourly, now)
    const daysDoneUntil = await rollDays(state.daily, hoursDoneUntil)

    // a level is dropped only after the level above has taken its data
    const earlier = (a: number, b: Date): Date => new Date(Math.min(a, b.getTime()))
    await dropExpired('online_raw', earlier(now.getTime() - RAW_KEEP_MS, hoursDoneUntil))
    await dropExpired('online_hourly', earlier(now.getTime() - HOURLY_KEEP_MS, daysDoneUntil))

    logger.info(`--- Storage job completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s ---`)
  } catch (err: unknown) {
    logger.error(`Storage job failed: ${errorText(err)}`)
  }
}
