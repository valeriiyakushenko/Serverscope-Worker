// Pure scoring step of the daily ranking, kept free of DB imports so it can be tested

export interface RankRow {
  server_id: number
  appid: number
  median_players: string
  empty_count: number
  historical_rank_avg: string
  popularity: string
  stability: string
}

export interface ScoredServer {
  serverId: number
  appid: number
  median: number
  emptyCount: number
  uptimeRatio: number
  historicalRankAvg: number
  score: number
  popularity: number
  stability: number
}

// Returns servers best first; rank = index + 1. Equal scores are ordered by serverId so ranks do not depend on SQL row order.
export function scoreServers(rows: RankRow[]): ScoredServer[] {
  const maxMedian = rows.reduce((max, r) => Math.max(max, parseFloat(r.median_players)), 0)

  const scored = rows.map((r) => {
    const median = parseFloat(r.median_players)
    const emptyCount = r.empty_count
    const historicalRankAvg = parseFloat(r.historical_rank_avg)
    const uptimeRatio = 1 - emptyCount / 96
    const medianNorm = maxMedian > 0 ? median / maxMedian : 0
    const score = 0.5 * medianNorm + 0.25 * uptimeRatio + 0.25 * historicalRankAvg
    const popularity = parseFloat(r.popularity)
    const stability = parseFloat(r.stability)
    return { serverId: r.server_id, appid: r.appid, median, emptyCount, uptimeRatio, historicalRankAvg, score, popularity, stability }
  })

  scored.sort((a, b) => b.score - a.score || a.serverId - b.serverId)
  return scored
}
