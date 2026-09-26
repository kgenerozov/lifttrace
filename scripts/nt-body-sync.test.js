import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changedMappedStats,
  collectRelevantSources,
  BODY_SYNC_INTERVAL_MS,
  mapNtObservationToLt,
  newestWeightMeasurement,
  resolveBodySource,
  syncNtBodyMeasurements,
} from '../src/lib/nt-body-sync.js';

// Synthetic fixtures only; no live acceptance measurements are published.
const observation = (date, source, metrics) => ({ date, source, metrics });
const store = (value) => ({
  value,
  get() { return this.value; },
  set(next) { this.value = next; },
});

test('relevant sources are exact and ignore observations without supported fields', () => {
  const measurements = [
    observation('2026-08-14', 'health_connect', { steps: 9000 }),
    observation('2026-08-14', 'withings', { weight_kg: 72.5 }),
    observation('2026-08-15', 'health_connect', { body_fat_pct: 18.4 }),
  ];
  assert.deepEqual(collectRelevantSources(measurements), ['withings', 'health_connect']);
});

test('source resolution never silently chooses among multiple sources', () => {
  const measurements = [
    observation('2026-08-14', 'a', { weight_kg: 72 }),
    observation('2026-08-14', 'b', { body_fat_pct: 18 }),
  ];
  assert.equal(resolveBodySource(measurements, '').status, 'source-selection-required');
  assert.equal(resolveBodySource(measurements, 'b').source, 'b');
  assert.equal(resolveBodySource(measurements, 'missing').status, 'selected-empty');
  assert.equal(resolveBodySource([observation('2026-08-14', 'a', { weight_kg: 72 })], '').status, 'auto-selected');
});

test('mapping supports only weight and body fat and keeps the original kg value', () => {
  const mappedKg = mapNtObservationToLt(
    observation('2026-08-14', 'withings', { weight_kg: 72.5, body_fat_pct: 18.4, bmi: 26.1 }),
    'kg',
  );
  assert.deepEqual(mappedKg, { stats: { weight: 72.5, bodyFat: 18.4 }, weightKg: 72.5 });

  const mappedLb = mapNtObservationToLt(
    observation('2026-08-14', 'withings', { weight_kg: 72.5 }),
    'lbs',
  );
  assert.equal(mappedLb.stats.weight, 159.84);
  assert.equal(mappedLb.weightKg, 72.5);
  assert.deepEqual(mapNtObservationToLt(observation('2026-08-14', 'withings', { body_fat_pct: 18.4 }), 'kg'), {
    stats: { bodyFat: 18.4 },
    weightKg: null,
  });
});

test('identical mapped fields are a no-op and manual fields are not compared or cleared', () => {
  assert.deepEqual(
    changedMappedStats({ weight: 159.8, waist: 88, bodyFat: 19 }, { weight: 159.8 }),
    {},
  );
  assert.deepEqual(
    changedMappedStats({ weight: 159.7, waist: 88 }, { weight: 159.8 }),
    { weight: 159.8 },
  );
});

test('legacy body_fat requests one normalization write, then becomes idempotent', () => {
  assert.deepEqual(
    changedMappedStats(
      { weight: 73.1, body_fat: 17.2, waist: 88 },
      { weight: 73.1, bodyFat: 17.2 },
    ),
    { bodyFat: 17.2 },
  );
  assert.deepEqual(
    changedMappedStats(
      { weight: 73.1, bodyFat: 17.2, waist: 88 },
      { weight: 73.1, bodyFat: 17.2 },
    ),
    {},
  );
});

test('newest weight is selected by date, not by source priority', () => {
  const newest = newestWeightMeasurement([
    observation('2026-08-16', 'withings', { body_fat_pct: 18 }),
    observation('2026-08-14', 'withings', { weight_kg: 73 }),
    observation('2026-08-15', 'withings', { weight_kg: 72.5 }),
  ]);
  assert.equal(newest.date, '2026-08-15');
  assert.equal(newest.metrics.weight_kg, 72.5);
});

test('multiple unselected sources produce no body-stat writes', async () => {
  const settings = {
    ntBodySyncEnabled: store(true), ntBodySource: store(''), ntBodyLastSyncAt: store(null),
    ntFederationEnabled: store(true),
    weightUnit: store('kg'), currentWeightKg: store(null),
  };
  let rangeCalls = 0;
  const api = {
    async getNtBodyMeasurements() {
      return { measurements: [
        observation('2026-08-14', 'a', { weight_kg: 72 }),
        observation('2026-08-14', 'b', { weight_kg: 73 }),
      ] };
    },
    async getBodyStatsRange() { rangeCalls += 1; return []; },
    async saveBodyStats() { throw new Error('must not write'); },
  };
  const result = await syncNtBodyMeasurements({ api, settings, now: Date.parse('2026-09-26T12:00:00Z') });
  assert.equal(result.status, 'source-selection-required');
  assert.deepEqual(result.sources, ['a', 'b']);
  assert.equal(rangeCalls, 0);
  assert.equal(settings.ntBodyLastSyncAt.get(), null, 'unsafe source ambiguity is not a successful sync');
});

test('automatic sync is default-off and does not request NutriTrace body data', async () => {
  const settings = {
    ntBodySyncEnabled: store(false), ntBodySource: store(''), ntBodyLastSyncAt: store(null),
    ntFederationEnabled: store(true), weightUnit: store('kg'), currentWeightKg: store(null),
  };
  let requests = 0;
  const result = await syncNtBodyMeasurements({
    settings,
    api: { async getNtBodyMeasurements() { requests += 1; return { measurements: [] }; } },
    now: Date.parse('2026-09-26T12:00:00Z'),
  });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(requests, 0);
});

test('automatic sync runs once when stale, records writes=0 success, and throttles for six hours', async () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const settings = {
    ntBodySyncEnabled: store(true), ntBodySource: store('withings'), ntBodyLastSyncAt: store(now - BODY_SYNC_INTERVAL_MS - 1),
    ntFederationEnabled: store(true), weightUnit: store('kg'), currentWeightKg: store(null),
  };
  let requests = 0;
  const api = {
    async getNtBodyMeasurements() {
      requests += 1;
      return { measurements: [observation('2026-08-15', 'withings', { weight_kg: 73.1 })] };
    },
    async getBodyStatsRange() { return [{ date: '2026-08-15', stats: { weight: 73.1 } }]; },
    async saveBodyStats() { throw new Error('writes=0 path must not write'); },
  };
  const first = await syncNtBodyMeasurements({ settings, api, now });
  assert.equal(first.status, 'ok');
  assert.equal(first.writes, 0);
  assert.equal(first.currentWeightKg, 73.1);
  assert.equal(settings.ntBodyLastSyncAt.get(), now);

  const second = await syncNtBodyMeasurements({ settings, api, now: now + 1000 });
  assert.equal(second.status, 'throttled');
  assert.equal(requests, 1);
});

test('manual sync bypasses the six-hour throttle even when auto-sync is off', async () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const settings = {
    ntBodySyncEnabled: store(false), ntBodySource: store('withings'), ntBodyLastSyncAt: store(now),
    ntFederationEnabled: store(true), weightUnit: store('kg'), currentWeightKg: store(null),
  };
  let requests = 0;
  const api = {
    async getNtBodyMeasurements() {
      requests += 1;
      return { measurements: [observation('2026-08-15', 'withings', { weight_kg: 73.1 })] };
    },
    async getBodyStatsRange() { return [{ date: '2026-08-15', stats: { weight: 73.1 } }]; },
  };
  const result = await syncNtBodyMeasurements({ manual: true, settings, api, now: now + 1000 });
  assert.equal(result.status, 'ok');
  assert.equal(result.writes, 0);
  assert.equal(requests, 1);
});

test('simultaneous lifecycle sync calls share one in-flight operation', async () => {
  const settings = {
    ntBodySyncEnabled: store(true), ntBodySource: store('withings'), ntBodyLastSyncAt: store(null),
    ntFederationEnabled: store(true), weightUnit: store('kg'), currentWeightKg: store(null),
  };
  let requests = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const api = {
    async getNtBodyMeasurements() {
      requests += 1;
      await gate;
      return { measurements: [observation('2026-08-15', 'withings', { weight_kg: 73.1 })] };
    },
    async getBodyStatsRange() { return [{ date: '2026-08-15', stats: { weight: 73.1 } }]; },
  };
  const first = syncNtBodyMeasurements({ settings, api, now: Date.parse('2026-09-26T12:00:00Z') });
  const second = syncNtBodyMeasurements({ settings, api, now: Date.parse('2026-09-26T12:00:01Z') });
  assert.strictEqual(second, first);
  release();
  await first;
  assert.equal(requests, 1);
});

test('selected source maps display units, preserves manual stats, updates currentWeightKg, and is idempotent', async () => {
  const settings = {
    ntBodySyncEnabled: store(true), ntBodySource: store('withings'), ntBodyLastSyncAt: store(null),
    ntFederationEnabled: store(true),
    weightUnit: store('lbs'), currentWeightKg: store(null),
  };
  const writes = [];
  const api = {
    async getNtBodyMeasurements(start, end, source) {
      assert.equal(source, 'withings');
      assert.equal(end, '2026-09-26');
      assert.equal(start, '2026-06-28');
      return { measurements: [observation('2026-08-14', 'withings', { weight_kg: 72.5 })] };
    },
    async getBodyStatsRange() { return [{ date: '2026-08-14', stats: { waist: 88, weight: 159.7, bodyFat: 19 } }]; },
    async saveBodyStats(date, data) { writes.push({ date, data }); },
  };
  const result = await syncNtBodyMeasurements({ api, settings, manual: true, now: Date.parse('2026-09-26T12:00:00Z') });
  assert.equal(result.status, 'ok');
  assert.equal(result.writes, 1);
  assert.deepEqual(writes, [{ date: '2026-08-14', data: { stats: { weight: 159.84 } } }]);
  assert.equal(settings.currentWeightKg.get(), 72.5);

  settings.ntBodyLastSyncAt.set(null);
  const idempotentApi = { ...api, async getBodyStatsRange() { return [{ date: '2026-08-14', stats: { waist: 88, weight: 159.84, bodyFat: 19 } }]; } };
  const second = await syncNtBodyMeasurements({ api: idempotentApi, settings, manual: true, now: Date.parse('2026-09-26T12:00:00Z') });
  assert.equal(second.status, 'ok');
  assert.equal(second.writes, 0);
  assert.equal(writes.length, 1);
});
