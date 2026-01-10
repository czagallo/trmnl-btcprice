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
let priceCache = {
  price: null,
  change24h: null,
  historicalPrices: null,
  lastUpdated: null
};
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

// Fetch 30-day historical Bitcoin prices from CoinGecko API
function fetchHistoricalPrices() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.coingecko.com',
      port: 443,
      path: '/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=30&interval=daily',
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
async function getBitcoinPrice() {
  const now = Date.now();

  // Return cached price if still valid
  if (priceCache.price && priceCache.lastUpdated && (now - priceCache.lastUpdated) < CACHE_DURATION) {
    console.log('Returning cached Bitcoin price');
    return {
      price: priceCache.price,
      change24h: priceCache.change24h,
      historicalPrices: priceCache.historicalPrices
    };
  }

  // Fetch fresh price and historical data
  try {
    console.log('Fetching fresh Bitcoin price and historical data...');
    const [priceData, historicalPrices] = await Promise.all([
      fetchBitcoinPrice(),
      fetchHistoricalPrices()
    ]);

    priceCache = {
      price: priceData.price,
      change24h: priceData.change24h,
      historicalPrices: historicalPrices,
      lastUpdated: now
    };
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
    if (priceCache.price) {
      console.log('Returning stale cached price due to error');
      return {
        price: priceCache.price,
        change24h: priceCache.change24h,
        historicalPrices: priceCache.historicalPrices || []
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
        p { color: #666; line-height: 1.6; }
        .btn {
          display: inline-block;
          padding: 12px 24px;
          background: #F7931A;
          color: white;
          text-decoration: none;
          border-radius: 6px;
          margin-top: 20px;
        }
        .btn:hover { background: #E28212; }
        .info {
          background: #FFF4E6;
          padding: 15px;
          border-radius: 6px;
          margin: 20px 0;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>₿ Bitcoin Price Plugin</h1>
        <p>Your plugin is active and displaying the current Bitcoin price on your TRMNL device.</p>

        <div class="info">
          <strong>About this plugin:</strong><br>
          Displays real-time Bitcoin price in USD, updated every few minutes. Price data provided by CoinGecko API.
        </div>

        <p>This plugin doesn't require any configuration - it automatically shows the current Bitcoin price.</p>

        ${connection && connection.plugin_setting_id ?
          `<a href="https://usetrmnl.com/plugin_settings/${connection.plugin_setting_id}/edit?force_refresh=true" class="btn">← Back to TRMNL</a>` :
          `<a href="https://usetrmnl.com" class="btn">← Back to TRMNL</a>`
        }
      </div>
    </body>
    </html>
  `);
});

// ============================================================================
// MARKUP GENERATION ENDPOINTS
// ============================================================================

// Main plugin markup endpoint
app.post('/markup', async (req, res) => {
  const { user_uuid } = req.body;

  try {
    // Get current Bitcoin price and historical data
    const { price, change24h, historicalPrices } = await getBitcoinPrice();

    // Generate markup for all layouts
    const response = {
      markup: generateFullMarkup(price, change24h, historicalPrices),
      markup_half_vertical: generateHalfVerticalMarkup(price, change24h, historicalPrices),
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

// Full screen layout - Huge Bitcoin coin on left, price and chart on right
function generateFullMarkup(price, change24h, historicalPrices) {
  const formattedPrice = formatPrice(price);
  const changeColor = change24h >= 0 ? '#16A34A' : '#DC2626';
  const changePrefix = change24h >= 0 ? '+' : '';
  const chart = generatePriceChart(historicalPrices, 450, 120);

  // Bitcoin coin SVG
  const bitcoinCoin = `
    <svg width="320" height="320" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg">
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
        <div class="markdown" style="display: flex; flex-direction: row; align-items: center; height: 100%; padding: 20px;">
          <!-- Left: Huge Bitcoin Coin -->
          <div style="flex: 0 0 35%; display: flex; align-items: center; justify-content: center;">
            ${bitcoinCoin}
          </div>

          <!-- Right: Price, Change, and Chart -->
          <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; padding-left: 30px;">
            <div style="font-size: 80px; font-weight: 700; margin-bottom: 10px;">
              $${formattedPrice}
            </div>
            <div style="font-size: 32px; font-weight: 400; color: ${changeColor}; margin-bottom: 20px;">
              ${changePrefix}${change24h.toFixed(2)}% (24h)
            </div>
            ${chart}
            <div style="font-size: 18px; font-weight: 300; margin-top: 12px; opacity: 0.7;">
              30-Day Price Chart
            </div>
          </div>
        </div>
      </div>
    </div>
  `.trim();
}

// Half vertical layout
function generateHalfVerticalMarkup(price, change24h, historicalPrices) {
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
