# Bitcoin Price Plugin for TRMNL

Display the current Bitcoin price on your TRMNL e-ink display.

## Features

- ₿ Shows the current Bitcoin price in USD
- 📈 Displays 24-hour price change (percentage)
- 📊 30-day price chart showing daily trends
- 📱 Supports all TRMNL layouts (full, half-vertical, half-horizontal, quadrant)
- 🔄 Updates automatically with your TRMNL refresh schedule
- ⚡ Fast price data from CoinGecko API
- 💾 Smart caching to minimize API calls

## What You'll See

The plugin displays:
- A huge Bitcoin symbol (₿) on the left side
- Current price in USD (e.g., $45,678.90)
- 24-hour price change with color coding (green for gains, red for losses)
- 30-day price trend chart

## Installation

1. Go to your [TRMNL dashboard](https://usetrmnl.com)
2. Navigate to Plugins
3. Search for "Bitcoin Price"
4. Click Install
5. Add to a playlist to display on your device

## Layouts

The plugin adapts to all TRMNL screen layouts:

### Full Screen
Large Bitcoin symbol with price and 24h change

### Half Vertical
Bitcoin symbol with price (perfect for mashups)

### Half Horizontal
Horizontal layout with symbol and price side-by-side

### Quadrant
Compact Bitcoin price for multi-plugin layouts

## Use Cases

- 💰 Monitor your Bitcoin investment at a glance
- 📊 Track cryptocurrency market trends
- 🏠 Display Bitcoin price in your home office
- 📈 Keep tabs on BTC price movements throughout the day

## Technical Details

- Price data provided by [CoinGecko API](https://www.coingecko.com/en/api)
- Prices cached for 2 minutes to reduce API load
- No API key required
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

# Test the markup endpoint
curl -X POST http://localhost:3000/markup \
  -H "Content-Type: application/json" \
  -d '{"user_uuid": "test"}'
```

## Environment Variables

Required variables in `.env`:
- `TRMNL_CLIENT_ID` - Your TRMNL plugin client ID
- `TRMNL_CLIENT_SECRET` - Your TRMNL plugin client secret
- `PORT` - Server port (default: 3000)
- `BASE_URL` - Your plugin's public URL

## Support

For issues or questions, please open an issue on the repository.

## License

MIT License - See LICENSE file for details

---

Made with ₿ for TRMNL
