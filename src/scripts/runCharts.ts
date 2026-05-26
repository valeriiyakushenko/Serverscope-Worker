import 'reflect-metadata'
import 'dotenv/config'

import { AppDataSource } from '../config/database'
import { runUpdateChartsJob, updateServerCharts } from '../jobs/updateGamesStats'

async function main(): Promise<void> {
  await AppDataSource.initialize()
  const now = new Date()
  await updateServerCharts(now)
  await runUpdateChartsJob()
  await AppDataSource.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
