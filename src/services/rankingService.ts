import { AppDataSource } from '../config/database'
import { ServerRanking } from '../entities/ServerRanking'
import { TRACKED_GAMES } from '../config/games'
import { logger } from '../logger'

const CHUNK_SIZE = 500

interface RankRow {
  server_id: number
  appid: number
  median_players: string
  rank: string
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
    )
    SELECT
      server_id,
      appid,
      median_players,
      ROW_NUMBER() OVER (PARTITION BY appid ORDER BY median_players DESC) AS rank
    FROM server_medians
    `,
    [now, appid],
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

    const entities: Partial<ServerRanking>[] = rows.map((r) => ({
      serverId: r.server_id,
      appid: r.appid,
      medianPlayers: parseFloat(r.median_players),
      rank: parseInt(r.rank, 10),
      calculatedAt: now,
    }))

    for (let i = 0; i < entities.length; i += CHUNK_SIZE) {
      await dailyStatsRepo.insert(entities.slice(i, i + CHUNK_SIZE))
    }

    logger.info(`[appid:${appid}] Rankings saved`)
  }

  logger.info('Daily rankings calculation complete')
}
