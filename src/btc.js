// Bitcoin price and chart history from CoinGecko (free, no API key).
//
// Two caches: the spot price (shared by everyone) and one price history per chart interval. Intervals are
// whitelisted, so the history cache holds at most INTERVALS.length entries and the upstream URL is never built
// from user input. Both caches are stale-while-revalidate: with cached data a screen request answers immediately
// and refreshes in the background; only an empty cache waits, and then for at most TIMEOUT_MS.

const API = 'https://api.coingecko.com/api/v3';
const PRICE_URL = `${API}/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true`;
const INTERVALS = [1, 7, 30, 90, 365];
const DEFAULT_INTERVAL = 30;
const TIMEOUT_MS = 5000; // TRMNL gives the markup endpoint 10 s in total
const PRICE_TTL_MS = 2 * 60 * 1000;
const HISTORY_TTL_MS = { 1: 10 * 60 * 1000, 7: 30 * 60 * 1000, 30: 60 * 60 * 1000, 90: 60 * 60 * 1000, 365: 60 * 60 * 1000 };

// Returns the interval as a number if it is one we offer, else null.
function normalizeInterval(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(String(v).trim());
  return INTERVALS.includes(n) ? n : null;
}

function historyUrl(days) {
  const d = normalizeInterval(days);
  if (d === null) throw new Error('unsupported interval');
  return `${API}/coins/bitcoin/market_chart?vs_currency=usd&days=${d}${d === 1 ? '' : '&interval=daily'}`;
}

function parsePrice(payload) {
  const b = payload && payload.bitcoin;
  const price = Number(b && b.usd);
  if (!Number.isFinite(price) || price <= 0) throw new Error('CoinGecko price response has no bitcoin.usd');
  const change = Number(b.usd_24h_change);
  return { price, change24h: Number.isFinite(change) ? change : null };
}

function parseHistory(payload) {
  const rows = payload && Array.isArray(payload.prices) ? payload.prices : null;
  if (!rows) throw new Error('CoinGecko history response has no prices');
  const points = rows
    .filter((r) => Array.isArray(r) && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1])) && Number(r[1]) > 0)
    .map((r) => ({ t: Number(r[0]), price: Number(r[1]) }))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) throw new Error('CoinGecko history response has too few points');
  return points;
}

async function defaultFetchJson(url, { timeoutMs }) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'TRMNL-Bitcoin-Price-Plugin/1.1' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  return res.json();
}

// Rejects after ms, so even a fetcher that ignores the abort signal cannot hold a request.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// fetchJson(url, { timeoutMs }) is injectable for tests; now() too.
function createBtc({ fetchJson = defaultFetchJson, now = Date.now, timeoutMs = TIMEOUT_MS, log = console } = {}) {
  const entries = new Map(); // key -> { data, at, inflight }

  function refresh(key, url, parse) {
    let e = entries.get(key);
    if (!e) entries.set(key, (e = { data: null, at: 0, inflight: null }));
    if (!e.inflight) {
      e.inflight = withTimeout(Promise.resolve().then(() => fetchJson(url, { timeoutMs })), timeoutMs)
        .then((payload) => {
          e.data = parse(payload);
          e.at = now();
          return e.data;
        })
        .catch((err) => {
          log.error(`CoinGecko ${key} fetch failed: ${err.message}`);
          return e.data;
        })
        .finally(() => {
          e.inflight = null;
        });
    }
    return e.inflight;
  }

  async function get(key, url, parse, ttl) {
    const e = entries.get(key);
    if (!e || !e.data) return refresh(key, url, parse);
    if (now() - e.at >= ttl) refresh(key, url, parse).catch(() => {});
    return e.data;
  }

  const getPrice = () => get('price', PRICE_URL, parsePrice, PRICE_TTL_MS);

  function getHistory(days) {
    const d = normalizeInterval(days) ?? DEFAULT_INTERVAL;
    return get(`history:${d}`, historyUrl(d), parseHistory, HISTORY_TTL_MS[d]);
  }

  // Everything a screen needs. price is null when we have never reached CoinGecko.
  async function getData(days) {
    const d = normalizeInterval(days) ?? DEFAULT_INTERVAL;
    const [price, history] = await Promise.all([getPrice(), getHistory(d)]);
    const priceEntry = entries.get('price');
    return {
      price: price ? price.price : null,
      change24h: price ? price.change24h : null,
      history: history ? history.map((p) => p.price) : [],
      days: d,
      updatedAt: priceEntry && priceEntry.at ? new Date(priceEntry.at) : null,
    };
  }

  // Warm the price and the given intervals now (retrying until the price works) and keep them fresh.
  function startBackgroundRefresh(intervalsInUse = () => [DEFAULT_INTERVAL]) {
    const warmAll = () => {
      const ds = [...new Set([DEFAULT_INTERVAL, ...intervalsInUse()].map(normalizeInterval).filter((d) => d !== null))];
      return Promise.all([refresh('price', PRICE_URL, parsePrice), ...ds.map((d) => getHistory(d))]);
    };
    let delay = 5000;
    const warm = async () => {
      await warmAll();
      if (!entries.get('price')?.data) {
        setTimeout(warm, delay).unref();
        delay = Math.min(delay * 2, 5 * 60 * 1000);
      }
    };
    warm();
    // getHistory only refetches when stale, so a frequent tick keeps every interval within its TTL.
    setInterval(() => warmAll().catch(() => {}), PRICE_TTL_MS).unref();
  }

  function cacheAgeMs() {
    const e = entries.get('price');
    return e && e.data ? now() - e.at : null;
  }

  return { getData, getPrice, getHistory, startBackgroundRefresh, cacheAgeMs, _entries: entries };
}

module.exports = {
  createBtc,
  parsePrice,
  parseHistory,
  normalizeInterval,
  historyUrl,
  withTimeout,
  INTERVALS,
  DEFAULT_INTERVAL,
  PRICE_URL,
};
