import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('./market-data.js', import.meta.url), 'utf8');
function setup(handler, saved = '{}') {
  const sandbox = {
    window: {},
    localStorage: {getItem: () => saved, setItem: () => {}},
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async url => ({ok: true, json: async () => handler(String(url)), text: async () => handler(String(url))})
  };
  vm.runInNewContext(source, sandbox);
  return sandbox.window.CashflowMarket;
}
const fields = ['證券代號', '除息交易日', '收益分配金額 (每1受益權益單位)'];
// Mirrors www.twse.com.tw/rwd STOCK_DAY_ALL (CSV) and BWIBBU_d (JSON) formats.
const priceCSV = rows => '日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數\n'
  + rows.map(r => [r.Date, r.Code, r.Name ?? '', '1', '1', '1', '1', '1', r.ClosingPrice, '0', '1'].map(v => '"' + v + '"').join(',')).join('\n') + '\n';
const yieldJSON = (date, rows) => ({stat: 'OK', date, fields: ['證券代號', '證券名稱', '收盤價', '殖利率(%)', '股利年度', '本益比', '股價淨值比', '財報年/季'],
  data: rows.map(r => [r.Code, r.Name ?? '', '10', r.DividendYield, '114', '10', '1', '115/3'])});
const fixtures = url => {
  if (url.includes('BWIBBU')) return yieldJSON('20261111', [
    {Code: '1101', DividendYield: '2.89'},
    {Code: '1216', DividendYield: '-'}
  ]);
  if (url.includes('STOCK_DAY_ALL')) return priceCSV([{Code: '0056', ClosingPrice: '40.00', Date: '1151111'}]);
  return {stat: 'OK', fields, data: [
    ['0056', '114年11月11日', '10'], // Outside the trailing window.
    ['0056', '115年01月15日', '1.0'],
    ['0056', '115年04月15日', '1.0'],
    ['0056', '115年07月15日', '1.0'],
    ['0056', '115年10月15日', '1.0'],
    ['0056', '115年12月15日', '99'] // Future announcements are excluded.
  ]};
};
const withDividends = rows => url => url.includes('etfDiv') ? {stat: 'OK', fields, data: rows} : fixtures(url);

test('automatic stock lookup uses payment months rather than ex-dividend months', async () => {
  const market=setup(url=>url.includes('finmindtrade')?{status:200,data:[
    {stock_id:'1101',CashEarningsDistribution:1,CashStatutorySurplus:0,CashDividendPaymentDate:'2026-08-15',CashExDividendTradingDate:'2026-07-15'},
    {stock_id:'1101',CashEarningsDistribution:1,CashStatutorySurplus:0,CashDividendPaymentDate:'2025-08-15'},
    {stock_id:'1101',CashEarningsDistribution:1,CashStatutorySurplus:0,CashDividendPaymentDate:'2027-01-15'}
  ]}:fixtures(url));
  const record=await market.lookup('1101');
  assert.deepEqual(Array.from(record.months),[8]);
  assert.ok(Math.abs(record.yield-.0289)<1e-12);
});

test('automatic lookup rejects missing payment dates instead of inventing months', async () => {
  const market=setup(url=>url.includes('finmindtrade')?{status:200,data:[]}:fixtures(url));
  await assert.rejects(market.lookup('1101'),/現金股利發放日/);
});

test('individual yield and trailing ETF yield use official fields and ROC dates', async () => {
  const {records, warnings} = await setup(fixtures).update(['1101', '1216', '0056']);
  assert.ok(Math.abs(records['1101'].yield - .0289) < 1e-12);
  assert.equal(records['1101'].date, '2026-11-11');
  assert.equal(records['0056'].yield, .1);
  assert.equal(records['0056'].date, '2026-11-11');
  assert.equal(records['1216'], undefined);
  assert.ok(warnings.some(w => w.includes('1216')));
});
test('known frequency keeps only the latest N distributions when ex-dates drift', async () => {
  // Last year's November ex-date falls one day inside the strict one-year window: 5 quarters.
  const {records} = await setup(withDividends([
    ['0056', '114年11月12日', '1.0'], ['0056', '115年01月15日', '1.0'], ['0056', '115年04月15日', '1.0'],
    ['0056', '115年07月15日', '1.0'], ['0056', '115年10月15日', '1.0']
  ])).update(['0056'], {'0056': 4});
  assert.equal(records['0056'].yield, .1);
});
test('known frequency still finds a quarter that drifted just past one year', async () => {
  // Only 3 quarters lie strictly inside one year; the 4th is a few days earlier.
  const {records} = await setup(withDividends([
    ['0056', '114年11月05日', '1.0'], ['0056', '115年02月15日', '1.0'],
    ['0056', '115年05月15日', '1.0'], ['0056', '115年08月15日', '1.0']
  ])).update(['0056'], {'0056': 4});
  assert.equal(records['0056'].yield, .1);
});
test('ETF with less than a year of distributions is not annualised', async () => {
  const {records, warnings} = await setup(withDividends([
    ['0056', '115年07月15日', '1.0'], ['0056', '115年10月15日', '1.0']
  ])).update(['0056'], {'0056': 4});
  assert.equal(records['0056'], undefined);
  assert.ok(warnings.some(w => w.includes('2/4')));
});
test('implausibly high yields are rejected', async () => {
  const {records, warnings} = await setup(withDividends([
    ['0056', '115年01月15日', '5'], ['0056', '115年04月15日', '5'],
    ['0056', '115年07月15日', '5'], ['0056', '115年10月15日', '5']
  ])).update(['0056'], {'0056': 4});
  assert.equal(records['0056'], undefined);
  assert.ok(warnings.some(w => w.includes('合理範圍')));
});
test('dividend query starts early enough for the earliest ETF price date', async () => {
  const urls = [];
  await setup(url => {
    urls.push(url);
    if (url.includes('STOCK_DAY_ALL')) return priceCSV([
      {Code: '0056', ClosingPrice: '40', Date: '1151111'},
      {Code: '00878', ClosingPrice: '20', Date: '1151105'}
    ]);
    return fixtures(url);
  }).update(['0056', '00878'], {'0056': 4, '00878': 4});
  const query = new URL(urls.find(url => url.includes('etfDiv'))).searchParams;
  assert.equal(query.get('startDate'), '20251005');
  assert.equal(query.get('endDate'), '20261111');
});
test('ETF failure preserves successful individual updates and is reported', async () => {
  const {records, warnings} = await setup(url => {
    if (url.includes('etfDiv')) throw new Error('Network error');
    return fixtures(url);
  }).update(['1101', '0056']);
  assert.ok(Math.abs(records['1101'].yield - .0289) < 1e-12);
  assert.equal(records['0056'], undefined);
  assert.ok(warnings.includes('ETF 配息資料取得失敗'));
});
test('missing ETF distribution amounts are not silently treated as zero', async () => {
  const {records} = await setup(url => {
    const data = fixtures(url);
    if (data.data) data.data[1][2] = '--';
    return data;
  }).update(['0056']);
  assert.equal(records['0056'], undefined);
});
test('complete network failure returns no fabricated updates', async () => {
  const {records, warnings} = await setup(() => {throw new Error('Offline');}).update(['1101', '0056']);
  assert.equal(Object.keys(records).length, 0);
  assert.equal(warnings.length, 2);
});
test('cache rejects invalid yield and date values', () => {
  const records = setup(fixtures, JSON.stringify({
    '1101': {yield: .0289, date: '2026-11-11'},
    '1216': {yield: null, date: '2026-11-11'},
    '0056': {yield: .1, date: '2026-02-30'},
    '00919': {yield: .5, date: '2026-11-11'}
  })).cached();
  assert.deepEqual(Object.keys(records), ['1101']);
});
test('ETF dividends accept the newer {status:"ok"} TWSE response', async () => {
  const {records} = await setup(url => {
    const data = fixtures(url);
    if (url.includes('etfDiv')) { delete data.stat; data.status = 'ok'; }
    return data;
  }).update(['0056'], {'0056': 4});
  assert.equal(records['0056'].yield, .1);
});
test('price CSV handles CRLF line endings and quoted commas', async () => {
  const csv = '日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數\r\n'
    + '"1151111","0056","元大高股息","1","1","1","1","1","1,040.00","0","1"\r\n';
  const {records} = await setup(url => url.includes('STOCK_DAY_ALL') ? csv : fixtures(url)).update(['0056'], {'0056': 4});
  assert.ok(Math.abs(records['0056'].yield - 4 / 1040) < 1e-12);
  assert.equal(records['0056'].name, '元大高股息');
});
test('static page calls CORS-enabled www.twse.com.tw endpoints, not openapi', async () => {
  const urls = [];
  await setup(url => {urls.push(url); return fixtures(url);}).update(['1101', '0056'], {'0056': 4});
  assert.ok(urls.length >= 3);
  assert.ok(urls.every(url => !url.includes('openapi.twse.com.tw')));
  assert.ok(urls.some(url => url.startsWith('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL')));
  assert.ok(urls.some(url => url.startsWith('https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d')));
});
test('records carry official names and unknown codes are reported', async () => {
  const {records, warnings} = await setup(url => {
    if (url.includes('BWIBBU')) return yieldJSON('20261111', [{Code: '2884', Name: '玉山金', DividendYield: '4.10'}]);
    if (url.includes('STOCK_DAY_ALL')) return priceCSV([{Code: '0056', Name: '元大高股息', ClosingPrice: '40.00', Date: '1151111'}]);
    return fixtures(url);
  }).update(['2884', '9999', '0056', '00999'], {'0056': 4});
  assert.equal(records['2884'].name, '玉山金');
  assert.equal(records['0056'].name, '元大高股息');
  assert.ok(warnings.includes('9999 查無上市資料（可能為上櫃或代號錯誤）'));
  assert.ok(warnings.includes('00999 查無上市資料（可能為上櫃或代號錯誤）'));
});
