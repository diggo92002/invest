/* Official TWSE daily data. No API key or third-party proxy. */
window.CashflowMarket = (() => {
  const endpoints = {
    yields: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
    prices: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    dividends: 'https://www.twse.com.tw/rwd/zh/ETF/etfDiv'
  };
  const cacheKey = 'cashflow-market-v1';
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
  async function json(url) {
    if (document.querySelector('meta[name="market-proxy"]')) {
      const upstream = new URL(url);
      const route = upstream.pathname.endsWith('BWIBBU_ALL') ? 'yields' : upstream.pathname.endsWith('STOCK_DAY_ALL') ? 'prices' : 'dividends';
      url = '/api/market/' + route + upstream.search;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {signal: controller.signal, cache: 'no-store', credentials: 'omit'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  function valid(record) {
    const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
    return record && Number.isFinite(record.yield) && record.yield >= 0 && record.yield <= 1
      && /^\d{4}-\d{2}-\d{2}$/.test(record.date) && date(record.date) === record.date && record.date <= today;
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
  async function update(codes) {
    const records = {};
    const results = await Promise.allSettled([json(endpoints.yields), json(endpoints.prices)]);
    if (results[0].status === 'fulfilled' && Array.isArray(results[0].value)) {
      for (const row of results[0].value) {
        if (!codes.includes(row.Code) || row.Code.startsWith('00')) continue;
        const record = {yield: number(row.DividendYield) / 100, date: date(row.Date), method: '證交所殖利率'};
        if (valid(record)) records[row.Code] = record;
      }
    }
    if (results[1].status === 'fulfilled' && Array.isArray(results[1].value)) {
      const prices = results[1].value.filter(row => codes.includes(row.Code) && row.Code.startsWith('00'));
      const dates = prices.map(row => date(row.Date)).filter(Boolean).sort();
      if (dates.length) {
        const end = dates[dates.length - 1];
        const startDate = new Date(end + 'T00:00:00Z');
        startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
        const start = startDate.toISOString().slice(0, 10);
        const query = new URLSearchParams({response: 'json', startDate: start.replace(/-/g, ''), endDate: end.replace(/-/g, ''), stkNo: ''});
        try {
          const dividends = await json(endpoints.dividends + '?' + query);
          const fields = dividends.fields || [];
          const codeIndex = fields.findIndex(field => /證券代號/.test(field));
          const dateIndex = fields.findIndex(field => /除息交易日/.test(field));
          const amountIndex = fields.findIndex(field => /收益分配金額/.test(field));
          if (dividends.stat !== 'OK' || !Array.isArray(dividends.data) || [codeIndex, dateIndex, amountIndex].some(index => index < 0)) throw new Error('Unexpected dividend data');
          for (const price of prices) {
            const priceDate = date(price.Date);
            const close = number(price.ClosingPrice);
            if (!priceDate || !(close > 0)) continue;
            const cutoff = new Date(priceDate + 'T00:00:00Z');
            cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
            const rows = dividends.data.filter(row => row[codeIndex] === price.Code && date(row[dateIndex]) > cutoff.toISOString().slice(0, 10) && date(row[dateIndex]) <= priceDate);
            // Missing distributions or amounts must not silently become a zero yield.
            if (!rows.length || rows.some(row => !Number.isFinite(number(row[amountIndex])))) continue;
            const annual = rows.reduce((sum, row) => sum + number(row[amountIndex]), 0);
            const record = {yield: annual / close, date: priceDate, method: '近一年除息金額／收盤價'};
            if (valid(record)) records[price.Code] = record;
          }
        } catch { /* Keep individual stock updates if the ETF endpoint is unavailable. */ }
      }
    }
    return records;
  }
  return {cached, save, update};
})();
