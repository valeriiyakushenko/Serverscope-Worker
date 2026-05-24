import { calculateDailyRankings } from '../services/rankingService'
import { logger } from '../logger'

export async function runRankingJob(): Promise<void> {
  const startTime = Date.now()
  logger.info('--- Starting daily ranking job ---')

  await calculateDailyRankings()

  const duration = ((Date.now() - startTime) / 1000).toFixed(2)
  logger.info(`--- Ranking job completed in ${duration}s ---`)
}
