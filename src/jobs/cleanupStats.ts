import { AppDataSource } from '../config/database'
import { logger } from '../logger'

const RETENTION_DAYS = 30
const DETAIL_HOURS = 24

export async function runCleanupJob(): Promise<void> {
  const startTime = Date.now()
  logger.info(`--- Starting stats cleanup job (detail: ${DETAIL_HOURS}h, retention: ${RETENTION_DAYS}d) ---`)

  // Find the oldest recorded_at to determine how many day-batches to process
  const oldest = await AppDataSource.query<Array<{ min: Date | null }>>(
    `SELECT MIN(recorded_at) AS min FROM online_records WHERE recorded_at < NOW() - INTERVAL '${DETAIL_HOURS} hours'`,
  )
  const oldestDate = oldest[0]?.min

  if (!oldestDate) {
    logger.info('No records to process, skipping')
    return
  }

  const cutoff = new Date(Date.now() - DETAIL_HOURS * 60 * 60 * 1000)
  let totalInserted = 0
  let totalDeleted = 0

  // Process day by day from oldest to cutoff
  let dayStart = new Date(oldestDate)
  dayStart.setUTCHours(0, 0, 0, 0)

  while (dayStart < cutoff) {
    const dayEnd = new Date(dayStart)
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)
    const batchEnd = dayEnd < cutoff ? dayEnd : cutoff

    const result = await AppDataSource.query<Array<{ inserted: string }>>(
      `WITH to_aggregate AS (
         SELECT
           server_id,
           ROUND(AVG(players))::int        AS players,
           ROUND(AVG(max_players))::int    AS max_players,
           date_trunc('hour', recorded_at) AS recorded_at
         FROM online_records
         WHERE recorded_at >= $1 AND recorded_at < $2
         GROUP BY server_id, date_trunc('hour', recorded_at)
       ),
       deleted AS (
         DELETE FROM online_records
         WHERE recorded_at >= $1 AND recorded_at < $2
         RETURNING id
       ),
       inserted AS (
         INSERT INTO online_records (server_id, players, max_players, recorded_at)
         SELECT server_id, players, max_players, recorded_at FROM to_aggregate
         ON CONFLICT DO NOTHING
         RETURNING id
       )
       SELECT COUNT(*)::int AS inserted FROM inserted`,
      [dayStart, batchEnd],
    )

    const inserted = Number(result[0]?.inserted ?? 0)
    totalInserted += inserted
    logger.info(`Batch ${dayStart.toISOString().slice(0, 10)}: ${inserted} hourly buckets inserted`)

    dayStart = dayEnd
  }

  // Delete records older than retention period + deduplicate server_rankings (keep latest per day)
  const [rankingsResult, recordsResult] = await Promise.all([
    AppDataSource.query<Array<{ deleted: string }>>(
      `WITH latest_per_day AS (
         SELECT DISTINCT ON (server_id, DATE_TRUNC('day', calculated_at))
           id
         FROM server_rankings
         ORDER BY server_id, DATE_TRUNC('day', calculated_at), calculated_at DESC
       ),
       deleted AS (
         DELETE FROM server_rankings
         WHERE id NOT IN (SELECT id FROM latest_per_day)
            OR calculated_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
         RETURNING id
       )
       SELECT COUNT(*)::int AS deleted FROM deleted`,
    ),
    AppDataSource.query<Array<{ deleted: string }>>(
      `WITH deleted AS (
         DELETE FROM online_records WHERE recorded_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
         RETURNING id
       )
       SELECT COUNT(*)::int AS deleted FROM deleted`,
    ),
  ])

  totalDeleted = Number(recordsResult[0]?.deleted ?? 0)
  const deletedRankingsCount = Number(rankingsResult[0]?.deleted ?? 0)
  const duration = ((Date.now() - startTime) / 1000).toFixed(2)
  logger.info(`Downsampled to hourly: ${totalInserted} buckets total`)
  logger.info(`Deleted ${deletedRankingsCount} rankings and ${totalDeleted} records older than ${RETENTION_DAYS}d in ${duration}s`)
}
