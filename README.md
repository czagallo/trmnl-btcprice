# Bitcoin Price Plugin for TRMNL

Display the current Bitcoin price on your TRMNL e-ink display.

## Features

- ₿ Shows the current Bitcoin price in USD
- 📈 Displays 24-hour price change (percentage)
- 📊 Price chart over 24 hours, 7, 30 or 90 days, or 1 year (chosen in the plugin settings), with high, low and change
- 📱 Supports all TRMNL layouts (full, half-vertical, half-horizontal, quadrant) on every screen, including TRMNL X in landscape and portrait
- 🔄 Updates automatically with your TRMNL refresh schedule
- ⚡ Fast price data from CoinGecko API
- 💾 Smart caching to minimize API calls

## What You'll See

The plugin displays:
- A Bitcoin coin next to the current price in USD (e.g. $84,123)
- 24-hour price change with an up or down arrow (black and white, made for e-ink)
- A price chart with the high, low and change over the chosen range
- "Bitcoin price unavailable" if CoinGecko cannot be reached and nothing is cached yet; "as of HH:MM" when the price shown is older than 15 minutes

## Installation

1. Go to your [TRMNL dashboard](https://usetrmnl.com)
2. Navigate to Plugins
3. Search for "Bitcoin Price"
4. Click Install
5. Add to a playlist to display on your device

## Layouts

The plugin adapts to all TRMNL screen layouts:

### Full Screen
Coin, price, 24h change, high/low/change rows and the chart

### Half Vertical
Price and 24h change above the chart, high/low/change rows below

### Half Horizontal
Price and 24h change beside the chart; TRMNL X landscape adds the high/low/change rows

### Quadrant
Price and 24h change; TRMNL X adds the chart

## Use Cases

- 💰 Monitor your Bitcoin investment at a glance
- 📊 Track cryptocurrency market trends
- 🏠 Display Bitcoin price in your home office
- 📈 Keep tabs on BTC price movements throughout the day

## Technical Details

- Price data provided by [CoinGecko API](https://www.coingecko.com/en/api), no API key required
- Stale-while-revalidate cache: the price is refreshed every 2 minutes and each chart range every 10 to 60 minutes in
  the background, warmed at startup; a screen request never waits on CoinGecko once the cache is warm, and the first
  one waits at most 5 seconds
- The chart range per user is stored in `data/connections.json` (gitignored, mode 0600, override with `DATA_FILE`).
  Only the TRMNL user UUID, the plugin setting ID and the chosen range are kept; no access tokens or user data
- Updates on your TRMNL's configured refresh schedule

## Local Development

```bash
# Install dependencies
npm install

# Create .env file from example
cp .env.example .env

# Add your TRMNL credentials to .env
# Get these from https://usetrmnl.com/plugins/my/new

# Run in development mode
npm run dev

# Run the tests (unit and HTTP tests without network access, then a start-up smoke test)
npm test

# Test the markup endpoint
curl -X POST http://127.0.0.1:3002/markup \
  -H "Content-Type: application/json" \
  -d '{"user_uuid": "test"}'
```

The server listens on 127.0.0.1 only; nginx proxies to it.

## Environment Variables

Required variables in `.env`:
- `TRMNL_CLIENT_ID` - Your TRMNL plugin client ID
- `TRMNL_CLIENT_SECRET` - Your TRMNL plugin client secret
- `PORT` - Server port (default: 3002)
- `DATA_FILE` - Optional path of the settings file (default: `data/connections.json`)
- `BASE_URL` - Your plugin's public URL

## Deployment

Pushes to `main` are tested (`npm test` runs the unit tests, then starts the server and checks `/health`) and scanned for vulnerable dependencies and committed secrets (Trivy), then
deployed by GitHub Actions (`.github/workflows/deploy.yml`), which runs `deployment/deploy.sh` on the server. The
server connection comes from repository secrets.

## Support

For issues or questions, please open an issue on [GitHub](https://github.com/czagallo/trmnl-btcprice/issues).

## License

MIT License - See LICENSE file for details

---

Made with ₿ for TRMNL
