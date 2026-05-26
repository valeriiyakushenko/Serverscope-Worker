import { AppDataSource } from '../config/database'
import { TRACKED_GAMES } from '../config/games'
import { logger } from '../logger'

interface HourlyRow {
  slot_start: string
  total_players: number
}

async function buildHourlyOnline(appid: number, now: Date): Promise<number[]> {
  const rows = await AppDataSource.query<HourlyRow[]>(
    `
    WITH
    period AS (
      SELECT
        date_trunc('hour', $2::timestamptz) - INTERVAL '23 hours' AS period_start,
        date_trunc('hour', $2::timestamptz) + INTERVAL '1 hour'   AS period_end
    ),
    hourly_slots AS (
      SELECT generate_series(period_start, period_end - INTERVAL '1 hour', INTERVAL '1 hour') AS slot_start
      FROM period
    ),
    sums AS (
      SELECT
        date_trunc('hour', r.recorded_at) AS hour,
        SUM(r.players)::int               AS total_players
      FROM online_records r
      JOIN servers s ON s.id = r.server_id
      JOIN period ON r.recorded_at >= period.period_start
                 AND r.recorded_at <  period.period_end
      WHERE s.appid = $1
      GROUP BY date_trunc('hour', r.recorded_at)
    )
    SELECT
      hs.slot_start,
      COALESCE(sums.total_players, 0) AS total_players
    FROM hourly_slots hs
    LEFT JOIN sums ON sums.hour = hs.slot_start
    ORDER BY hs.slot_start
    `,
    [appid, now],
  )

  return rows.map((r) => r.total_players)
}

export async function runUpdateGamesStatsJob(): Promise<void> {
  const startTime = Date.now()
  logger.info('--- Starting games hourly_online update job ---')

  const now = new Date()

  for (const game of TRACKED_GAMES) {
    const hourlyOnline = await buildHourlyOnline(game.appid, now)

    await AppDataSource.query(
      `UPDATE games SET hourly_online = $1, updated_at = $2 WHERE appid = $3`,
      [JSON.stringify(hourlyOnline), now, game.appid],
    )

    logger.info(`[appid:${game.appid}] hourly_online updated`)
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2)
  logger.info(`--- Games hourly_online update complete in ${duration}s ---`)
}
