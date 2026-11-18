import { fetchSteamServers, STEAM_API_LIMIT, SteamServer } from '../api/steamClient'
import { processServers } from '../services/serverService'
import { TRACKED_GAMES, GameConfig, FilterNode } from '../config/games'
import { AppDataSource } from '../config/database'
import { logger } from '../logger'

const REQUEST_DELAY_MS = 1_000
const SLOT_MS = 15 * 60_000
const REGIONS = [0, 1, 2, 3, 4, 5, 6, 7]
const MAX_SPLIT_REQUESTS = 100
// a response cut at the limit is not always exactly 10000 rows (9999 seen), so anything close counts as cut
const NEAR_LIMIT = 9_500
// Fake-server farm = one IP with many servers: either many copies of a few names, or simply too many to be a real host
// (real CS:Source hosts run up to ~20 servers per IP, each with its own name; farms run 45-720)
const FARM_MIN_SERVERS_PER_IP = 20
const FARM_MIN_COPIES_PER_NAME = 3
const FARM_ALWAYS_SERVERS_PER_IP = 50

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithFallback(
  appid: number,
  label: string,
  extraFilter: string,
  children: FilterNode[] | undefined,
  depth: number,
): Promise<SteamServer[]> {
  const prefix = '  '.repeat(depth) + `[${label}]`
  const servers = await fetchSteamServers(appid, extraFilter)

  if (servers.length < STEAM_API_LIMIT) {
    logger.info(`${prefix} Got ${servers.length} servers — OK`)
    return servers
  }

  logger.warn(`${prefix} Hit API limit (${STEAM_API_LIMIT} servers), switching to sub-filters...`)

  if (!children || children.length === 0) {
    logger.warn(`${prefix} No sub-filters configured — data may be incomplete!`)
    return servers
  }

  const allServers: SteamServer[] = []
  const seen = new Set<string>()

  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    const childServers = await fetchWithFallback(
      appid,
      child.label,
      extraFilter + child.extraFilter,
      child.children,
      depth + 1,
    )

    for (const s of childServers) {
      if (!seen.has(s.addr)) {
        seen.add(s.addr)
        allServers.push(s)
      }
    }

    if (i < children.length - 1) {
      logger.info(`Waiting ${REQUEST_DELAY_MS}ms before next request...`)
      await delay(REQUEST_DELAY_MS)
    }
  }

  logger.info(`${prefix} Total collected after sub-filters: ${allServers.length}`)
  return allServers
}

// positive conditions are appended as is; all negated ones share one \nor\ group (NOT a AND NOT b ...)
interface SplitNode {
  pos: string[]
  neg: string[]
  byRegion: boolean
  byMap: boolean
}

function nodeFilter(node: SplitNode): string {
  return node.pos.join('') + (node.neg.length > 0 ? `\\nor\\${node.neg.length}${node.neg.join('')}` : '')
}

function countsDesc(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function usedValues(conditions: string[], key: string): Set<string> {
  const prefix = `\\${key}\\`
  return new Set(conditions.filter((c) => c.startsWith(prefix)).map((c) => c.slice(prefix.length)))
}

// Splits a node that hit the limit into disjoint children that together cover it; null when nothing is left to split by
function splitNode(node: SplitNode, servers: SteamServer[]): SplitNode[] | null {
  if (!node.byRegion) {
    const regions = REGIONS.map((r) => `\\region\\${r}`)
    return [
      ...regions.map((r) => ({ ...node, byRegion: true, pos: [...node.pos, r] })),
      { ...node, byRegion: true, neg: [...node.neg, ...regions] }, // region -1, 255 and anything else
    ]
  }

  if (!node.byMap) {
    // peel off the most common map; the rest is split again if it still hits the limit
    const used = usedValues(node.neg, 'map')
    const map = countsDesc(servers.map((s) => s.map)).find(([m]) => m !== '' && !m.includes('\\') && !used.has(m))?.[0]
    if (map === undefined) return null
    return [
      { ...node, byMap: true, pos: [...node.pos, `\\map\\${map}`] },
      { ...node, neg: [...node.neg, `\\map\\${map}`] },
    ]
  }

  // one map is over the limit: split by the gametype tag closest to half of the response. Tags that change from minute to
  // minute (DayZ puts the in-game time like "09:19") are skipped: a server would move between the two halves between
  // their requests and be missed by both
  const used = usedValues([...node.pos, ...node.neg], 'gametype')
  const isStable = (t: string): boolean => t !== '' && !t.includes('\\') && !t.includes(':') && !/^[0-9.]+$/.test(t)
  const tags = countsDesc(servers.flatMap((s) => (s.gametype ?? '').split(',').filter(isStable)))
    .filter(([tag, n]) => !used.has(tag) && n < servers.length)
  if (tags.length === 0) return null
  const half = servers.length / 2
  const [tag] = tags.reduce((best, cur) => (Math.abs(cur[1] - half) < Math.abs(best[1] - half) ? cur : best))
  return [
    { ...node, pos: [...node.pos, `\\gametype\\${tag}`] },
    { ...node, neg: [...node.neg, `\\gametype\\${tag}`] },
  ]
}

async function fetchBySplitting(game: GameConfig): Promise<{ servers: SteamServer[]; complete: boolean }> {
  const found = new Map<string, SteamServer>()
  let requests = 0
  let complete = true

  const walk = async (node: SplitNode): Promise<void> => {
    if (requests >= MAX_SPLIT_REQUESTS) {
      complete = false
      return
    }
    if (requests > 0) await delay(REQUEST_DELAY_MS)
    requests++

    const servers = await fetchSteamServers(game.appid, (game.baseFilter ?? '') + nodeFilter(node))
    for (const s of servers) found.set(s.addr, s)
    if (servers.length < NEAR_LIMIT) return

    const children = splitNode(node, servers)
    if (children === null) {
      complete = false
      return
    }
    for (const child of children) await walk(child)
  }

  await walk({ pos: [], neg: [], byRegion: false, byMap: false })

  const status = complete ? 'complete' : `INCOMPLETE (request cap ${MAX_SPLIT_REQUESTS} or nothing left to split by)`
  logger.info(`[${game.name}] Split into ${requests} request(s): ${found.size} unique servers, ${status}`)
  return { servers: [...found.values()], complete }
}

function dropFarms(servers: SteamServer[], label: string): SteamServer[] {
  const byIp = new Map<string, { count: number; names: Set<string> }>()
  for (const s of servers) {
    const ip = s.addr.split(':')[0]
    const entry = byIp.get(ip) ?? { count: 0, names: new Set<string>() }
    entry.count++
    entry.names.add(s.name)
    byIp.set(ip, entry)
  }

  const farms = new Set(
    [...byIp.entries()]
      .filter(
        ([, e]) =>
          e.count >= FARM_ALWAYS_SERVERS_PER_IP ||
          (e.count >= FARM_MIN_SERVERS_PER_IP && e.count >= FARM_MIN_COPIES_PER_NAME * e.names.size),
      )
      .map(([ip]) => ip),
  )
  const kept = servers.filter((s) => !farms.has(s.addr.split(':')[0]))
  logger.info(`[${label}] Dropped ${servers.length - kept.length} farm server(s) on ${farms.size} IP(s), kept ${kept.length}`)
  return kept
}

export async function fetchGameServers(game: GameConfig): Promise<{ servers: SteamServer[]; complete: boolean }> {
  const fetched = game.splitOnLimit
    ? await fetchBySplitting(game)
    : await fetchWithFallback(game.appid, game.name, game.baseFilter ?? '', game.fallbackFilters, 0).then((servers) => ({
        servers,
        complete: servers.length < NEAR_LIMIT, // a merged sub-filter result is not known to be complete
      }))

  return game.dropFarms ? { ...fetched, servers: dropFarms(fetched.servers, game.name) } : fetched
}

async function collectGame(game: GameConfig): Promise<void> {
  logger.info(`Processing game: ${game.name} (appid: ${game.appid})`)

  const { servers, complete } = await fetchGameServers(game)

  await processServers(servers, game.appid, complete)
}

export async function runCollectJob(): Promise<void> {
  const startMs = Date.now()

  // recorded_at is written with this process's clock, so the slot start is taken from it too, not from the DB's now()
  const slotStart = new Date(Math.floor(startMs / SLOT_MS) * SLOT_MS)
  const existing = await AppDataSource.query<unknown[]>(
    'SELECT 1 FROM online_records WHERE recorded_at >= $1 LIMIT 1',
    [slotStart],
  )
  if (existing.length > 0) {
    logger.warn(`Slot ${slotStart.toISOString()} is already collected, skipping`)
    return
  }

  logger.info(`--- Starting server collection job (${TRACKED_GAMES.length} game(s)) ---`)

  for (let i = 0; i < TRACKED_GAMES.length; i++) {
    const game = TRACKED_GAMES[i]
    try {
      await collectGame(game)
    } catch (err: unknown) {
      logger.error(`Collect failed for ${game.name} (appid: ${game.appid}): ${err instanceof Error ? err.message : String(err)}`)
    }

    if (i < TRACKED_GAMES.length - 1) {
      logger.info(`Waiting ${REQUEST_DELAY_MS}ms before next game...`)
      await delay(REQUEST_DELAY_MS)
    }
  }

  const duration = ((Date.now() - startMs) / 1000).toFixed(2)
  logger.info(`--- Job completed in ${duration}s ---`)
}
