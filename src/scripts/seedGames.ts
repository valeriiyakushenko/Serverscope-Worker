import 'reflect-metadata'
import 'dotenv/config'

import { AppDataSource } from '../config/database'
import { TRACKED_GAMES } from '../config/games'

interface HourlyRow {
  slot_start: string
  total_players: number
}

interface ServerStats {
  players: number
  servers: number
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

async function getServerStats(appid: number): Promise<ServerStats> {
  const rows: Array<{ players: string; servers: string }> = await AppDataSource.query(
    `SELECT COALESCE(SUM(players), 0)::int AS players, COUNT(*)::int AS servers
     FROM servers WHERE appid = $1`,
    [appid],
  )
  return {
    players: parseInt(rows[0].players),
    servers: parseInt(rows[0].servers),
  }
}

async function main(): Promise<void> {
  await AppDataSource.initialize()

  const now = new Date()
  let inserted = 0
  let skipped = 0

  for (const game of TRACKED_GAMES) {
    const existing: Array<{ id: number }> = await AppDataSource.query(
      `SELECT id FROM games WHERE appid = $1`,
      [game.appid],
    )

    if (existing.length > 0) {
      console.log(`[appid:${game.appid}] ${game.name} — already exists, skipping`)
      skipped++
      continue
    }

    const [hourlyOnline, stats] = await Promise.all([
      buildHourlyOnline(game.appid, now),
      getServerStats(game.appid),
    ])

    await AppDataSource.query(
      `INSERT INTO games (appid, name, image_link, players, servers, hourly_online, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
      [game.appid, game.name, stats.players, stats.servers, JSON.stringify(hourlyOnline), now],
    )

    console.log(
      `[appid:${game.appid}] ${game.name} — inserted` +
      ` (players: ${stats.players}, servers: ${stats.servers},` +
      ` hourly_online: ${hourlyOnline.filter((v) => v > 0).length}/24 slots with data)`,
    )
    inserted++
  }

  console.log(`\nDone. Inserted: ${inserted}, skipped (already exist): ${skipped}`)
  await AppDataSource.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
