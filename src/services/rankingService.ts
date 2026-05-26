import { AppDataSource } from '../config/database'
import { ServerRanking } from '../entities/ServerRanking'
import { TRACKED_GAMES } from '../config/games'
import { logger } from '../logger'

const CHUNK_SIZE = 500

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

async function computeRanks(appid: number, now: Date): Promise<RankRow[]> {
  return AppDataSource.query<RankRow[]>(
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
      COALESCE(ec.empty_count, 96) AS empty_count
    FROM server_medians sm
    LEFT JOIN empty_counts ec ON ec.server_id = sm.server_id
    `,
    [now, appid],
  )
}

async function computeHistoricalRanks(appid: number, before: Date): Promise<HistoricalRankRow[]> {
  return AppDataSource.query<HistoricalRankRow[]>(
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
    WHERE rn <= 3
    GROUP BY server_id
    `,
    [appid, before],
  )
}

export async function calculateDailyRankings(): Promise<void> {
  const now = new Date()
  const dailyStatsRepo = AppDataSource.getRepository(ServerRanking)
  const appids = TRACKED_GAMES.map((g) => g.appid)

  logger.info(`Calculating daily rankings for ${appids.length} game(s)...`)

  for (const appid of appids) {
    logger.info(`[appid:${appid}] Computing ranks...`)

    const rows = await computeRanks(appid, now)

    if (rows.length === 0) {
      logger.warn(`[appid:${appid}] No servers found, skipping`)
      continue
    }

    logger.info(`[appid:${appid}] Inserting ${rows.length} ranking records`)

    const historicalRows = await computeHistoricalRanks(appid, now)
    const historicalMap = new Map(historicalRows.map((r) => [r.server_id, parseFloat(r.historical_rank_avg)]))

    const maxMedian = Math.max(...rows.map((r) => parseFloat(r.median_players)), 0)

    const scored = rows.map((r) => {
      const median = parseFloat(r.median_players)
      const emptyCount = r.empty_count
      const historicalRankAvg = historicalMap.get(r.server_id) ?? 0.5
      const uptimeRatio = 1 - emptyCount / 96
      const medianNorm = maxMedian > 0 ? median / maxMedian : 0
      const score = 0.5 * medianNorm + 0.25 * uptimeRatio + 0.25 * historicalRankAvg
      return { serverId: r.server_id, appid: r.appid, median, emptyCount, uptimeRatio, historicalRankAvg, score }
    })

    scored.sort((a, b) => b.score - a.score)

    const entities: Partial<ServerRanking>[] = scored.map((r, i) => ({
      serverId: r.serverId,
      appid: r.appid,
      medianPlayers: r.median,
      emptyCount: r.emptyCount,
      uptimeRatio: r.uptimeRatio,
      historicalRankAvg: r.historicalRankAvg,
      score: r.score,
      rank: i + 1,
      calculatedAt: now,
    }))

    for (let i = 0; i < entities.length; i += CHUNK_SIZE) {
      await dailyStatsRepo.insert(entities.slice(i, i + CHUNK_SIZE))
    }

    for (let i = 0; i < scored.length; i += CHUNK_SIZE) {
      const chunk = scored.slice(i, i + CHUNK_SIZE)
      const cases = chunk.map((_, j) => `WHEN $${j * 2 + 1} THEN $${j * 2 + 2}`).join(' ')
      const params: (number | string)[] = chunk.flatMap((r, j) => [r.serverId, j + i + 1])
      await AppDataSource.query(
        `UPDATE servers SET rank = CASE id ${cases} END WHERE id = ANY($${params.length + 1})`,
        [...params, chunk.map((r) => r.serverId)],
      )
    }

    logger.info(`[appid:${appid}] Rankings saved`)
  }

  logger.info('Daily rankings calculation complete')
}
