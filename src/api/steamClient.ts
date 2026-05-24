import axios from 'axios'

import { logger } from '../logger'

export interface SteamServer {
  addr: string
  gameport: number
  steamid: string
  name: string
  appid: number
  gamedir: string
  version: string
  product: string
  region: number
  players: number
  max_players: number
  bots: number
  map: string
  secure: boolean
  dedicated: boolean
  os: string
  gametype: string
}

interface SteamApiResponse {
  response: {
    servers?: SteamServer[]
  }
}

const STEAM_API_URL = 'https://api.steampowered.com/IGameServersService/GetServerList/v1/'

export const STEAM_API_LIMIT = 10_000

export async function fetchSteamServers(appid: number, extraFilter = ''): Promise<SteamServer[]> {
  const apiKey = process.env.STEAM_API_KEY
  if (!apiKey) {
    throw new Error('STEAM_API_KEY is not set in environment variables')
  }

  const filter = `\\appid\\${appid}${extraFilter}\\empty\\1`
  const params = new URLSearchParams({
    key: apiKey,
    filter,
    limit: String(STEAM_API_LIMIT),
  })

  logger.info(`[appid:${appid}] Fetching servers (filter: ${filter})...`)

  const response = await axios.get<SteamApiResponse>(
    `${STEAM_API_URL}?${params}`,
    { timeout: 60_000 },
  )

  const servers = response.data?.response?.servers ?? []
  logger.info(`[appid:${appid}] Fetched ${servers.length} servers`)

  return servers
}
