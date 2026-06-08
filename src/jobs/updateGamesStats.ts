import { AppDataSource } from '../config/database'
import { logger } from '../logger'

async function updateGameCharts(now: Date): Promise<void> {
  await AppDataSource.query(
    `
    WITH
    period AS (
      SELECT
        date_trunc('hour', $1::timestamptz) - INTERVAL '24 hours' AS period_start,
        date_trunc('hour', $1::timestamptz)                      AS period_end
    ),
    hourly_slots AS (
      SELECT generate_series(period_start, period_end - INTERVAL '1 hour', INTERVAL '1 hour') AS slot_start
      FROM period
    ),
    snapshots AS (
      SELECT
        s.appid,
        r.recorded_at,
        SUM(r.players) AS snapshot_total
      FROM online_records r
      JOIN servers s ON s.id = r.server_id
      JOIN period ON r.recorded_at >= period.period_start
                 AND r.recorded_at <  period.period_end
      GROUP BY s.appid, r.recorded_at
    ),
    hourly_avg AS (
      SELECT
        appid,
        date_trunc('hour', recorded_at) AS hour,
        AVG(snapshot_total)::int        AS avg_players
      FROM snapshots
      GROUP BY appid, date_trunc('hour', recorded_at)
    ),
    game_graphs AS (
      SELECT
        g.appid,
        jsonb_agg(COALESCE(ha.avg_players, 0) ORDER BY hs.slot_start) AS hourly_online
      FROM games g
      CROSS JOIN hourly_slots hs
      LEFT JOIN hourly_avg ha ON ha.appid = g.appid AND ha.hour = hs.slot_start
      GROUP BY g.appid
    )
    UPDATE games SET hourly_online = gg.hourly_online, updated_at = $1
    FROM game_graphs gg
    WHERE games.appid = gg.appid
    `,
    [now],
  )
}

export async function updateServerCharts(now: Date): Promise<void> {
  await AppDataSource.query(
    `
    WITH
    period AS (
      SELECT
        date_trunc('hour', $1::timestamptz) - INTERVAL '24 hours' AS period_start,
        date_trunc('hour', $1::timestamptz)                      AS period_end
    ),
    hourly_slots AS (
      SELECT generate_series(period_start, period_end - INTERVAL '1 hour', INTERVAL '1 hour') AS slot_start
      FROM period
    ),
    active_servers AS (
      SELECT DISTINCT r.server_id
      FROM online_records r
      JOIN period ON r.recorded_at >= period.period_start AND r.recorded_at < period.period_end
    ),
    bucketed AS (
      SELECT
        r.server_id,
        date_trunc('hour', r.recorded_at) AS hour,
        AVG(r.players)::int               AS avg_players
      FROM online_records r
      JOIN period ON r.recorded_at >= period.period_start AND r.recorded_at < period.period_end
      GROUP BY r.server_id, date_trunc('hour', r.recorded_at)
    ),
    server_graphs AS (
      SELECT
        a.server_id,
        jsonb_agg(COALESCE(b.avg_players, 0) ORDER BY hs.slot_start) AS hourly_online
      FROM active_servers a
      CROSS JOIN hourly_slots hs
      LEFT JOIN bucketed b ON b.server_id = a.server_id AND b.hour = hs.slot_start
      GROUP BY a.server_id
    )
    UPDATE servers SET hourly_online = sg.hourly_online
    FROM server_graphs sg
    WHERE servers.id = sg.server_id
    `,
    [now],
  )
}

export async function runUpdateChartsJob(): Promise<void> {
  const startTime = Date.now()
  logger.info('--- Starting charts update job ---')

  const now = new Date()

  await updateServerCharts(now)
  await updateGameCharts(now)
  logger.info('Game hourly_online updated')

  const duration = ((Date.now() - startTime) / 1000).toFixed(2)
  logger.info(`--- Charts update complete in ${duration}s ---`)
}
