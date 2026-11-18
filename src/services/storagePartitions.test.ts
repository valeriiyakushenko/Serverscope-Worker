import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dayPartition, dayPartitions, expiredPartitions, monthPartition, monthPartitions, partitionEnd } from './storagePartitions'

const at = (iso: string): Date => new Date(iso)

test('day partition covers one UTC day, whatever the time inside it', () => {
  const p = dayPartition('online_raw', at('2026-11-18T23:59:59.999Z'))
  assert.equal(p.name, 'online_raw_20261118')
  assert.equal(p.from.toISOString(), '2026-11-18T00:00:00.000Z')
  assert.equal(p.to.toISOString(), '2026-11-19T00:00:00.000Z')
})

test('month partition rolls over the year', () => {
  const p = monthPartition('online_hourly', at('2026-12-31T23:00:00Z'))
  assert.equal(p.name, 'online_hourly_202612')
  assert.equal(p.to.toISOString(), '2027-01-01T00:00:00.000Z')
})

test('ranges list every partition they touch, without gaps', () => {
  const days = dayPartitions('online_raw', at('2026-11-29T22:00:00Z'), at('2026-12-01T00:00:00Z'))
  assert.deepEqual(days.map((p) => p.name), ['online_raw_20261129', 'online_raw_20261130', 'online_raw_20261201'])
  for (let i = 1; i < days.length; i++) assert.equal(days[i].from.getTime(), days[i - 1].to.getTime())

  const months = monthPartitions('online_hourly', at('2026-11-12T05:30:00Z'), at('2027-01-01T00:00:00Z'))
  assert.deepEqual(months.map((p) => p.name), ['online_hourly_202611', 'online_hourly_202612', 'online_hourly_202701'])
})

test('the end of a partition is read back from its name', () => {
  assert.equal(partitionEnd('online_raw', 'online_raw_20261231')?.toISOString(), '2027-01-01T00:00:00.000Z')
  assert.equal(partitionEnd('online_hourly', 'online_hourly_202612')?.toISOString(), '2027-01-01T00:00:00.000Z')
  assert.equal(partitionEnd('online_raw', 'online_raw_default'), null)
  assert.equal(partitionEnd('online_raw', 'online_hourly_202612'), null)
})

test('a partition expires only when its last moment is older than the cutoff', () => {
  const names = ['online_raw_20261115', 'online_raw_20261116', 'online_raw_20261117', 'somebody_elses_table']
  // 48 hours before 2026-11-18 10:00 is 2026-11-16 10:00: the 16th still holds younger rows
  assert.deepEqual(expiredPartitions('online_raw', names, at('2026-11-16T10:00:00Z')), ['online_raw_20261115'])
  assert.deepEqual(expiredPartitions('online_raw', names, at('2026-11-17T00:00:00Z')), ['online_raw_20261115', 'online_raw_20261116'])
})
