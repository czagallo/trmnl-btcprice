// No test here touches the network: CoinGecko is replaced by an injected fetcher and the store writes to a temp dir.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBtc, parsePrice, parseHistory, normalizeInterval, historyUrl, PRICE_URL } = require('../src/btc');
const { renderAll, esc, formatPrice, formatPct, rangeStats } = require('../src/markup');
const { createStore } = require('../src/store');
const { createApp } = require('../server');

const PRICE = { bitcoin: { usd: 84123.45, usd_24h_change: -2.345 } };
const HIST = { prices: [[3, 90000], [1, 80000], [2, 85000], [4, 'x']] };
const LAYOUT_KEYS = ['markup', 'markup_half_horizontal', 'markup_half_vertical', 'markup_quadrant'];
const VIEW_CLASS = { markup: 'view--full', markup_half_horizontal: 'view--half_horizontal', markup_half_vertical: 'view--half_vertical', markup_quadrant: 'view--quadrant' };
const quiet = { error() {} };

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'btc-test-')), 'data', 'connections.json');
}

// Fetcher that answers from a table and records every URL it was asked for.
function fakeFetcher(table) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const v = typeof table === 'function' ? table(url) : url === PRICE_URL ? PRICE : HIST;
    if (v instanceof Error) throw v;
    return v;
  };
  fn.calls = calls;
  return fn;
}

// --- parsing --------------------------------------------------------------------------------

describe('parsing', () => {
  test('parsePrice reads price and 24h change', () => {
    assert.deepEqual(parsePrice(PRICE), { price: 84123.45, change24h: -2.345 });
    assert.equal(parsePrice({ bitcoin: { usd: 1 } }).change24h, null);
  });

  test('parsePrice rejects missing or zero prices', () => {
    for (const p of [null, {}, { bitcoin: {} }, { bitcoin: { usd: 0 } }, { bitcoin: { usd: 'abc' } }]) assert.throws(() => parsePrice(p));
  });

  test('parseHistory sorts oldest first and drops invalid rows', () => {
    assert.deepEqual(parseHistory(HIST).map((p) => p.price), [80000, 85000, 90000]);
    assert.throws(() => parseHistory({ prices: [[1, 2]] }));
    assert.throws(() => parseHistory({}));
  });
});

// --- interval validation -----------------------------------------------------------------------

test('normalizeInterval only accepts the offered ranges', () => {
  for (const ok of [1, 7, 30, 90, 365, '7', ' 90 ']) assert.notEqual(normalizeInterval(ok), null, String(ok));
  for (const bad of [0, 2, 31, 366, '-1', '30; drop', '1e3', '', null, undefined, ['30'], {}]) assert.equal(normalizeInterval(bad), null, String(bad));
  assert.throws(() => historyUrl(12));
  assert.match(historyUrl(1), /days=1$/);
  assert.match(historyUrl(365), /days=365&interval=daily$/);
});

// --- cache and timeouts ------------------------------------------------------------------------

describe('cache', () => {
  test('first call fetches, later calls within the TTL are served from cache', async () => {
    const f = fakeFetcher();
    const btc = createBtc({ fetchJson: f, log: quiet });
    const a = await btc.getData(30);
    assert.equal(a.price, 84123.45);
    assert.deepEqual(a.history, [80000, 85000, 90000]);
    assert.equal(a.days, 30);
    await btc.getData(30);
    assert.equal(f.calls.length, 2);
  });

  test('unknown interval falls back to the default and never reaches the URL', async () => {
    const f = fakeFetcher();
    const btc = createBtc({ fetchJson: f, log: quiet });
    const d = await btc.getData('999');
    assert.equal(d.days, 30);
    assert.ok(f.calls.every((u) => !u.includes('999')));
  });

  test('stale data is returned at once and refreshed in the background', async () => {
    let t = 0;
    let price = 100;
    const f = fakeFetcher((url) => (url === PRICE_URL ? { bitcoin: { usd: price } } : HIST));
    const btc = createBtc({ fetchJson: f, now: () => t, log: quiet });
    assert.equal((await btc.getData(30)).price, 100);
    price = 200;
    t = 10 * 60 * 1000; // past the price TTL
    assert.equal((await btc.getData(30)).price, 100, 'answers with the stale value');
    await new Promise((r) => setImmediate(r));
    assert.equal((await btc.getData(30)).price, 200, 'refreshed in the background');
  });

  test('a failed refresh keeps the last good data', async () => {
    let t = 0;
    let fail = false;
    const f = fakeFetcher((url) => (fail ? new Error('down') : url === PRICE_URL ? PRICE : HIST));
    const btc = createBtc({ fetchJson: f, now: () => t, log: quiet });
    await btc.getData(30);
    fail = true;
    t = 24 * 3600 * 1000;
    await btc.getData(30);
    await new Promise((r) => setImmediate(r));
    assert.equal((await btc.getData(30)).price, 84123.45);
  });

  test('an empty cache with a failing source returns price null', async () => {
    const btc = createBtc({ fetchJson: fakeFetcher(() => new Error('down')), log: quiet });
    const d = await btc.getData(30);
    assert.equal(d.price, null);
    assert.deepEqual(d.history, []);
  });

  test('a hanging fetch is cut off by the timeout', async () => {
    const btc = createBtc({ fetchJson: () => new Promise(() => {}), timeoutMs: 50, log: quiet });
    const started = Date.now();
    const d = await btc.getData(7);
    assert.ok(Date.now() - started < 1000);
    assert.equal(d.price, null);
  });

  test('concurrent requests share one upstream fetch', async () => {
    const f = fakeFetcher();
    const btc = createBtc({ fetchJson: f, log: quiet });
    await Promise.all([btc.getData(30), btc.getData(30), btc.getData(30)]);
    assert.equal(f.calls.length, 2);
  });
});

// --- store -------------------------------------------------------------------------------------

test('store persists across instances with mode 0600 and rolls back failed writes', () => {
  const file = tmpFile();
  const s1 = createStore(file);
  assert.ok(s1.update('user-1', { chartInterval: 7 }));
  assert.equal(createStore(file).get('user-1').chartInterval, 7);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  s1.delete('user-1');
  assert.equal(createStore(file).get('user-1'), null);

  const blocker = path.join(path.dirname(tmpFile()), 'not-a-dir');
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, '');
  const orig = console.error;
  console.error = () => {};
  try {
    const bad = createStore(path.join(blocker, 'connections.json'));
    assert.equal(bad.update('user-2', { chartInterval: 7 }), null);
    assert.equal(bad.get('user-2'), null);
  } finally {
    console.error = orig;
  }
});

// --- markup ------------------------------------------------------------------------------------

const DATA = { price: 84123.45, change24h: -2.345, history: [80000, 85000, 90000, 84000], days: 30, updatedAt: new Date() };

describe('markup', () => {
  for (const [name, data] of [['with data', DATA], ['unavailable', null], ['price 0', { ...DATA, price: 0 }], ['no history', { ...DATA, history: [] }]]) {
    test(`renderAll returns every layout, Liquid-safe and without hex colours (${name})`, () => {
      const out = renderAll(data, { baseUrl: 'https://x.example', timeZone: 'Europe/Vienna' });
      assert.deepEqual(Object.keys(out).sort(), [...LAYOUT_KEYS].sort());
      for (const k of LAYOUT_KEYS) {
        assert.match(out[k], new RegExp(VIEW_CLASS[k]));
        assert.match(out[k], /<\/div>\n<div class="title_bar">/, `${k}: title_bar must follow .layout`);
        assert.doesNotMatch(out[k], /\{\{|\{%/, `${k} contains Liquid delimiters`);
        assert.doesNotMatch(out[k], /#[0-9a-f]{3,6}\b/i, `${k} contains a hex colour`);
        assert.doesNotMatch(out[k], /\$0\.00/, `${k} shows a zero price`);
        assert.doesNotMatch(out[k], /font-size:\s*\d+px/, `${k} uses a fixed pixel font size`);
      }
    });
  }

  test('unavailable state is shown when there is no price', () => {
    for (const d of [null, { ...DATA, price: null }, { ...DATA, price: 0 }]) {
      const out = renderAll(d, { baseUrl: '' });
      for (const k of LAYOUT_KEYS) assert.match(out[k], /Bitcoin price unavailable/);
    }
    assert.doesNotMatch(renderAll(DATA, { baseUrl: '' }).markup, /unavailable/);
  });

  test('price, change and range are shown', () => {
    const out = renderAll(DATA, { baseUrl: '' });
    assert.match(out.markup, /\$84,123/);
    assert.match(out.markup, /−2\.35%/);
    assert.match(out.markup, /30d high/);
    assert.match(out.markup_quadrant, /hidden lg:flex/, 'quadrant shows the chart on TRMNL X');
    assert.match(out.markup, /lg:portrait:value--/, 'X portrait gets bigger type');
  });

  test('stale data is marked with its time', () => {
    const old = { ...DATA, updatedAt: new Date(Date.UTC(2026, 0, 1, 8, 5)) };
    assert.match(renderAll(old, { baseUrl: '', timeZone: 'UTC' }).markup, /as of 08:05/);
    assert.doesNotMatch(renderAll(DATA, { baseUrl: '' }).markup, /as of/);
  });

  test('instance names and base URL are escaped, including Liquid braces', () => {
    const out = renderAll(DATA, { baseUrl: '"><x', instance: '{{ evil }}<script>' });
    for (const k of LAYOUT_KEYS) assert.doesNotMatch(out[k], /<script>|"><x|\{\{/);
    assert.equal(esc(`<&"'>{}`), '&lt;&amp;&quot;&#39;&gt;&#123;&#125;');
  });

  test('formatting helpers', () => {
    assert.equal(formatPrice(84123.45), '$84,123');
    assert.equal(formatPrice(12.5), '$12.50');
    assert.equal(formatPct(1.234), '+1.23%');
    assert.deepEqual(rangeStats([100, 50, 150]), { high: 150, low: 50, change: 50 });
    assert.equal(rangeStats([1]), null);
  });

  test('invalid time zone falls back instead of throwing', () => {
    const old = { ...DATA, updatedAt: new Date(0) };
    assert.doesNotThrow(() => renderAll(old, { baseUrl: '', timeZone: 'Not/AZone' }));
  });
});

// --- HTTP --------------------------------------------------------------------------------------

describe('HTTP', () => {
  let server, base, store, fetcher;
  const UUID = 'abc-123';

  before(async () => {
    store = createStore(tmpFile());
    fetcher = fakeFetcher();
    const app = createApp({ store, btc: createBtc({ fetchJson: fetcher, log: quiet }) });
    await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server?.close());

  const form = (obj) => ({ method: 'POST', body: new URLSearchParams(obj), redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  test('save works without a prior install record and persists', async () => {
    const res = await fetch(`${base}/manage/save`, form({ uuid: UUID, interval: '7' }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/manage?uuid=${UUID}&saved=true`);
    assert.equal(store.get(UUID).chartInterval, 7);
    const page = await (await fetch(`${base}/manage?uuid=${UUID}&saved=true`)).text();
    assert.match(page, /Settings saved/);
    assert.match(page, /<option value="7" selected>/);
  });

  test('save rejects intervals that are not offered and stores nothing', async () => {
    const res = await fetch(`${base}/manage/save`, form({ uuid: 'other-user', interval: '12' }));
    assert.equal(res.status, 400);
    assert.equal(store.get('other-user'), null);
    assert.doesNotMatch(await res.text(), /Settings saved/);
  });

  test('invalid uuids are refused and never reflected', async () => {
    const evil = '"><script>alert(1)</script>';
    const r1 = await fetch(`${base}/manage?uuid=${encodeURIComponent(evil)}`);
    assert.equal(r1.status, 400);
    assert.doesNotMatch(await r1.text(), /<script>/);
    const r2 = await fetch(`${base}/manage/save`, form({ uuid: evil, interval: '7' }));
    assert.equal(r2.status, 400);
  });

  test('install webhook keeps only plugin_setting_id; uninstall deletes', async () => {
    const res = await fetch(`${base}/webhooks/install-success`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
      body: JSON.stringify({ user: { uuid: 'u-inst', plugin_setting_id: 4242, email: 'a@b.c', name: 'A' } }),
    });
    assert.equal(res.status, 200);
    const rec = store.get('u-inst');
    assert.equal(rec.plugin_setting_id, '4242');
    assert.deepEqual(Object.keys(rec).sort(), ['plugin_setting_id', 'updated_at']);
    assert.match(await (await fetch(`${base}/manage?uuid=u-inst`)).text(), /plugin_settings\/4242\/edit/);
    await fetch(`${base}/webhooks/uninstall`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: { uuid: 'u-inst' } }) });
    assert.equal(store.get('u-inst'), null);
  });

  test('/install does not echo the query back', async () => {
    const res = await fetch(`${base}/install?code=SECRETCODE`);
    assert.equal(res.status, 400);
    assert.doesNotMatch(await res.text(), /SECRETCODE/);
  });

  test('/markup uses the saved interval with a form-encoded body', async () => {
    const res = await fetch(`${base}/markup`, form({ user_uuid: UUID, 'trmnl[plugin_settings][instance_name]': 'My BTC' }));
    const json = await res.json();
    for (const k of LAYOUT_KEYS) assert.ok(json[k].length > 100, k);
    assert.match(json.markup, /My BTC/);
    assert.match(json.markup, /Last 7 days/);
    assert.ok(fetcher.calls.some((u) => u.includes('days=7&')));
  });

  test('/markup accepts trmnl metadata as a JSON string (preview tool)', async () => {
    const trmnl = JSON.stringify({ user: { uuid: UUID, time_zone_iana: 'UTC' }, plugin_settings: { instance_name: 'Json Name' } });
    const json = await (await fetch(`${base}/markup`, form({ trmnl }))).json();
    assert.match(json.markup, /Json Name/);
    assert.match(json.markup, /Last 7 days/);
  });

  test('/title-icon.svg is black and white', async () => {
    const res = await fetch(`${base}/title-icon.svg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    const svg = await res.text();
    assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b|currentColor/i);
  });

  test('/health', async () => {
    const json = await (await fetch(`${base}/health`)).json();
    assert.equal(json.status, 'ok');
  });
});

test('/markup renders the unavailable state when CoinGecko is down', async () => {
  const app = createApp({ store: createStore(tmpFile()), btc: createBtc({ fetchJson: fakeFetcher(() => new Error('down')), log: quiet }) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const json = await (await fetch(`http://127.0.0.1:${server.address().port}/markup`, { method: 'POST' })).json();
    for (const k of LAYOUT_KEYS) assert.match(json[k], /Bitcoin price unavailable/);
  } finally {
    server.close();
  }
});
