import { AppDataSource } from '../config/database'
import { Server } from '../entities/Server'
import { OnlineRecord } from '../entities/OnlineRecord'
import { SteamServer } from '../api/steamClient'
import { logger } from '../logger'

const CHUNK_SIZE = 500

interface ParsedServer {
  ip: string
  queryPort: number
  gamePort: number
  steamid: string
  name: string
  appid: number
  version: string
  map: string
  isSecure: boolean
  isDedicated: boolean
  os: string
  region: number
  gametypeRaw: string
  gametypeTags: string[]
  updatedAt: Date
  lastSeenAt: Date
  players: number
  maxPlayers: number
}

function parseServer(s: SteamServer, now: Date): ParsedServer | null {
  const colonIdx = s.addr.lastIndexOf(':')
  if (colonIdx === -1) return null

  const ip = s.addr.substring(0, colonIdx)
  const queryPort = parseInt(s.addr.substring(colonIdx + 1), 10)

  if (!ip || isNaN(queryPort)) return null

  return {
    ip,
    queryPort,
    gamePort: s.gameport,
    steamid: s.steamid,
    name: s.name ?? '',
    appid: s.appid,
    version: s.version ?? '',
    map: s.map ?? '',
    isSecure: s.secure ?? false,
    isDedicated: s.dedicated ?? false,
    os: s.os ?? '',
    region: s.region ?? 255,
    gametypeRaw: s.gametype ?? '',
    gametypeTags: s.gametype ? s.gametype.split(',') : [],
    updatedAt: now,
    lastSeenAt: now,
    players: s.players,
    maxPlayers: s.max_players,
  }
}

async function upsertServers(parsed: ParsedServer[]): Promise<void> {
  const serverRepo = AppDataSource.getRepository(Server)

  for (let i = 0; i < parsed.length; i += CHUNK_SIZE) {
    const chunk = parsed.slice(i, i + CHUNK_SIZE)
    const entities = chunk.map(({ ...server }) => ({ ...server, isOnline: true }))

    await serverRepo.upsert(entities, {
      conflictPaths: ['ip', 'queryPort'],
      skipUpdateIfNoValuesChanged: false,
    })

    logger.info(`Upserted servers: ${Math.min(i + CHUNK_SIZE, parsed.length)}/${parsed.length}`)
  }
}

async function insertStats(parsed: ParsedServer[], now: Date): Promise<void> {
  const statsRepo = AppDataSource.getRepository(OnlineRecord)
  let totalInserted = 0

  for (let i = 0; i < parsed.length; i += CHUNK_SIZE) {
    const chunk = parsed.slice(i, i + CHUNK_SIZE)
    const conditions: string[] = []
    const params: (string | number)[] = []

    chunk.forEach((s) => {
      params.push(s.ip, s.queryPort)
      const len = params.length
      conditions.push(`($${len - 1}, $${len})`)
    })

    const rows: Array<{ id: number; ip: string; query_port: number }> =
      await AppDataSource.query(
        `SELECT id, ip, query_port FROM servers WHERE (ip, query_port) IN (${conditions.join(', ')})`,
        params,
      )

    const serverMap = new Map(rows.map((r) => [`${r.ip}:${r.query_port}`, r.id]))

    const statsEntities = chunk
      .map((s) => {
        const serverId = serverMap.get(`${s.ip}:${s.queryPort}`)
        if (serverId === undefined) return null
        return { serverId, players: s.players, maxPlayers: s.maxPlayers, recordedAt: now }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)

    if (statsEntities.length > 0) {
      await statsRepo.insert(statsEntities)
      totalInserted += statsEntities.length
    }
  }

  logger.info(`Inserted ${totalInserted} stats records`)
}

export async function processServers(steamServers: SteamServer[]): Promise<void> {
  if (!steamServers.length) {
    logger.info('No servers in API response, skipping processing')
    return
  }

  const now = new Date()
  const parsed = steamServers
    .map((s) => parseServer(s, now))
    .filter((s): s is ParsedServer => s !== null)

  logger.info(`Parsed ${parsed.length}/${steamServers.length} valid servers`)

  await upsertServers(parsed)
  await insertStats(parsed, now)
  await updateGameStats(parsed, now)
}

async function updateGameStats(parsed: ParsedServer[], now: Date): Promise<void> {
  const appids = [...new Set(parsed.map((s) => s.appid))]

  for (const appid of appids) {
    const players = parsed
      .filter((s) => s.appid === appid)
      .reduce((sum, s) => sum + s.players, 0)

    const rows: Array<{ servers: string }> = await AppDataSource.query(
      `SELECT COUNT(*)::int AS servers FROM servers WHERE appid = $1`,
      [appid],
    )
    const servers = parseInt(rows[0].servers)

    await AppDataSource.query(
      `UPDATE games SET players = $1, servers = $2, updated_at = $3 WHERE appid = $4`,
      [players, servers, now, appid],
    )
  }
}

export async function markOfflineServers(
  appids: number[],
  cycleStartTime: Date,
  now: Date,
): Promise<void> {
  if (appids.length === 0) return

  const statsRepo = AppDataSource.getRepository(OnlineRecord)
  let totalMarked = 0

  for (const appid of appids) {
    const offlineRows: Array<{ id: number; max_players: number }> = await AppDataSource.query(
      `SELECT id, max_players FROM servers WHERE appid = $1 AND last_seen_at < $2`,
      [appid, cycleStartTime],
    )

    if (offlineRows.length === 0) {
      logger.info(`[appid:${appid}] No offline servers found`)
      continue
    }

    logger.info(`[appid:${appid}] Marking ${offlineRows.length} servers as offline`)

    await AppDataSource.query(
      `UPDATE servers SET is_online = false, players = 0, hourly_online = (SELECT jsonb_agg(0) FROM generate_series(1, 24)) WHERE id = ANY($1)`,
      [offlineRows.map((r) => r.id)],
    )

    for (let i = 0; i < offlineRows.length; i += CHUNK_SIZE) {
      const chunk = offlineRows.slice(i, i + CHUNK_SIZE)
      await statsRepo.insert(
        chunk.map((row) => ({
          serverId: row.id,
          players: 0,
          maxPlayers: row.max_players,
          recordedAt: now,
        })),
      )
    }

    totalMarked += offlineRows.length
  }

  logger.info(`Offline marking complete: ${totalMarked} servers total`)
}
