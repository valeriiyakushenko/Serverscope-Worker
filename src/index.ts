import 'reflect-metadata'
import 'dotenv/config'
import cron from 'node-cron'

import { AppDataSource } from './config/database'
import { runCollectJob } from './jobs/collectServers'
import { runRankingJob } from './jobs/calculateRankings'
import { runUpdateChartsJob } from './jobs/updateGamesStats'
import { logger } from './logger'

const LOCK_COLLECT = 1
const LOCK_CHARTS = 2
const LOCK_RANKING = 3

// Session-level advisory lock: skips the run if another process (or a still-running previous run) holds it.
// Lock and unlock must go through the same connection; PostgreSQL drops the lock itself if the connection dies.
async function withLock(key: number, name: string, job: () => Promise<void>): Promise<void> {
  const runner = AppDataSource.createQueryRunner()
  await runner.connect()
  try {
    const [{ ok }] = await runner.query('SELECT pg_try_advisory_lock($1) AS ok', [key])
    if (!ok) {
      logger.warn(`${name}: already running elsewhere, skipped`)
      return
    }
    try {
      await job()
    } finally {
      await runner.query('SELECT pg_advisory_unlock($1)', [key])
    }
  } finally {
    await runner.release()
  }
}

async function bootstrap(): Promise<void> {
  logger.info('Starting serverscope worker...')

  await AppDataSource.initialize()
  logger.info('Database connection established')


  // await runCollectJob().catch((err: unknown) => {
  //   logger.error(`Initial collect job failed: ${err instanceof Error ? err.message : String(err)}`)
  // })

  // await runUpdateChartsJob().catch((err: unknown) => {
  //   logger.error(`Initial charts job failed: ${err instanceof Error ? err.message : String(err)}`)
  // })

  // await runRankingJob().catch((err: unknown) => {
  //   logger.error(`Initial ranking job failed: ${err instanceof Error ? err.message : String(err)}`)
  // })

  // await runCleanupJob().catch((err: unknown) => {
  //   logger.error(`Initial cleanup job failed: ${err instanceof Error ? err.message : String(err)}`)
  // })


  cron.schedule('*/15 * * * *', () => {
    withLock(LOCK_COLLECT, 'collect', runCollectJob).catch((err: unknown) => {
      logger.error(`Scheduled collect job failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  })

  cron.schedule('0 * * * *', () => {
    withLock(LOCK_CHARTS, 'charts', runUpdateChartsJob).catch((err: unknown) => {
      logger.error(`Scheduled charts job failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, { timezone: 'UTC' })

  cron.schedule('0 0 * * *', () => {
    withLock(LOCK_RANKING, 'ranking', runRankingJob).catch((err: unknown) => {
      logger.error(`Scheduled ranking job failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, { timezone: 'UTC' })

  // cleanup (runCleanupJob) is not scheduled: raw 15-minute points are kept until the storage schema is reworked

  logger.info('Cron jobs scheduled: collect */15 * * * *, games stats 0 * * * * (UTC), rankings 0 0 * * * (UTC). Worker is running...')
}

bootstrap().catch((err: unknown) => {
  logger.error(`Failed to start worker: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
