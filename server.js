require('dotenv').config();
const path = require('path');
const express = require('express');
const { createBtc, normalizeInterval, withTimeout, INTERVALS, DEFAULT_INTERVAL } = require('./src/btc');
const { renderAll, esc, intervalLabel, coinSvg } = require('./src/markup');
const { createStore } = require('./src/store');

const PORT = Number(process.env.PORT) || 3002;
const CLIENT_ID = process.env.TRMNL_CLIENT_ID;
const CLIENT_SECRET = process.env.TRMNL_CLIENT_SECRET;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TRMNL_OAUTH_URL = 'https://usetrmnl.com/oauth/token';
const MARKUP_BUDGET_MS = 7000; // TRMNL gives /markup 10 s
const UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SETTING_ID_RE = /^[0-9]{1,20}$/;

function createApp({ store = createStore(), btc = createBtc() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // TRMNL posts the markup request form-encoded with nested keys (trmnl[user][...]); JSON is for local testing.
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/icon.svg', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'icon.svg'));
  });

  // Black-and-white coin for the e-ink title bar (icon.svg is the coloured marketplace icon).
  const titleIcon = coinSvg().replace('<svg ', '<svg width="100" height="100" ').replace(/currentColor/g, 'black');
  app.get('/title-icon.svg', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/svg+xml').send(titleIcon);
  });

  // -------------------------------------------------------------------------
  // Installation (OAuth)
  // -------------------------------------------------------------------------

  app.get('/install', async (req, res) => {
    const { code, installation_callback_url: callback } = req.query;
    if (!code || !callback || typeof code !== 'string' || typeof callback !== 'string') {
      return res.status(400).json({ error: 'Missing code or installation_callback_url' });
    }
    if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).json({ error: 'Plugin credentials not configured' });

    try {
      const r = await fetch(TRMNL_OAUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code' }),
        signal: AbortSignal.timeout(8000),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.access_token) throw new Error(`token exchange failed (HTTP ${r.status})`);
      console.log('Install: token exchange ok');
      res.redirect(302, callback);
    } catch (err) {
      console.error('Install failed:', err.message);
      res.status(500).json({ error: 'Installation failed' });
    }
  });

  // Only the plugin_setting_id (for the "Back to TRMNL" link) is kept; no user data, no access token.
  app.post('/webhooks/install-success', (req, res) => {
    const user = req.body?.user;
    const uuid = String(user?.uuid || '');
    if (!UUID_RE.test(uuid)) return res.status(400).json({ error: 'No user data' });
    const sid = String(user.plugin_setting_id ?? '');
    store.update(uuid, { plugin_setting_id: SETTING_ID_RE.test(sid) ? sid : null });
    console.log('Install success');
    res.json({ success: true });
  });

  app.post('/webhooks/uninstall', (req, res) => {
    const uuid = String(req.body?.user?.uuid || req.body?.uuid || '');
    if (UUID_RE.test(uuid)) store.delete(uuid);
    console.log('Uninstall');
    res.json({ success: true });
  });

  // -------------------------------------------------------------------------
  // Settings page
  // -------------------------------------------------------------------------

  function managePage(uuid, conn, notice) {
    const current = normalizeInterval(conn?.chartInterval) ?? DEFAULT_INTERVAL;
    const sid = conn?.plugin_setting_id && SETTING_ID_RE.test(String(conn.plugin_setting_id)) ? String(conn.plugin_setting_id) : null;
    const back = sid ? `https://usetrmnl.com/plugin_settings/${encodeURIComponent(sid)}/edit?force_refresh=true` : 'https://usetrmnl.com';
    const options = INTERVALS.map(
      (d) => `<option value="${d}"${d === current ? ' selected' : ''}>${esc(intervalLabel(d))}${d === 1 ? ' (hourly)' : ' (daily)'}</option>`,
    ).join('');

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bitcoin Price</title>
<style>
body{font-family:system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 16px;line-height:1.5;color:#1a1a1a}
label{display:block;font-weight:600;margin-top:18px}
select{width:100%;box-sizing:border-box;padding:9px;font:inherit;border:1px solid #bbb;border-radius:6px;margin-top:4px}
small{color:#555;display:block;margin-top:4px}
button,.btn{display:inline-block;margin-top:24px;margin-right:8px;padding:10px 18px;font:inherit;border-radius:6px;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;text-decoration:none;cursor:pointer}
.btn{background:#fff;color:#1a1a1a}
.notice{padding:10px 14px;border-radius:6px;margin:16px 0;background:#eef6ee;border:1px solid #9c9}
.notice.err{background:#fbeeee;border-color:#d99}
</style></head>
<body>
<h1>Bitcoin Price</h1>
<p>The current Bitcoin price in USD with its 24-hour change and a price chart. Data: CoinGecko.</p>
${notice ? `<div class="notice${notice.ok ? '' : ' err'}">${esc(notice.text)}</div>` : ''}
<form method="POST" action="/manage/save">
<input type="hidden" name="uuid" value="${esc(uuid)}">
<label for="interval">Chart range</label>
<select name="interval" id="interval">${options}</select>
<small>The time range of the price chart on your device.</small>
<button type="submit">Save</button>
<a class="btn" href="${esc(back)}">Back to TRMNL</a>
</form>
</body></html>`;
  }

  app.get('/manage', (req, res) => {
    const uuid = String(req.query.uuid || '');
    if (!UUID_RE.test(uuid)) return res.status(400).send('Missing or invalid uuid');
    const notice = req.query.saved === 'true' ? { ok: true, text: 'Settings saved.' } : null;
    res.type('html').send(managePage(uuid, store.get(uuid), notice));
  });

  // Works for any valid uuid, also one whose install webhook we never saw (for example before persistence existed).
  app.post('/manage/save', (req, res) => {
    const uuid = String(req.body?.uuid || '');
    if (!UUID_RE.test(uuid)) return res.status(400).send('Missing or invalid uuid');
    const interval = normalizeInterval(req.body?.interval);
    if (interval === null) {
      return res.status(400).type('html').send(managePage(uuid, store.get(uuid), { ok: false, text: 'Please choose one of the offered chart ranges.' }));
    }
    if (!store.update(uuid, { chartInterval: interval })) {
      return res.status(500).type('html').send(managePage(uuid, store.get(uuid), { ok: false, text: 'Could not save your settings. Please try again later.' }));
    }
    btc.getHistory(interval).catch(() => {}); // warm the chart for the first screen
    res.redirect(303, `/manage?uuid=${encodeURIComponent(uuid)}&saved=true`);
  });

  // -------------------------------------------------------------------------
  // Screen generation
  // -------------------------------------------------------------------------

  // TRMNL metadata arrives either as nested form keys (trmnl[user][...]) or as one JSON string in the "trmnl" field.
  function trmnlMeta(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw === 'string' && raw.length < 50000) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        /* not JSON: ignore */
      }
    }
    return {};
  }

  app.post('/markup', async (req, res) => {
    const trmnl = trmnlMeta(req.body?.trmnl);
    const uuid = String(req.body?.user_uuid || trmnl.user?.uuid || '');
    const conn = UUID_RE.test(uuid) ? store.get(uuid) : null;
    const days = normalizeInterval(conn?.chartInterval) ?? DEFAULT_INTERVAL;
    const ctx = { baseUrl: BASE_URL, instance: trmnl.plugin_settings?.instance_name, timeZone: trmnl.user?.time_zone_iana };
    let data = null;
    try {
      data = await withTimeout(btc.getData(days), MARKUP_BUDGET_MS);
    } catch (err) {
      console.error('Markup data failed:', err.message);
    }
    res.json(renderAll(data, ctx));
  });

  app.get('/health', (req, res) => {
    const age = btc.cacheAgeMs();
    res.json({ status: 'ok', users: store.size(), cacheAgeSeconds: age === null ? null : Math.round(age / 1000) });
  });

  app.locals.btc = btc;
  app.locals.store = store;
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, '127.0.0.1', () => console.log(`TRMNL Bitcoin Price plugin on http://127.0.0.1:${PORT}`));
  const { btc, store } = app.locals;
  btc.startBackgroundRefresh(() => store.all().map((c) => c.chartInterval));
}

module.exports = { createApp };
