import 'reflect-metadata'
import 'dotenv/config'

import { AppDataSource } from '../config/database'

const APPID = 221100
const TOP_N = 10
const HISTORICAL_DAYS = 3
const SLOTS_PER_DAY = 96

interface RankRow {
  server_id: number
  appid: number
  median_players: string
  empty_count: number
}

interface HistoricalRankRow {
  server_id: number
  historical_rank_avg: string
}

async function main(): Promise<void> {
  await AppDataSource.initialize()

  const now = new Date()

  const rows = await AppDataSource.query<RankRow[]>(
    `
    WITH
    period AS (
      SELECT
        date_trunc('hour', $1::timestamptz) - INTERVAL '24 hours' AS period_start,
        date_trunc('hour', $1::timestamptz)                        AS period_end
    ),
    hourly_slots AS (
      SELECT generate_series(period_start, period_end - INTERVAL '1 hour', INTERVAL '1 hour') AS slot_start
      FROM period
    ),
    stats_bucketed AS (
      SELECT
        st.server_id,
        date_trunc('hour', st.recorded_at) AS hour_bucket,
        AVG(st.players)                    AS avg_players
      FROM online_records st
      JOIN period ON st.recorded_at >= period.period_start
                 AND st.recorded_at <  period.period_end
      WHERE st.server_id IN (SELECT id FROM servers WHERE appid = $2)
      GROUP BY st.server_id, date_trunc('hour', st.recorded_at)
    ),
    server_hourly AS (
      SELECT
        s.id    AS server_id,
        s.appid,
        hs.slot_start,
        COALESCE(sb.avg_players, 0) AS players
      FROM servers s
      CROSS JOIN hourly_slots hs
      LEFT JOIN stats_bucketed sb
             ON sb.server_id = s.id
            AND sb.hour_bucket = hs.slot_start
      WHERE s.appid = $2
    ),
    server_medians AS (
      SELECT
        server_id,
        appid,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY players) AS median_players
      FROM server_hourly
      GROUP BY server_id, appid
    ),
    empty_counts AS (
      SELECT
        st.server_id,
        COUNT(*) FILTER (WHERE st.players = 0)::int AS empty_count
      FROM online_records st
      JOIN period ON st.recorded_at >= period.period_start
                 AND st.recorded_at <  period.period_end
      WHERE st.server_id IN (SELECT id FROM servers WHERE appid = $2)
      GROUP BY st.server_id
    )
    SELECT
      sm.server_id,
      sm.appid,
      sm.median_players,
      COALESCE(ec.empty_count, ${SLOTS_PER_DAY}) AS empty_count
    FROM server_medians sm
    LEFT JOIN empty_counts ec ON ec.server_id = sm.server_id
    `,
    [now, APPID],
  )

  const historicalRows = await AppDataSource.query<HistoricalRankRow[]>(
    `
    SELECT
      server_id,
      AVG(COALESCE(1.0 - (rank - 1.0) / NULLIF(total_servers - 1, 0), 1.0)) AS historical_rank_avg
    FROM (
      SELECT
        sr.server_id,
        sr.rank,
        COUNT(*) OVER (PARTITION BY sr.appid, sr.calculated_at) AS total_servers,
        ROW_NUMBER() OVER (PARTITION BY sr.server_id ORDER BY sr.calculated_at DESC) AS rn
      FROM server_rankings sr
      WHERE sr.appid = $1
        AND sr.calculated_at < $2
    ) sub
    WHERE rn <= $3
    GROUP BY server_id
    `,
    [APPID, now, HISTORICAL_DAYS],
  )

  const historicalMap = new Map(historicalRows.map((r) => [r.server_id, parseFloat(r.historical_rank_avg)]))
  const maxMedian = Math.max(...rows.map((r) => parseFloat(r.median_players)), 0)

  const scored = rows.map((r) => {
    const median = parseFloat(r.median_players)
    const emptyCount = r.empty_count
    const historicalRankAvg = historicalMap.get(r.server_id) ?? 0.5
    const uptimeRatio = 1 - emptyCount / SLOTS_PER_DAY
    const medianNorm = maxMedian > 0 ? median / maxMedian : 0
    const score = 0.5 * medianNorm + 0.25 * uptimeRatio + 0.25 * historicalRankAvg
    return { serverId: r.server_id, median, emptyCount, uptimeRatio, historicalRankAvg, score }
  })

  scored.sort((a, b) => b.score - a.score)

  console.log(`\n=== Preview rankings for appid ${APPID} (top ${TOP_N}) ===\n`)
  console.log(
    'rank'.padEnd(6),
    'server_id'.padEnd(12),
    'score'.padEnd(8),
    'median'.padEnd(8),
    'uptime'.padEnd(8),
    'hist_avg',
  )
  console.log('-'.repeat(60))

  for (let i = 0; i < Math.min(TOP_N, scored.length); i++) {
    const r = scored[i]
    console.log(
      String(i + 1).padEnd(6),
      String(r.serverId).padEnd(12),
      r.score.toFixed(4).padEnd(8),
      r.median.toFixed(1).padEnd(8),
      r.uptimeRatio.toFixed(4).padEnd(8),
      r.historicalRankAvg.toFixed(4),
    )
  }

  console.log(`\nTotal servers computed: ${scored.length}`)
  await AppDataSource.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
