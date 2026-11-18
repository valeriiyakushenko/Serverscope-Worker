import { AppDataSource } from '../config/database'
import { Server } from '../entities/Server'
import { OnlineRecord } from '../entities/OnlineRecord'
import { STEAM_API_LIMIT, SteamServer } from '../api/steamClient'
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
  bots: number
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
    bots: s.bots ?? 0,
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
        return { serverId, players: s.players, bots: s.bots, maxPlayers: s.maxPlayers, recordedAt: now }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)

    if (statsEntities.length > 0) {
      await statsRepo.insert(statsEntities)
      totalInserted += statsEntities.length
    }
  }

  logger.info(`Inserted ${totalInserted} stats records`)
}

// Online = present in the last successful Steam response for its game; empty and stopped servers are not told apart
async function markMissingOffline(appid: number, now: Date): Promise<void> {
  const [, marked]: [unknown, number] = await AppDataSource.query(
    `UPDATE servers SET is_online = false, players = 0, bots = 0
     WHERE appid = $1 AND last_seen_at < $2 AND is_online`,
    [appid, now],
  )
  logger.info(`Marked ${marked} missing servers offline`)
}

// A failed request never reaches here (throws in collectGame); an empty response returns below without marking
export async function processServers(steamServers: SteamServer[], appid: number): Promise<void> {
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

  // shortcut: a response at the limit may be incomplete, so absence proves nothing; this also skips a complete merged
  // sub-filter result >= limit (no game has fallbackFilters yet) — pass a "complete" flag from fetchWithFallback if one gets them
  if (steamServers.length < STEAM_API_LIMIT) {
    await markMissingOffline(appid, now)
  } else {
    logger.warn(`Response reached ${STEAM_API_LIMIT} servers, not marking missing servers offline`)
  }

  await updateGameStats(parsed, now)
}

async function updateGameStats(parsed: ParsedServer[], now: Date): Promise<void> {
  const appids = [...new Set(parsed.map((s) => s.appid))]

  for (const appid of appids) {
    // online servers = servers in this response (\empty\1: at least one player); the servers table keeps every server ever seen
    const gameServers = parsed.filter((s) => s.appid === appid)
    const players = gameServers.reduce((sum, s) => sum + s.players, 0)
    const servers = gameServers.length

    await AppDataSource.query(
      `UPDATE games SET players = $1, servers = $2, updated_at = $3 WHERE appid = $4`,
      [players, servers, now, appid],
    )
  }
}

