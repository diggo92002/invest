import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root = new URL('./', import.meta.url);
const upstreams = {
  yields: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  prices: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  dividends: 'https://www.twse.com.tw/rwd/zh/ETF/etfDiv'
};
const cache = new Map();
const pending = new Map();
async function market(route, query) {
  const url = new URL(upstreams[route]);
  if (route === 'dividends') {
    const start = query.get('startDate'), end = query.get('endDate');
    if (!/^\d{8}$/.test(start || '') || !/^\d{8}$/.test(end || '') || start > end) throw new Error('Invalid dates');
    url.search = new URLSearchParams({response: 'json', stkNo: '', startDate: start, endDate: end});
  }
  const key = url.href;
  const saved = cache.get(key);
  if (saved && Date.now() - saved.time < 3600000) return saved.body;
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    const response = await fetch(url, {signal: AbortSignal.timeout(15000), headers: {Accept: 'application/json'}});
    if (!response.ok) throw new Error('Upstream HTTP ' + response.status);
    const data = await response.json();
    if (route === 'dividends' ? data.stat !== 'OK' || !Array.isArray(data.data) : !Array.isArray(data)) throw new Error('Unexpected upstream data');
    const body = JSON.stringify(data);
    if (cache.size >= 50) cache.delete(cache.keys().next().value);
    cache.set(key, {time: Date.now(), body});
    return body;
  })();
  pending.set(key, request);
  try { return await request; } finally { pending.delete(key); }
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
  const url = new URL(request.url, 'http://localhost');
  const route = url.pathname.replace('/api/market/', '');
  try {
    if (url.pathname.startsWith('/api/market/') && Object.hasOwn(upstreams, route)) {
      const body = await market(route, url.searchParams);
      response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      response.end(body);
      return;
    }
    const filename = {'/': 'index.html', '/index.html': 'index.html', '/market-data.js': 'market-data.js'}[url.pathname];
    if (!filename) { response.writeHead(404); response.end(); return; }
    let body = await readFile(new URL(filename, root), 'utf8');
    if (filename === 'index.html') body = body.replace('<head>', '<head>\n  <meta name="market-proxy" content="same-origin">');
    response.writeHead(200, {'Content-Type': filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'});
    response.end(body);
  } catch {
    response.writeHead(502, {'Content-Type': 'application/json; charset=utf-8'});
    response.end(JSON.stringify({error: '無法取得證交所資料，請稍後重試。'}));
  }
});
const port = Number(process.env.PORT || 8787);
server.listen(port, '127.0.0.1', () => console.log(`現金流配息計畫：http://127.0.0.1:${port} (${fileURLToPath(root)})`));
