import { EntityManager } from 'typeorm'

import { AppDataSource } from '../config/database'
import { TRACKED_GAMES } from '../config/games'
import { logger } from '../logger'
import { RankRow, scoreServers } from './rankingScore'

const CHUNK_SIZE = 500
// a server with no players for this long drops out of the ranking (rank = 0); it comes back once it is seen again
const RANKED_WITHIN = '48 hours'

async function computeRanks(appid: number, now: Date, dayStart: Date): Promise<RankRow[]> {
  return AppDataSource.query<RankRow[]>(
    `
    WITH
    period AS (
      SELECT
        date_trunc('hour', $1::timestamptz) - INTERVAL '24 hours' AS period_start,
        date_trunc('hour', $1::timestamptz)                        AS period_end
    ),
    hourly_slots AS (
      SELECT generate_series(period_start, period_end - INTERVAL '1 hour', INTERVAL '1 hour') AS slot_start
      FROM period
    ),
    stats_bucketed AS (
      SELECT
        st.server_id,
        date_trunc('hour', st.recorded_at) AS hour_bucket,
        -- empty servers are not collected, so a slot without a point counts as 0: divide by the 4 collections per hour, not AVG
        SUM(st.players) / 4.0              AS avg_players
      FROM online_records st
      JOIN period ON st.recorded_at >= period.period_start
                 AND st.recorded_at <  period.period_end
      WHERE st.server_id IN (SELECT id FROM servers WHERE appid = $2)
      GROUP BY st.server_id, date_trunc('hour', st.recorded_at)
    ),
    server_hourly AS (
      SELECT
        s.id    AS server_id,
        s.appid,
        hs.slot_start,
        COALESCE(sb.avg_players, 0) AS players
      FROM servers s
      CROSS JOIN hourly_slots hs
      LEFT JOIN stats_bucketed sb
             ON sb.server_id = s.id
            AND sb.hour_bucket = hs.slot_start
      WHERE s.appid = $2
        AND s.last_seen_at >= $1::timestamptz - INTERVAL '${RANKED_WITHIN}'
    ),
    server_medians AS (
      SELECT
        server_id,
        appid,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY players) AS median_players
      FROM server_hourly
      GROUP BY server_id, appid
    ),
    empty_counts AS (
      SELECT
        st.server_id,
        (96 - COUNT(*))::int AS empty_count
      FROM online_records st
      JOIN period ON st.recorded_at >= period.period_start
                 AND st.recorded_at <  period.period_end
      WHERE st.server_id IN (SELECT id FROM servers WHERE appid = $2)
      GROUP BY st.server_id
    ),
    historical AS (
      SELECT
        server_id,
        AVG(COALESCE(1.0 - (rank - 1.0) / NULLIF(total_servers - 1, 0), 1.0)) AS historical_rank_avg
      FROM (
        SELECT
          sr.server_id,
          sr.rank,
          COUNT(*) OVER (PARTITION BY sr.appid, sr.calculated_at) AS total_servers,
          ROW_NUMBER() OVER (PARTITION BY sr.server_id ORDER BY sr.calculated_at DESC) AS rn
        FROM server_rankings sr
        WHERE sr.appid = $2
          AND sr.calculated_at < $3
      ) sub
      WHERE rn <= 3
      GROUP BY server_id
    ),
    week_recent AS (
      SELECT
        st.server_id,
        AVG(st.players) AS avg_players
      FROM online_records st
      WHERE st.server_id IN (SELECT id FROM servers WHERE appid = $2)
        AND st.recorded_at >= $1 - INTERVAL '7 days'
        AND st.recorded_at <  $1
      GROUP BY st.server_id
    ),
    week_prev AS (
      SELECT
        st.server_id,
        AVG(st.players) AS avg_players
      FROM online_records st
      WHERE st.server_id IN (SELECT id FROM servers WHERE appid = $2)
        AND st.recorded_at >= $1 - INTERVAL '14 days'
        AND st.recorded_at <  $1 - INTERVAL '7 days'
      GROUP BY st.server_id
    ),
    popularity_calc AS (
      SELECT
        COALESCE(wr.server_id, wp.server_id) AS server_id,
        GREATEST(-100.0, LEAST(100.0,
          CASE
            WHEN COALESCE(wp.avg_players, 0) = 0 THEN 0
            ELSE ROUND(((COALESCE(wr.avg_players, 0) - wp.avg_players) / wp.avg_players * 100)::numeric, 2)
          END
        )) AS popularity
      FROM week_recent wr
      FULL OUTER JOIN week_prev wp ON wp.server_id = wr.server_id
    ),
    stability_calc AS (
      SELECT
        st.server_id,
        CASE
          WHEN AVG(st.players) = 0 THEN 0
          ELSE ROUND(GREATEST(0, 1 - STDDEV(st.players) / NULLIF(AVG(st.players), 0))::numeric, 4)
        END AS stability
      FROM online_records st
      WHERE st.server_id IN (SELECT id FROM servers WHERE appid = $2)
        AND st.recorded_at >= $1 - INTERVAL '7 days'
        AND st.recorded_at <  $1
      GROUP BY st.server_id
    )
    SELECT
      sm.server_id,
      sm.appid,
      sm.median_players,
      COALESCE(ec.empty_count, 96)          AS empty_count,
      COALESCE(h.historical_rank_avg, 0.5)  AS historical_rank_avg,
      COALESCE(pc.popularity, 0)            AS popularity,
      COALESCE(sc.stability, 0)             AS stability
    FROM server_medians sm
    LEFT JOIN empty_counts    ec ON ec.server_id = sm.server_id
    LEFT JOIN historical      h  ON h.server_id  = sm.server_id
    LEFT JOIN popularity_calc pc ON pc.server_id = sm.server_id
    LEFT JOIN stability_calc  sc ON sc.server_id = sm.server_id
    `,
    [now, appid, dayStart],
  )
}

// servers left out of this calculation must not keep the rank of an earlier one
async function clearDroppedRanks(db: EntityManager, appid: number, rankedIds: number[]): Promise<void> {
  const [, cleared]: [unknown, number] = await db.query(
    `UPDATE servers SET rank = 0 WHERE appid = $1 AND rank <> 0 AND id <> ALL($2::int[])`,
    [appid, rankedIds],
  )
  logger.info(`[appid:${appid}] Cleared rank of ${cleared} server(s) not seen within ${RANKED_WITHIN}`)
}

async function rankGame(appid: number, now: Date, dayStart: Date): Promise<void> {
  logger.info(`[appid:${appid}] Computing ranks...`)

  const rows = await computeRanks(appid, now, dayStart)

  if (rows.length === 0) {
    logger.warn(`[appid:${appid}] No servers seen within ${RANKED_WITHIN}, skipping`)
    await clearDroppedRanks(AppDataSource.manager, appid, [])
    return
  }

  logger.info(`[appid:${appid}] Inserting ${rows.length} ranking records`)

  const scored = scoreServers(rows)

  // all-or-nothing per game: the API never sees a mix of old and new ranks, and a failure keeps the previous ones
  await AppDataSource.transaction(async (manager) => {
    for (let i = 0; i < scored.length; i += CHUNK_SIZE) {
      const chunk = scored.slice(i, i + CHUNK_SIZE)
      const values = chunk
        .map(
          (r, j) => {
            const base = j * 11
            return `($${base + 1}::int, $${base + 2}::int, $${base + 3}::numeric, $${base + 4}::int, $${base + 5}::int, $${base + 6}::numeric, $${base + 7}::numeric, $${base + 8}::numeric, $${base + 9}::numeric, $${base + 10}::numeric, $${base + 11}::timestamptz)`
          },
        )
        .join(', ')
      const params = chunk.flatMap((r, j) => [
        r.serverId,
        r.appid,
        r.median,
        i + j + 1,
        r.emptyCount,
        r.uptimeRatio,
        r.historicalRankAvg,
        r.score,
        r.popularity,
        r.stability,
        dayStart,
      ])

      await manager.query(
        `INSERT INTO server_rankings (server_id, appid, median_players, rank, empty_count, uptime_ratio, historical_rank_avg, score, popularity, stability, calculated_at)
         VALUES ${values}
         ON CONFLICT (server_id, calculated_at) DO UPDATE SET
           appid               = EXCLUDED.appid,
           median_players      = EXCLUDED.median_players,
           rank                = EXCLUDED.rank,
           empty_count         = EXCLUDED.empty_count,
           uptime_ratio        = EXCLUDED.uptime_ratio,
           historical_rank_avg = EXCLUDED.historical_rank_avg,
           score               = EXCLUDED.score,
           popularity          = EXCLUDED.popularity,
           stability           = EXCLUDED.stability`,
        params,
      )
    }

    for (let i = 0; i < scored.length; i += CHUNK_SIZE) {
      const chunk = scored.slice(i, i + CHUNK_SIZE)
      const valuePlaceholders = chunk.map((_, j) => `($${j * 2 + 1}::int, $${j * 2 + 2}::int)`).join(', ')
      const params = chunk.flatMap((r, j) => [r.serverId, i + j + 1])
      await manager.query(
        `UPDATE servers SET rank = v.rank FROM (VALUES ${valuePlaceholders}) AS v(id, rank) WHERE servers.id = v.id`,
        params,
      )
    }

    await clearDroppedRanks(manager, appid, scored.map((r) => r.serverId))
  })

  logger.info(`[appid:${appid}] Rankings saved`)
}

export async function calculateDailyRankings(): Promise<void> {
  const now = new Date()
  // one row per server per UTC day: a second run the same day overwrites it via ON CONFLICT instead of adding a duplicate
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const appids = TRACKED_GAMES.map((g) => g.appid)

  // ranks from a window with empty hours (first day, worker outage) are noise and feed three more days via historical_rank_avg
  const [{ hours }] = await AppDataSource.query<Array<{ hours: number }>>(
    `SELECT COUNT(*)::int AS hours
     FROM generate_series(
       date_trunc('hour', $1::timestamptz) - INTERVAL '24 hours',
       date_trunc('hour', $1::timestamptz) - INTERVAL '1 hour',
       INTERVAL '1 hour'
     ) AS h
     WHERE EXISTS (SELECT 1 FROM online_records WHERE recorded_at >= h AND recorded_at < h + INTERVAL '1 hour')`,
    [now],
  )
  if (hours < 24) {
    logger.warn(`Ranking window is incomplete (${hours}/24 hours have data), calculation skipped`)
    return
  }

  logger.info(`Calculating daily rankings for ${appids.length} game(s)...`)

  for (const appid of appids) {
    try {
      await rankGame(appid, now, dayStart)
    } catch (err) {
      logger.error(`[appid:${appid}] Ranking failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info('Daily rankings calculation complete')
}
