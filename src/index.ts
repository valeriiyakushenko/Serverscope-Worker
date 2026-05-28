import 'reflect-metadata'
import 'dotenv/config'
import cron from 'node-cron'

import { AppDataSource } from './config/database'
import { runCollectJob } from './jobs/collectServers'
import { runRankingJob } from './jobs/calculateRankings'
import { runCleanupJob } from './jobs/cleanupStats'
import { runUpdateChartsJob } from './jobs/updateGamesStats'
import { logger } from './logger'

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
    runCollectJob().catch((err: unknown) => {
      logger.error(`Scheduled collect job failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  })

  cron.schedule('0 * * * *', () => {
    runUpdateChartsJob().catch((err: unknown) => {
      logger.error(`Scheduled charts job failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, { timezone: 'UTC' })

  cron.schedule('0 0 * * *', () => {
    runRankingJob().catch((err: unknown) => {
      logger.error(`Scheduled ranking job failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, { timezone: 'UTC' })

  cron.schedule('0 12 * * *', () => {
    runCleanupJob().catch((err: unknown) => {
      logger.error(`Scheduled cleanup job failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, { timezone: 'UTC' })

  logger.info('Cron jobs scheduled: collect */15 * * * *, games stats 0 * * * * (UTC), rankings 0 0 * * * (UTC), cleanup 0 12 * * * (UTC). Worker is running...')
}

bootstrap().catch((err: unknown) => {
  logger.error(`Failed to start worker: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
