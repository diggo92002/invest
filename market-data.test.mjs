import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('./market-data.js', import.meta.url), 'utf8');
function setup(handler, saved = '{}', proxy = false) {
  const sandbox = {
    window: {}, document: {querySelector: () => proxy ? {} : null},
    localStorage: {getItem: () => saved, setItem: () => {}},
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async url => ({ok: true, json: async () => handler(String(url))})
  };
  vm.runInNewContext(source, sandbox);
  return sandbox.window.CashflowMarket;
}
const fixtures = url => {
  if (url.includes('BWIBBU_ALL')) return [
    {Code: '1101', DividendYield: '2.89', Date: '1151111'},
    {Code: '1216', DividendYield: '-', Date: '1151111'}
  ];
  if (url.includes('STOCK_DAY_ALL')) return [{Code: '0056', ClosingPrice: '40.00', Date: '1151111'}];
  return {stat: 'OK', fields: ['證券代號', '除息交易日', '收益分配金額 (每1受益權益單位)'], data: [
    ['0056', '114年11月11日', '10'], // Outside the trailing window.
    ['0056', '115年01月15日', '1.0'],
    ['0056', '115年04月15日', '1.0'],
    ['0056', '115年07月15日', '1.0'],
    ['0056', '115年10月15日', '1.0'],
    ['0056', '115年12月15日', '99'] // Future announcements are excluded.
  ]};
};
test('individual yield and trailing ETF yield use official fields and ROC dates', async () => {
  const records = await setup(fixtures).update(['1101', '1216', '0056']);
  assert.ok(Math.abs(records['1101'].yield - .0289) < 1e-12);
  assert.equal(records['1101'].date, '2026-11-11');
  assert.equal(records['0056'].yield, .1);
  assert.equal(records['0056'].date, '2026-11-11');
  assert.equal(records['1216'], undefined);
});
test('ETF failure preserves successful individual updates', async () => {
  const records = await setup(url => {
    if (url.includes('etfDiv')) throw new Error('Network error');
    return fixtures(url);
  }).update(['1101', '0056']);
  assert.ok(Math.abs(records['1101'].yield - .0289) < 1e-12);
  assert.equal(records['0056'], undefined);
});
test('missing ETF distribution amounts are not silently treated as zero', async () => {
  const records = await setup(url => {
    const data = fixtures(url);
    if (data.data) data.data[1][2] = '--';
    return data;
  }).update(['0056']);
  assert.equal(records['0056'], undefined);
});
test('complete network failure returns no fabricated updates', async () => {
  const records = await setup(() => {throw new Error('Offline');}).update(['1101', '0056']);
  assert.equal(Object.keys(records).length, 0);
});
test('cache rejects invalid yield and date values', () => {
  const records = setup(fixtures, JSON.stringify({
    '1101': {yield: .0289, date: '2026-11-11'},
    '1216': {yield: null, date: '2026-11-11'},
    '0056': {yield: .1, date: '2026-02-30'}
  })).cached();
  assert.deepEqual(Object.keys(records), ['1101']);
});
test('local service uses fixed same-origin proxy routes', async () => {
  const urls = [];
  await setup(url => {urls.push(url); return [];}, '{}', true).update(['1101']);
  assert.deepEqual(urls.sort(), ['/api/market/prices', '/api/market/yields']);
});
