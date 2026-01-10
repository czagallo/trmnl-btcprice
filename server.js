require('dotenv').config();
const express = require('express');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables
const CLIENT_ID = process.env.TRMNL_CLIENT_ID;
const CLIENT_SECRET = process.env.TRMNL_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// In-memory storage for plugin connections
// In production, use a database (PostgreSQL, MongoDB, etc.)
const pluginConnections = new Map();

// Cache for Bitcoin price (avoid hitting API too frequently)
// Store cache per interval (days)
const priceCache = new Map();
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// BITCOIN PRICE FUNCTIONS
// ============================================================================

// Fetch Bitcoin price from CoinGecko API
function fetchBitcoinPrice() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.coingecko.com',
      port: 443,
      path: '/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TRMNL-Bitcoin-Price-Plugin/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.bitcoin && response.bitcoin.usd) {
            resolve({
              price: response.bitcoin.usd,
              change24h: response.bitcoin.usd_24h_change || 0
            });
          } else {
            console.error('Invalid response from CoinGecko API');
            reject(new Error('Invalid response from CoinGecko API'));
          }
        } catch (error) {
          console.error('Error parsing CoinGecko response:', error.message);
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

// Fetch historical Bitcoin prices from CoinGecko API
function fetchHistoricalPrices(days = 30) {
  return new Promise((resolve, reject) => {
    // For 1 day, use hourly interval; otherwise use daily
    const interval = days === 1 ? 'hourly' : 'daily';

    const options = {
      hostname: 'api.coingecko.com',
      port: 443,
      path: `/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}&interval=${interval}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TRMNL-Bitcoin-Price-Plugin/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.prices && Array.isArray(response.prices)) {
            // Extract just the price values (response.prices is array of [timestamp, price])
            const prices = response.prices.map(p => p[1]);
            resolve(prices);
          } else {
            console.error('Invalid historical data from CoinGecko API');
            reject(new Error('Invalid historical data from CoinGecko API'));
          }
        } catch (error) {
          console.error('Error parsing historical data:', error.message);
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

// Get Bitcoin price with caching
async function getBitcoinPrice(days = 30) {
  const now = Date.now();
  const cacheKey = `days_${days}`;

  // Return cached price if still valid
  const cached = priceCache.get(cacheKey);
  if (cached && cached.lastUpdated && (now - cached.lastUpdated) < CACHE_DURATION) {
    console.log(`Returning cached Bitcoin price (${days} days)`);
    return {
      price: cached.price,
      change24h: cached.change24h,
      historicalPrices: cached.historicalPrices
    };
  }

  // Fetch fresh price and historical data
  try {
    console.log(`Fetching fresh Bitcoin price and ${days}-day historical data...`);
    const [priceData, historicalPrices] = await Promise.all([
      fetchBitcoinPrice(),
      fetchHistoricalPrices(days)
    ]);

    const newCache = {
      price: priceData.price,
      change24h: priceData.change24h,
      historicalPrices: historicalPrices,
      lastUpdated: now
    };

    priceCache.set(cacheKey, newCache);
    console.log(`Bitcoin price: $${priceData.price.toLocaleString()}`);
    console.log(`Historical data points: ${historicalPrices.length}`);
    return {
      price: priceData.price,
      change24h: priceData.change24h,
      historicalPrices: historicalPrices
    };
  } catch (error) {
    console.error('Error fetching Bitcoin price:', error);
    // Return cached price if available, even if stale
    if (cached) {
      console.log('Returning stale cached price due to error');
      return {
        price: cached.price,
        change24h: cached.change24h,
        historicalPrices: cached.historicalPrices || []
      };
    }
    // Return placeholder if no cache available
    return {
      price: 0,
      change24h: 0,
      historicalPrices: []
    };
  }
}

// Generate simple SVG line chart for e-ink display
function generatePriceChart(prices, width = 600, height = 120) {
  if (!prices || prices.length === 0) {
    return '';
  }

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice;

  if (priceRange === 0) {
    return '';
  }

  // Create points for the line chart
  const points = prices.map((price, index) => {
    const x = (index / (prices.length - 1)) * width;
    const y = height - ((price - minPrice) / priceRange) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  return `
    <svg width="${width}" height="${height}" style="margin: 20px auto; display: block;">
      <polyline
        points="${points}"
        fill="none"
        stroke="black"
        stroke-width="2"
      />
    </svg>
  `.trim();
}

// Format price with commas
function formatPrice(price) {
  return price.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// ============================================================================
// INSTALLATION FLOW ENDPOINTS
// ============================================================================

// Step 1: Installation URL - TRMNL sends code and callback URL
app.get('/install', async (req, res) => {
  console.log('Install request received:');
  console.log('Query params:', req.query);

  // TRMNL sends 'code' (OAuth authorization code) not 'token'
  const { code, installation_callback_url } = req.query;

  if (!code || !installation_callback_url) {
    console.error('Missing required parameters');
    return res.status(400).json({
      error: 'Missing code or installation_callback_url',
      received_query: req.query
    });
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Plugin credentials not configured' });
  }

  try {
    // Step 2: Exchange authorization code for access_token
    console.log('Exchanging authorization code for access token...');
    const accessToken = await exchangeCodeForAccess(code);
    console.log('Access token received successfully');

    // Step 3: Redirect user back to TRMNL
    console.log('Redirecting to:', installation_callback_url);
    res.redirect(302, installation_callback_url);
  } catch (error) {
    console.error('Installation error:', error);
    res.status(500).json({ error: 'Installation failed', details: error.message });
  }
});

// Helper function to exchange authorization code for access_token
function exchangeCodeForAccess(code) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code'
    });

    const options = {
      hostname: 'usetrmnl.com',
      port: 443,
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          console.log('OAuth response:', data);
          const response = JSON.parse(data);
          if (response.access_token) {
            resolve(response.access_token);
          } else {
            reject(new Error(`No access_token in response: ${data}`));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

// Installation success webhook
app.post('/webhooks/install-success', (req, res) => {
  console.log('Success webhook received!');
  console.log('Body:', JSON.stringify(req.body, null, 2));

  const user = req.body.user;
  if (!user) {
    console.error('No user data in webhook');
    return res.status(400).json({ error: 'No user data' });
  }

  const user_uuid = user.uuid;
  const plugin_setting_id = user.plugin_setting_id;
  const access_token = req.headers.authorization?.replace('Bearer ', '');

  console.log('Installation successful for user:', user_uuid);
  console.log('Plugin setting ID:', plugin_setting_id);

  pluginConnections.set(user_uuid, {
    plugin_setting_id,
    access_token,
    installed_at: new Date().toISOString(),
    user_data: user
  });

  res.status(200).json({ success: true });
});

// Uninstallation webhook
app.post('/webhooks/uninstall', (req, res) => {
  console.log('Uninstall webhook received:', JSON.stringify(req.body, null, 2));

  const user_uuid = req.body.user?.uuid || req.body.uuid;

  console.log('Uninstalling plugin for user:', user_uuid);

  if (user_uuid) {
    pluginConnections.delete(user_uuid);
  }

  res.status(200).json({ success: true });
});

// Plugin management URL
app.get('/manage', (req, res) => {
  const { uuid } = req.query;

  if (!uuid) {
    return res.status(400).send('Missing uuid parameter');
  }

  const connection = pluginConnections.get(uuid);
  const currentInterval = connection?.chartInterval || '30';
  const saved = req.query.saved === 'true';

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Bitcoin Price Plugin Settings</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 600px;
          margin: 50px auto;
          padding: 20px;
          background: #f5f5f5;
        }
        .card {
          background: white;
          border-radius: 8px;
          padding: 30px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 { color: #333; margin-top: 0; }
        h2 { color: #333; margin-top: 30px; font-size: 20px; }
        p { color: #666; line-height: 1.6; }
        label { display: block; margin-bottom: 8px; font-weight: 500; color: #333; }
        select {
          width: 100%;
          padding: 10px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 16px;
          margin-bottom: 15px;
        }
        .btn {
          display: inline-block;
          padding: 12px 24px;
          background: #F7931A;
          color: white;
          text-decoration: none;
          border-radius: 6px;
          border: none;
          cursor: pointer;
          font-size: 16px;
          margin-right: 10px;
        }
        .btn:hover { background: #E28212; }
        .btn-secondary {
          background: #6B7280;
        }
        .btn-secondary:hover {
          background: #4B5563;
        }
        .info {
          background: #FFF4E6;
          padding: 15px;
          border-radius: 6px;
          margin: 20px 0;
        }
        .success {
          background: #D1FAE5;
          color: #065F46;
          padding: 12px;
          border-radius: 6px;
          margin-bottom: 20px;
        }
        .interval-desc {
          font-size: 14px;
          color: #666;
          margin-top: 8px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>₿ Bitcoin Price Plugin</h1>

        ${saved ? '<div class="success">✓ Settings saved successfully!</div>' : ''}

        <p>Configure your Bitcoin price display settings.</p>

        <h2>Chart Settings</h2>
        <form method="POST" action="/manage/save">
          <input type="hidden" name="uuid" value="${uuid}">

          <label for="interval">Price Chart Interval:</label>
          <select name="interval" id="interval">
            <option value="1" ${currentInterval === '1' ? 'selected' : ''}>24 Hours (Hourly)</option>
            <option value="7" ${currentInterval === '7' ? 'selected' : ''}>7 Days (Daily)</option>
            <option value="30" ${currentInterval === '30' ? 'selected' : ''}>30 Days (Daily)</option>
            <option value="90" ${currentInterval === '90' ? 'selected' : ''}>90 Days (Daily)</option>
            <option value="365" ${currentInterval === '365' ? 'selected' : ''}>1 Year (Daily)</option>
          </select>
          <div class="interval-desc">Choose the time range for the price chart displayed on your device.</div>

          <div style="margin-top: 25px;">
            <button type="submit" class="btn">Save Settings</button>
            ${connection && connection.plugin_setting_id ?
              `<a href="https://usetrmnl.com/plugin_settings/${connection.plugin_setting_id}/edit?force_refresh=true" class="btn btn-secondary">← Back to TRMNL</a>` :
              `<a href="https://usetrmnl.com" class="btn btn-secondary">← Back to TRMNL</a>`
            }
          </div>
        </form>
      </div>
    </body>
    </html>
  `);
});

// Save settings endpoint
app.post('/manage/save', express.urlencoded({ extended: true }), (req, res) => {
  const { uuid, interval } = req.body;

  if (!uuid) {
    return res.status(400).send('Missing uuid parameter');
  }

  const connection = pluginConnections.get(uuid);
  if (connection) {
    connection.chartInterval = interval;
    pluginConnections.set(uuid, connection);
  }

  // Redirect back to manage page with success message
  res.redirect(`/manage?uuid=${uuid}&saved=true`);
});

// ============================================================================
// MARKUP GENERATION ENDPOINTS
// ============================================================================

// Main plugin markup endpoint
app.post('/markup', async (req, res) => {
  const { user_uuid } = req.body;

  try {
    // Get user's chart interval preference (default to 30 days)
    const connection = pluginConnections.get(user_uuid);
    const days = parseInt(connection?.chartInterval || '30');

    // Get current Bitcoin price and historical data
    const { price, change24h, historicalPrices } = await getBitcoinPrice(days);

    // Get chart label based on interval
    const chartLabel = getChartLabel(days);

    // Generate markup for all layouts
    const response = {
      markup: generateFullMarkup(price, change24h, historicalPrices, chartLabel),
      markup_half_vertical: generateHalfVerticalMarkup(price, change24h, historicalPrices, chartLabel),
      markup_half_horizontal: generateHalfHorizontalMarkup(price, change24h),
      markup_quadrant: generateQuadrantMarkup(price),
      shared: ""
    };

    res.json(response);
  } catch (error) {
    console.error('Error generating markup:', error);
    res.status(500).json({ error: 'Failed to generate markup' });
  }
});

// Helper to get chart label based on interval
function getChartLabel(days) {
  if (days === 1) return '24-Hour Chart';
  if (days === 7) return '7-Day Chart';
  if (days === 30) return '30-Day Chart';
  if (days === 90) return '90-Day Chart';
  if (days === 365) return '1-Year Chart';
  return `${days}-Day Chart`;
}

// Full screen layout - Huge Bitcoin coin on left, price and chart on right
function generateFullMarkup(price, change24h, historicalPrices, chartLabel = '30-Day Chart') {
  const formattedPrice = formatPrice(price);
  const changeColor = change24h >= 0 ? '#16A34A' : '#DC2626';
  const changePrefix = change24h >= 0 ? '+' : '';
  const chart = generatePriceChart(historicalPrices, 400, 110);

  // Bitcoin coin SVG (smaller to fit screen)
  const bitcoinCoin = `
    <svg width="260" height="260" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg">
      <!-- Outer circle (coin edge) -->
      <circle cx="160" cy="160" r="155" fill="none" stroke="black" stroke-width="10"/>

      <!-- Inner circle (coin face) -->
      <circle cx="160" cy="160" r="145" fill="white" stroke="black" stroke-width="3"/>

      <!-- Bitcoin B symbol -->
      <text x="160" y="220" font-family="Arial, sans-serif" font-size="180" font-weight="900" text-anchor="middle" fill="black">₿</text>

      <!-- Decorative notches around edge -->
      <circle cx="160" cy="10" r="4" fill="black"/>
      <circle cx="160" cy="310" r="4" fill="black"/>
      <circle cx="10" cy="160" r="4" fill="black"/>
      <circle cx="310" cy="160" r="4" fill="black"/>
    </svg>
  `;

  return `
    <div class="view view--full">
      <div class="layout">
        <div class="markdown" style="display: flex; flex-direction: row; align-items: center; height: 100%; padding: 15px 10px;">
          <!-- Left: Bitcoin Coin -->
          <div style="flex: 0 0 30%; display: flex; align-items: center; justify-content: center; padding-left: 10px;">
            ${bitcoinCoin}
          </div>

          <!-- Right: Price, Change, and Chart -->
          <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; padding-left: 20px; padding-right: 15px; max-width: 65%;">
            <div style="font-size: 68px; font-weight: 700; margin-bottom: 8px; line-height: 1;">
              $${formattedPrice}
            </div>
            <div style="font-size: 28px; font-weight: 400; color: ${changeColor}; margin-bottom: 18px;">
              ${changePrefix}${change24h.toFixed(2)}% (24h)
            </div>
            ${chart}
            <div style="font-size: 16px; font-weight: 300; margin-top: 10px; opacity: 0.7;">
              ${chartLabel}
            </div>
          </div>
        </div>
      </div>
    </div>
  `.trim();
}

// Half vertical layout
function generateHalfVerticalMarkup(price, change24h, historicalPrices, chartLabel = '30-Day Chart') {
  const formattedPrice = formatPrice(price);
  const changeColor = change24h >= 0 ? '#16A34A' : '#DC2626';
  const changePrefix = change24h >= 0 ? '+' : '';
  const chart = generatePriceChart(historicalPrices, 300, 80);

  return `
    <div class="view view--half_vertical">
      <div class="layout">
        <div class="title_bar">
          <div class="title">Bitcoin</div>
        </div>
        <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center;">
          <div style="font-size: 80px; font-weight: 700; line-height: 1; margin-bottom: 10px;">
            ₿
          </div>
          <div style="font-size: 36px; font-weight: 700; margin-bottom: 6px;">
            $${formattedPrice}
          </div>
          <div style="font-size: 18px; font-weight: 400; color: ${changeColor}; margin-bottom: 10px;">
            ${changePrefix}${change24h.toFixed(2)}%
          </div>
          ${chart}
        </div>
      </div>
    </div>
  `.trim();
}

// Half horizontal layout
function generateHalfHorizontalMarkup(price, change24h) {
  const formattedPrice = formatPrice(price);
  const changeColor = change24h >= 0 ? '#16A34A' : '#DC2626';
  const changePrefix = change24h >= 0 ? '+' : '';

  return `
    <div class="view view--half_horizontal">
      <div class="layout">
        <div class="title_bar">
          <div class="title">Bitcoin Price</div>
        </div>
        <div class="markdown" style="display: flex; align-items: center; justify-content: center; height: 100%; text-align: center; gap: 20px;">
          <div style="font-size: 80px; font-weight: 700; line-height: 1;">
            ₿
          </div>
          <div>
            <div style="font-size: 48px; font-weight: 700;">
              $${formattedPrice}
            </div>
            <div style="font-size: 20px; font-weight: 400; color: ${changeColor};">
              ${changePrefix}${change24h.toFixed(2)}%
            </div>
          </div>
        </div>
      </div>
    </div>
  `.trim();
}

// Quadrant layout
function generateQuadrantMarkup(price) {
  const formattedPrice = formatPrice(price);

  return `
    <div class="view view--quadrant">
      <div class="layout">
        <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center;">
          <div style="font-size: 48px; font-weight: 700; line-height: 1; margin-bottom: 8px;">
            ₿
          </div>
          <div style="font-size: 18px; font-weight: 600;">
            $${formattedPrice}
          </div>
        </div>
      </div>
    </div>
  `.trim();
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`TRMNL Bitcoin Price Plugin running on port ${PORT}`);
  console.log(`Markup endpoint: POST http://localhost:${PORT}/markup`);
});
