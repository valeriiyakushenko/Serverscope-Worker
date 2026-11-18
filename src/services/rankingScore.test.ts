import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RankRow, scoreServers } from './rankingScore'

function row(serverId: number, median: number, emptyCount: number, historical = 0.5): RankRow {
  return {
    server_id: serverId,
    appid: 1,
    median_players: median.toFixed(2),
    empty_count: emptyCount,
    historical_rank_avg: historical.toFixed(4),
    popularity: '0.00',
    stability: '0.0000',
  }
}

test('all medians zero: no division by zero, median part is 0', () => {
  const result = scoreServers([row(1, 0, 0), row(2, 0, 48)])
  for (const r of result) assert.ok(Number.isFinite(r.score))
  assert.equal(result[0].serverId, 1)
  assert.equal(result[0].score, 0.25 * 1 + 0.25 * 0.5)
  assert.equal(result[1].score, 0.25 * 0.5 + 0.25 * 0.5)
})

test('single server', () => {
  const result = scoreServers([row(7, 10, 0)])
  assert.equal(result.length, 1)
  assert.equal(result[0].serverId, 7)
  assert.equal(result[0].score, 0.5 + 0.25 + 0.25 * 0.5)
})

test('equal scores are ordered by serverId whatever the input order', () => {
  const a = row(5, 10, 24)
  const b = row(3, 10, 24)
  const leader = row(9, 20, 0)
  const forward = scoreServers([a, b, leader]).map((r) => r.serverId)
  const backward = scoreServers([leader, b, a]).map((r) => r.serverId)
  assert.deepEqual(forward, [9, 3, 5])
  assert.deepEqual(backward, forward)
})

test('score follows 0.5*M/Mmax + 0.25*uptime + 0.25*P', () => {
  const result = scoreServers([row(1, 40, 0, 1), row(2, 10, 24, 0.2)])
  const second = result.find((r) => r.serverId === 2)!
  assert.equal(second.uptimeRatio, 0.75)
  assert.ok(Math.abs(second.score - (0.5 * (10 / 40) + 0.25 * 0.75 + 0.25 * 0.2)) < 1e-12)
  assert.deepEqual(result.map((r) => r.serverId), [1, 2])
})
