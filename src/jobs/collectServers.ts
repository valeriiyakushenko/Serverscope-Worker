import { fetchSteamServers, STEAM_API_LIMIT, SteamServer } from '../api/steamClient'
import { processServers } from '../services/serverService'
import { TRACKED_GAMES, GameConfig, FilterNode } from '../config/games'
import { logger } from '../logger'

const REQUEST_DELAY_MS = 1_000

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

async function collectGame(game: GameConfig): Promise<void> {
  logger.info(`Processing game: ${game.name} (appid: ${game.appid})`)

  const servers = await fetchWithFallback(
    game.appid,
    game.name,
    game.baseFilter ?? '',
    game.fallbackFilters,
    0,
  )

  await processServers(servers)
}

export async function runCollectJob(): Promise<void> {
  const startMs = Date.now()
  logger.info(`--- Starting server collection job (${TRACKED_GAMES.length} game(s)) ---`)

  for (let i = 0; i < TRACKED_GAMES.length; i++) {
    await collectGame(TRACKED_GAMES[i])

    if (i < TRACKED_GAMES.length - 1) {
      logger.info(`Waiting ${REQUEST_DELAY_MS}ms before next game...`)
      await delay(REQUEST_DELAY_MS)
    }
  }

  const duration = ((Date.now() - startMs) / 1000).toFixed(2)
  logger.info(`--- Job completed in ${duration}s ---`)
}
