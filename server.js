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
        'Accept': 'application/json'
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
            reject(new Error('Invalid response from CoinGecko API'));
          }
        } catch (error) {
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
      change24h: priceCache.change24h
    };
  }

  // Fetch fresh price
  try {
    console.log('Fetching fresh Bitcoin price...');
    const data = await fetchBitcoinPrice();
    priceCache = {
      price: data.price,
      change24h: data.change24h,
      lastUpdated: now
    };
    console.log(`Bitcoin price: $${data.price.toLocaleString()}`);
    return data;
  } catch (error) {
    console.error('Error fetching Bitcoin price:', error);
    // Return cached price if available, even if stale
    if (priceCache.price) {
      console.log('Returning stale cached price due to error');
      return {
        price: priceCache.price,
        change24h: priceCache.change24h
      };
    }
    // Return placeholder if no cache available
    return {
      price: 0,
      change24h: 0
    };
  }
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
    // Get current Bitcoin price
    const { price, change24h } = await getBitcoinPrice();

    // Generate markup for all layouts
    const response = {
      markup: generateFullMarkup(price, change24h),
      markup_half_vertical: generateHalfVerticalMarkup(price, change24h),
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

// Full screen layout - Huge Bitcoin symbol and price
function generateFullMarkup(price, change24h) {
  const formattedPrice = formatPrice(price);
  const changeColor = change24h >= 0 ? '#16A34A' : '#DC2626';
  const changePrefix = change24h >= 0 ? '+' : '';

  return `
    <div class="view view--full">
      <div class="layout">
        <div class="title_bar">
          <div class="title">Bitcoin Price</div>
        </div>
        <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center;">
          <div style="font-size: 160px; font-weight: 700; line-height: 1; margin-bottom: 20px;">
            ₿
          </div>
          <div style="font-size: 72px; font-weight: 700; margin-bottom: 10px;">
            $${formattedPrice}
          </div>
          <div style="font-size: 28px; font-weight: 400; color: ${changeColor};">
            ${changePrefix}${change24h.toFixed(2)}% (24h)
          </div>
        </div>
      </div>
    </div>
  `.trim();
}

// Half vertical layout
function generateHalfVerticalMarkup(price, change24h) {
  const formattedPrice = formatPrice(price);
  const changeColor = change24h >= 0 ? '#16A34A' : '#DC2626';
  const changePrefix = change24h >= 0 ? '+' : '';

  return `
    <div class="view view--half_vertical">
      <div class="layout">
        <div class="title_bar">
          <div class="title">Bitcoin</div>
        </div>
        <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center;">
          <div style="font-size: 100px; font-weight: 700; line-height: 1; margin-bottom: 15px;">
            ₿
          </div>
          <div style="font-size: 40px; font-weight: 700; margin-bottom: 8px;">
            $${formattedPrice}
          </div>
          <div style="font-size: 20px; font-weight: 400; color: ${changeColor};">
            ${changePrefix}${change24h.toFixed(2)}%
          </div>
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
