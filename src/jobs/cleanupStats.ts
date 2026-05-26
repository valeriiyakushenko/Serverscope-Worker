import { AppDataSource } from '../config/database'
import { logger } from '../logger'

const RETENTION_DAYS = 30
const DETAIL_HOURS = 36

export async function runCleanupJob(): Promise<void> {
  const startTime = Date.now()
  logger.info(`--- Starting stats cleanup job (detail: ${DETAIL_HOURS}h, retention: ${RETENTION_DAYS}d) ---`)

  const downsampleResult = await AppDataSource.query(
    `WITH to_aggregate AS (
       SELECT
         server_id,
         ROUND(AVG(players))::int        AS players,
         ROUND(AVG(max_players))::int    AS max_players,
         date_trunc('hour', recorded_at) AS recorded_at
       FROM online_records
       WHERE recorded_at <  NOW() - INTERVAL '${DETAIL_HOURS} hours'
         AND recorded_at >= NOW() - INTERVAL '${RETENTION_DAYS} days'
       GROUP BY server_id, date_trunc('hour', recorded_at)
     ),
     deleted AS (
       DELETE FROM online_records
       WHERE recorded_at <  NOW() - INTERVAL '${DETAIL_HOURS} hours'
         AND recorded_at >= NOW() - INTERVAL '${RETENTION_DAYS} days'
       RETURNING id
     )
     INSERT INTO online_records (server_id, players, max_players, recorded_at)
     SELECT server_id, players, max_players, recorded_at FROM to_aggregate`,
  )

  const downsampledCount: number = Array.isArray(downsampleResult) ? downsampleResult[1] ?? 0 : 0
  logger.info(`Downsampled to hourly: ${downsampledCount} hourly buckets inserted`)

  const deleteRankingsResult = await AppDataSource.query(
    `DELETE FROM server_rankings WHERE calculated_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`,
  )

  const deletedRankingsCount: number = Array.isArray(deleteRankingsResult) ? deleteRankingsResult[1] ?? 0 : 0
  logger.info(`Cleanup complete: ${deletedRankingsCount} rankings deleted (>${RETENTION_DAYS}d)`)

  const deleteResult = await AppDataSource.query(
    `DELETE FROM online_records WHERE recorded_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`,
  )

  const deletedCount: number = Array.isArray(deleteResult) ? deleteResult[1] ?? 0 : 0
  const duration = ((Date.now() - startTime) / 1000).toFixed(2)
  logger.info(`Cleanup complete: ${deletedCount} rows deleted (>${RETENTION_DAYS}d) in ${duration}s`)
}
