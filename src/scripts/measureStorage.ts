import 'reflect-metadata'
import 'dotenv/config'

import { AppDataSource } from '../config/database'
import { COMPUTE_RANKS_SQL } from '../services/rankingService'

// Sizes of the storage tables and timings of the key read queries, as JSON on stdout.
// Read-only: the session refuses writes, and every timed query is a SELECT, so it is safe on the running database.
// Run it before and after a storage change and compare the two files:
//   node dist/scripts/measureStorage.js > before.json
//   node dist/scripts/measureStorage.js --server=123 --runs=5 > after.json

const TABLES = ['online_records', 'server_rankings', 'servers', 'games', 'online_raw', 'online_hourly', 'online_daily', 'game_hourly']

// The API queries are copied from Serverscope-BackEnd/src/servers/servers.service.ts: keep them in step by hand
const SERVER_COLUMNS =
  'id, ip, query_port, game_port, name, appid, map, is_secure, is_dedicated, os, region, max_players, players, rank, hourly_online, is_online, version, last_seen_at, updated_at'
const LISTED = `appid = $1 AND last_seen_at >= NOW() - INTERVAL '5 days'`
const SLOT_15 = (expr: string): string =>
  `date_trunc('minute', ${expr}) - (EXTRACT(MINUTE FROM ${expr})::int % 15) * INTERVAL '1 minute'`

interface Query {
  id: string
  storage: 'current' | 'tiered'
  title: string
  sql: string
  params: 'server' | 'appid' | 'ranks'
}

const QUERIES: Query[] = [
  {
    id: 'chart-24h',
    storage: 'current',
    title: 'Server page: players chart, 24 hours by 15 minutes',
    params: 'server',
    sql: `WITH slots AS (SELECT generate_series(${SLOT_15(`NOW() - INTERVAL '24 hours'`)}, ${SLOT_15('NOW()')} - INTERVAL '15 minutes', INTERVAL '15 minutes') AS slot)
          SELECT slots.slot, COALESCE(AVG(r.players)::int, 0) AS players
          FROM slots LEFT JOIN online_records r ON ${SLOT_15('r.recorded_at')} = slots.slot AND r.server_id = $1
          GROUP BY slots.slot ORDER BY slots.slot`,
  },
  {
    id: 'chart-24h',
    storage: 'tiered',
    title: 'Server page: players chart, 24 hours by 15 minutes',
    params: 'server',
    sql: `WITH slots AS (SELECT generate_series(${SLOT_15(`NOW() - INTERVAL '24 hours'`)}, ${SLOT_15('NOW()')} - INTERVAL '15 minutes', INTERVAL '15 minutes') AS slot)
          SELECT slots.slot, COALESCE(AVG(r.players)::int, 0) AS players
          FROM slots LEFT JOIN online_raw r ON ${SLOT_15('r.recorded_at')} = slots.slot AND r.server_id = $1
                                           AND r.recorded_at >= NOW() - INTERVAL '25 hours'
          GROUP BY slots.slot ORDER BY slots.slot`,
  },
  {
    id: 'chart-30d',
    storage: 'current',
    title: 'Server page: players chart, 30 days by hour',
    params: 'server',
    sql: `WITH slots AS (SELECT generate_series(date_trunc('hour', NOW() - INTERVAL '30 days'), date_trunc('hour', NOW()) - INTERVAL '1 hour', INTERVAL '1 hour') AS slot)
          SELECT slots.slot, COALESCE((SUM(r.players) / 4.0)::int, 0) AS players
          FROM slots LEFT JOIN online_records r ON date_trunc('hour', r.recorded_at) = slots.slot AND r.server_id = $1
          GROUP BY slots.slot ORDER BY slots.slot`,
  },
  {
    id: 'chart-30d',
    storage: 'tiered',
    title: 'Server page: players chart, 30 days by hour',
    params: 'server',
    sql: `WITH slots AS (SELECT generate_series(date_trunc('hour', NOW() - INTERVAL '30 days'), date_trunc('hour', NOW()) - INTERVAL '1 hour', INTERVAL '1 hour') AS slot)
          SELECT slots.slot, COALESCE((h.players_sum / 4.0)::int, 0) AS players
          FROM slots LEFT JOIN online_hourly h ON h.hour = slots.slot AND h.server_id = $1
          ORDER BY slots.slot`,
  },
  {
    id: 'uptime-24h',
    storage: 'current',
    title: 'Server page: uptime chart, 24 hours by hour',
    params: 'server',
    sql: `SELECT date_trunc('hour', recorded_at) AS hour, LEAST(COUNT(*)::numeric / 4.0, 1.0) AS uptime_ratio
          FROM online_records
          WHERE server_id = $1 AND recorded_at >= date_trunc('hour', NOW()) - INTERVAL '24 hours' AND recorded_at < date_trunc('hour', NOW())
          GROUP BY 1`,
  },
  {
    id: 'uptime-24h',
    storage: 'tiered',
    title: 'Server page: uptime chart, 24 hours by hour',
    params: 'server',
    sql: `SELECT hour, LEAST(samples / 4.0, 1.0) AS uptime_ratio
          FROM online_hourly
          WHERE server_id = $1 AND hour >= date_trunc('hour', NOW()) - INTERVAL '24 hours' AND hour < date_trunc('hour', NOW())`,
  },
  {
    id: 'game-history-30d',
    storage: 'current',
    title: 'Game: average online by hour, 30 days (no table holds it yet, so it is computed from the points)',
    params: 'appid',
    sql: `SELECT date_trunc('hour', recorded_at) AS hour, AVG(total)::int AS players
          FROM (SELECT r.recorded_at, SUM(r.players) AS total
                FROM online_records r JOIN servers s ON s.id = r.server_id
                WHERE s.appid = $1 AND r.recorded_at >= NOW() - INTERVAL '30 days'
                GROUP BY r.recorded_at) collections
          GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'game-history-30d',
    storage: 'tiered',
    title: 'Game: average online by hour, 30 days',
    params: 'appid',
    sql: `SELECT hour, (players_sum / NULLIF(samples, 0))::int AS players
          FROM game_hourly WHERE appid = $1 AND hour >= NOW() - INTERVAL '30 days' ORDER BY hour`,
  },
  {
    id: 'list-by-rank',
    storage: 'current',
    title: 'Server list of a game: first page by rank',
    params: 'appid',
    sql: `SELECT ${SERVER_COLUMNS} FROM servers WHERE ${LISTED}
          ORDER BY CASE WHEN rank = 0 THEN 1 ELSE 0 END ASC, rank ASC, id ASC LIMIT 25`,
  },
  {
    id: 'list-count',
    storage: 'current',
    title: 'Server list of a game: total for the pager',
    params: 'appid',
    sql: `SELECT COUNT(*) FROM servers WHERE ${LISTED}`,
  },
  {
    id: 'list-search',
    storage: 'current',
    title: 'Server list of a game: search by name',
    params: 'appid',
    sql: `SELECT ${SERVER_COLUMNS} FROM servers WHERE ${LISTED} AND name ILIKE '%pvp%'
          ORDER BY CASE WHEN rank = 0 THEN 1 ELSE 0 END ASC, rank ASC, id ASC LIMIT 25`,
  },
  {
    id: 'maps',
    storage: 'current',
    title: 'Maps of a game with their server counts',
    params: 'appid',
    sql: `SELECT map, COUNT(*)::int AS "serverCount" FROM servers WHERE ${LISTED}
          GROUP BY map HAVING COUNT(*) >= 100 ORDER BY "serverCount" DESC`,
  },
  {
    id: 'ranking',
    storage: 'current',
    title: 'Worker: daily ranking query of one game',
    params: 'ranks',
    sql: COMPUTE_RANKS_SQL,
  },
]

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  Plans?: PlanNode[]
}

// "Index Scan idx on table" for every table the plan touches: shows at a glance which index, if any, was used
function scans(node: PlanNode, out: string[] = []): string[] {
  if (node['Relation Name']) {
    out.push(`${node['Node Type']}${node['Index Name'] ? ` ${node['Index Name']}` : ''} on ${node['Relation Name']}`)
  }
  for (const child of node.Plans ?? []) scans(child, out)
  return out
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

async function main(): Promise<void> {
  const arg = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const runs = Number(arg('runs') ?? 5)

  await AppDataSource.initialize()
  // one connection for everything, so the read-only setting covers every statement
  const db = AppDataSource.createQueryRunner()
  await db.connect()
  await db.query('SET default_transaction_read_only = on')

  const existing = new Set(
    (await db.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')`)).map(
      (r: { relname: string }) => r.relname,
    ),
  )

  const tables = []
  for (const table of TABLES.filter((t) => existing.has(t))) {
    // a partitioned table has no size of its own: add up the table and its partitions
    const [size] = await db.query(
      `SELECT SUM(pg_table_size(oid))::bigint AS heap, SUM(pg_indexes_size(oid))::bigint AS indexes
       FROM (SELECT $1::regclass::oid AS oid UNION SELECT inhrelid FROM pg_inherits WHERE inhparent = $1::regclass) parts`,
      [table],
    )
    const [{ rows }] = await db.query(`SELECT COUNT(*)::bigint AS rows FROM ${table}`)
    const total = Number(size.heap) + Number(size.indexes)
    tables.push({
      table,
      rows: Number(rows),
      heapBytes: Number(size.heap),
      indexBytes: Number(size.indexes),
      totalBytes: total,
      bytesPerRow: Number(rows) > 0 ? Math.round(total / Number(rows)) : null,
    })
  }

  const indexes = await db.query(
    `SELECT t.relname AS "table", i.relname AS index, pg_relation_size(i.oid)::bigint AS bytes, pg_get_indexdef(i.oid) AS definition
     FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
     WHERE t.relnamespace = 'public'::regnamespace AND t.relname = ANY($1) AND t.relkind = 'r'
     ORDER BY 1, 2`,
    [['online_records', 'server_rankings', 'servers', 'online_daily', 'game_hourly']],
  )

  // the server with the most points in the last day, and its game, unless one is named
  const [picked] = arg('server')
    ? await db.query(`SELECT id AS server_id, appid FROM servers WHERE id = $1`, [Number(arg('server'))])
    : await db.query(
        `SELECT r.server_id, s.appid FROM online_records r JOIN servers s ON s.id = r.server_id
         WHERE r.recorded_at >= NOW() - INTERVAL '24 hours'
         GROUP BY r.server_id, s.appid ORDER BY COUNT(*) DESC, r.server_id LIMIT 1`,
      )
  if (!picked) throw new Error('No server to measure: pass --server=<id>')
  const now = new Date()
  const params = {
    server: [picked.server_id],
    appid: [picked.appid],
    ranks: [now, picked.appid, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))],
  }

  const queries = []
  for (const q of QUERIES) {
    if (q.storage === 'tiered' && !existing.has('online_raw')) continue
    const times: number[] = []
    let plan: { Plan: PlanNode & { 'Shared Hit Blocks': number; 'Shared Read Blocks': number; 'Actual Rows': number } } | undefined
    for (let i = 0; i < runs; i++) {
      const [row] = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`, params[q.params])
      plan = row['QUERY PLAN'][0]
      times.push(row['QUERY PLAN'][0]['Execution Time'])
    }
    queries.push({
      id: q.id,
      storage: q.storage,
      title: q.title,
      medianMs: Number(median(times).toFixed(2)),
      minMs: Number(Math.min(...times).toFixed(2)),
      maxMs: Number(Math.max(...times).toFixed(2)),
      rows: plan!.Plan['Actual Rows'],
      // 8 kB pages the last run touched: read from cache + read from disk
      pages: plan!.Plan['Shared Hit Blocks'] + plan!.Plan['Shared Read Blocks'],
      scans: [...new Set(scans(plan!.Plan))],
    })
  }

  const [server] = await db.query(`SELECT version() AS version, NOW() AS measured_at`)
  console.log(
    JSON.stringify(
      { measuredAt: server.measured_at, postgres: server.version, runs, serverId: picked.server_id, appid: picked.appid, tables, indexes, queries },
      null,
      2,
    ),
  )

  await db.release()
  await AppDataSource.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
