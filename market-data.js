/* Official TWSE daily data. No API key or third-party proxy. */
window.CashflowMarket = (() => {
  // Single source of truth: server.mjs loads these same endpoints for its proxy.
  const endpoints = Object.freeze({
    stockDividends: 'https://api.finmindtrade.com/api/v4/data',
    yields: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
    prices: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    dividends: 'https://www.twse.com.tw/rwd/zh/ETF/etfDiv'
  });
  const cacheKey = 'cashflow-market-v1';
  const maxYield = 0.3; // Plausibility cap: anything higher is treated as a data error.
  const graceDays = 31; // Ex-dividend dates drift by days or weeks between years.
  const taipeiDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'});
  const isETF = code => code.startsWith('00');
  const cleanName = value => String(value ?? '').trim().slice(0, 40) || undefined;
  function number(value) {
    const text = String(value ?? '').replace(/,/g, '').trim();
    return /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  }
  function date(value) {
    const text = String(value ?? '').trim();
    const parts = text.match(/^(\d{3,4})[年/-](\d{1,2})[月/-](\d{1,2})日?$/)
      || text.match(/^(\d{3,4})(\d{2})(\d{2})$/);
    if (!parts) return null;
    const year = Number(parts[1]) + (parts[1].length === 3 ? 1911 : 0);
    const parsed = new Date(Date.UTC(year, Number(parts[2]) - 1, Number(parts[3])));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === Number(parts[2]) - 1
      && parsed.getUTCDate() === Number(parts[3]) ? parsed.toISOString().slice(0, 10) : null;
  }
  function shift(isoDate, years, days = 0) {
    const shifted = new Date(isoDate + 'T00:00:00Z');
    shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  }
  const compact = isoDate => isoDate.replace(/-/g, '');
  async function json(route, params) {
    const base = document.querySelector('meta[name="market-proxy"]') ? '/api/market/' + route : endpoints[route];
    const url = base + (params ? '?' + new URLSearchParams(params) : '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {signal: controller.signal, cache: 'no-store', credentials: 'omit'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  function valid(record) {
    return record && Number.isFinite(record.yield) && record.yield >= 0 && record.yield <= maxYield
      && /^\d{4}-\d{2}-\d{2}$/.test(record.date) && date(record.date) === record.date
      && record.date <= taipeiDate.format(new Date());
  }
  function cached() {
    try {
      const stored = JSON.parse(localStorage.getItem(cacheKey) || '{}');
      return Object.fromEntries(Object.entries(stored).filter(([, record]) => valid(record)));
    } catch { return {}; }
  }
  function save(records) {
    try { localStorage.setItem(cacheKey, JSON.stringify(records)); } catch { /* Private/storage-disabled mode. */ }
  }
  function etfRecords(dividends, prices, frequencies, records, warn) {
    const fields = dividends.fields || [];
    const codeIndex = fields.findIndex(field => /證券代號/.test(field));
    const dateIndex = fields.findIndex(field => /除息交易日/.test(field));
    const amountIndex = fields.findIndex(field => /收益分配金額/.test(field));
    if (dividends.stat !== 'OK' || !Array.isArray(dividends.data) || [codeIndex, dateIndex, amountIndex].some(index => index < 0)) throw new Error('Unexpected dividend data');
    const byCode = new Map();
    for (const row of dividends.data) {
      const list = byCode.get(row[codeIndex]) || [];
      list.push({exDate: date(row[dateIndex]), amount: number(row[amountIndex])});
      byCode.set(row[codeIndex], list);
    }
    for (const price of prices) {
      const code = price.Code;
      const priceDate = date(price.Date);
      const close = number(price.ClosingPrice);
      if (!priceDate || !(close > 0)) { warn(code + ' 收盤價資料異常'); continue; }
      const history = byCode.get(code) || [];
      if (history.some(row => !row.exDate)) { warn(code + ' 除息日期格式異常'); continue; }
      const expected = frequencies[code];
      const known = Number.isInteger(expected) && expected > 0;
      // With a known frequency, look slightly past one year and keep only the latest N
      // distributions, so drifting ex-dates neither add a fifth quarter nor drop one.
      const from = shift(priceDate, -1, known ? -graceDays : 0);
      const rows = history.filter(row => row.exDate > from && row.exDate <= priceDate)
        .sort((a, b) => b.exDate.localeCompare(a.exDate));
      const used = known ? rows.slice(0, expected) : rows;
      if (!used.length) { warn(code + ' 近一年無配息紀錄'); continue; }
      if (known && used.length < expected) { warn(code + ' 近一年僅 ' + used.length + '/' + expected + ' 次配息紀錄（可能上市未滿一年）'); continue; }
      // Missing distributions or amounts must not silently become a zero yield.
      if (used.some(row => !Number.isFinite(row.amount))) { warn(code + ' 配息金額缺漏'); continue; }
      const annual = used.reduce((sum, row) => sum + row.amount, 0);
      const record = {yield: annual / close, date: priceDate, name: cleanName(price.Name),
        method: known ? '最近 ' + expected + ' 次除息金額／收盤價' : '近一年除息金額／收盤價（配息頻率未知）'};
      if (valid(record)) records[code] = record;
      else warn(code + ' 計算結果超出合理範圍，未採用');
    }
  }
  /**
   * @param {string[]} codes
   * @param {Record<string, number>} frequencies expected distributions per year, keyed by code
   * @returns {Promise<{records: Record<string, object>, warnings: string[]}>}
   */
  async function update(codes, frequencies = {}) {
    const wanted = new Set(codes);
    const records = {};
    const warnings = [];
    const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
    const wantStocks = codes.some(code => !isETF(code));
    const wantETFs = codes.some(isETF);
    const notListed = (found, etf) => codes.filter(code => isETF(code) === etf && !found.has(code))
      .forEach(code => warn(code + ' 查無上市資料（可能為上櫃或代號錯誤）'));
    const [yields, prices] = await Promise.allSettled([json('yields'), json('prices')]);
    if (yields.status === 'fulfilled' && Array.isArray(yields.value)) {
      const found = new Set();
      for (const row of yields.value) {
        if (!wanted.has(row.Code) || isETF(row.Code)) continue;
        found.add(row.Code);
        const record = {yield: number(row.DividendYield) / 100, date: date(row.Date), name: cleanName(row.Name), method: '證交所殖利率'};
        if (valid(record)) records[row.Code] = record;
        else warn(row.Code + ' 無有效殖利率資料');
      }
      notListed(found, false);
    } else if (wantStocks) warn('個股殖利率資料取得失敗');
    if (prices.status === 'fulfilled' && Array.isArray(prices.value)) {
      const etfPrices = prices.value.filter(row => wanted.has(row.Code) && isETF(row.Code));
      notListed(new Set(etfPrices.map(row => row.Code)), true);
      const dates = etfPrices.map(row => date(row.Date)).filter(Boolean).sort();
      if (dates.length) {
        // Start from the earliest price date so every ETF's window is fully covered.
        const query = {response: 'json', startDate: compact(shift(dates[0], -1, -graceDays)), endDate: compact(dates[dates.length - 1]), stkNo: ''};
        try {
          etfRecords(await json('dividends', query), etfPrices, frequencies, records, warn);
        } catch { warn('ETF 配息資料取得失敗'); }
      }
    } else if (wantETFs) warn('ETF 收盤價資料取得失敗');
    return {records, warnings};
  }
  async function lookup(code) {
    const today=taipeiDate.format(new Date());
    const {records,warnings}=await update([code]);
    const record=records[code];
    if(!record) throw new Error(warnings.join('；')||'查無殖利率資料');
    let payments=[];
    if(isETF(code)) {
      const data=await json('dividends',{response:'json',startDate:compact(shift(today,-2)),endDate:compact(today),stkNo:''});
      const fields=data.fields||[], ci=fields.findIndex(f=>/證券代號/.test(f)), pi=fields.findIndex(f=>/收益分配發放日/.test(f)), ai=fields.findIndex(f=>/收益分配金額/.test(f));
      if(data.stat!=='OK'||!Array.isArray(data.data)||[ci,pi,ai].some(i=>i<0)) throw new Error('配息月份資料格式異常');
      payments=data.data.filter(r=>r[ci]===code&&number(r[ai])>0).map(r=>date(r[pi]));
    } else {
      const data=await json('stockDividends',{dataset:'TaiwanStockDividend',data_id:code,start_date:shift(today,-2)});
      if(data.status!==200||!Array.isArray(data.data)) {
        const detail=String(data.msg||data.message||'回傳資料格式不符').replace(/<[^>]*>/g,'').slice(0,180);
        throw new Error('個股配息資料來源 FinMind 回覆：'+detail+(data.status?'（狀態 '+data.status+'）':''));
      }
      payments=data.data.filter(r=>r.stock_id===code&&Number(r.CashEarningsDistribution)+Number(r.CashStatutorySurplus)>0).map(r=>date(r.CashDividendPaymentDate));
    }
    payments=payments.filter(d=>d&&d<=today).sort();
    const latest=payments[payments.length-1];
    if(!latest||latest<=shift(today,-1)) throw new Error('近一年查無現金股利發放日，無法判定配息月份');
    const months=[...new Set(payments.filter(d=>d>shift(latest,-1)).map(d=>Number(d.slice(5,7))))].sort((a,b)=>a-b);
    return {...record,months};
  }
  return {endpoints, cached, save, update, lookup};
})();
