import 'reflect-metadata'
import 'dotenv/config'
import cron from 'node-cron'

import { AppDataSource } from './config/database'
import { runCollectJob } from './jobs/collectServers'
import { runRankingJob } from './jobs/calculateRankings'
import { runUpdateChartsJob } from './jobs/updateGamesStats'
import { enableStorage, runStorageJob } from './services/storageService'
import { logger } from './logger'

const LOCK_COLLECT = 1
const LOCK_STORAGE = 2
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

  // A failed migration must not stop the collection: missed 15-minute points cannot be collected later.
  // The old tables keep working; the tiered storage stays off until the next start.
  try {
    const applied = await AppDataSource.runMigrations()
    if (applied.length > 0) logger.info(`Migrations applied: ${applied.map((m) => m.name).join(', ')}`)
    enableStorage()
  } catch (err: unknown) {
    logger.error(`Migrations failed, tiered storage is off: ${err instanceof Error ? err.message : String(err)}`)
  }

  // charts run at the end of the hourly collection under its lock: on their own schedule a slow collection
  // overlaps them and both write the same servers rows (deadlocks)
  cron.schedule('*/15 * * * *', () => {
    const hourly = new Date().getUTCMinutes() === 0 // taken at start: a slow collection can cross the minute
    withLock(LOCK_COLLECT, 'collect', async () => {
      await runCollectJob()
      if (hourly) {
        await runUpdateChartsJob().catch((err: unknown) => {
          logger.error(`Charts job failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    })
      // rollups do not write servers rows, so they run after the collect lock is released:
      // a long first run (the whole history) must not make the next collection skip its slot
      .then(() => (hourly ? withLock(LOCK_STORAGE, 'storage', runStorageJob) : undefined))
      .catch((err: unknown) => {
        logger.error(`Scheduled collect job failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  })

  cron.schedule('10 0 * * *', () => {
    withLock(LOCK_RANKING, 'ranking', runRankingJob).catch((err: unknown) => {
      logger.error(`Scheduled ranking job failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, { timezone: 'UTC' })

  // cleanup (runCleanupJob) is not scheduled: raw 15-minute points are kept until the storage schema is reworked

  logger.info('Cron jobs scheduled: collect */15 * * * * (charts and storage rollups after the :00 run), rankings 10 0 * * * (UTC). Worker is running...')
}

bootstrap().catch((err: unknown) => {
  logger.error(`Failed to start worker: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
