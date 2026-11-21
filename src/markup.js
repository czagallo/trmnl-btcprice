// Pure markup builders for every TRMNL layout.
//
// Sizing strategy (TRMNL framework 3.x):
// - The platform picks the screen (OG 800x480, TRMNL X 1040x780, portrait, ...) and adds screen--sm/md/lg,
//   screen--portrait and bit-depth classes. We never branch on device in JS.
// - Graphics are inline SVG with a viewBox, so they scale to whatever box the layout gives them.
// - Text uses framework classes with responsive prefixes (lg:, lg:portrait:) so TRMNL X gets bigger type.
// - Black and white only (currentColor / black); direction is shown with a triangle, never with colour.
// - Every markup string is parsed as Liquid by TRMNL, so nothing here may contain "{{" or "{%"; esc() also
//   escapes { and } so no data value can produce them.

const FILL = 'width:100%;height:100%;min-width:0;min-height:0';
const STALE_MS = 15 * 60 * 1000;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;' };
function esc(s) {
  return String(s ?? '').replace(/[&<>"'{}]/g, (c) => ESC[c]);
}

function formatPrice(p) {
  if (!Number.isFinite(p)) return '';
  const digits = p >= 1000 ? 0 : 2; // BTC is quoted in whole dollars; cents only matter for tiny values
  return '$' + p.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatPct(v) {
  if (!Number.isFinite(v)) return '';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
}

function intervalLabel(days) {
  return { 1: '24 hours', 7: '7 days', 30: '30 days', 90: '90 days', 365: '1 year' }[days] || `${days} days`;
}

function shortInterval(days) {
  return { 1: '24h', 7: '7d', 30: '30d', 90: '90d', 365: '1y' }[days] || `${days}d`;
}

function formatTime(date, timeZone) {
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return date.toLocaleTimeString('en-GB', { ...opts, timeZone: timeZone || 'UTC' });
  } catch {
    return date.toLocaleTimeString('en-GB', { ...opts, timeZone: 'UTC' });
  }
}

// Figures derived from the chart history (oldest first).
function rangeStats(history) {
  if (!history || history.length < 2) return null;
  const first = history[0];
  const last = history[history.length - 1];
  return { high: Math.max(...history), low: Math.min(...history), change: ((last - first) / first) * 100 };
}

// Up or down triangle, drawn in the text colour and sized with the text.
function arrowSvg(v) {
  if (!Number.isFinite(v)) return '';
  const pts = v >= 0 ? '5,1 9.5,9 0.5,9' : '0.5,1 9.5,1 5,9';
  return `<svg viewBox="0 0 10 10" style="width:0.7em;height:0.7em;flex:none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polygon points="${pts}" fill="currentColor"/></svg>`;
}

// Coin with a bold B and the two Bitcoin strokes. Drawn, not a ₿ glyph, so it renders on servers whose fonts lack U+20BF.
function coinSvg() {
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="display:block;${FILL}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bitcoin">
<circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="5"/>
<circle cx="50" cy="50" r="38" fill="none" stroke="currentColor" stroke-width="1.5"/>
<g stroke="currentColor" stroke-width="4.5" stroke-linecap="butt">
<line x1="44" y1="20" x2="44" y2="29"/><line x1="55" y1="20" x2="55" y2="29"/>
<line x1="44" y1="68" x2="44" y2="80"/><line x1="55" y1="68" x2="55" y2="80"/>
</g>
<path fill="currentColor" fill-rule="evenodd" d="M33 28H55C63 28 68 32 68 38.5C68 42.8 65.6 45.9 62 47.1C66.6 48.1 69.6 51.7 69.6 56.7C69.6 64 64 69 55.3 69H33ZM43 36V45.5H53C56 45.5 58 43.7 58 40.75C58 37.8 56 36 53 36ZM43 53V61H54.3C57.5 61 59.6 59.3 59.6 57C59.6 54.7 57.5 53 54.3 53Z"/>
</svg>`;
}

// Price line that stretches to its box. Strokes keep their width when stretched.
function chartSvg(history) {
  if (!history || history.length < 2) return '';
  const min = Math.min(...history);
  const max = Math.max(...history);
  const span = max - min || 1;
  const y = (v) => (94 - ((v - min) / span) * 88).toFixed(2);
  const pts = history.map((v, i) => `${((i / (history.length - 1)) * 300).toFixed(2)},${y(v)}`).join(' ');
  const grid = [0.25, 0.5, 0.75]
    .map((g) => `<line x1="0" y1="${(94 - g * 88).toFixed(2)}" x2="300" y2="${(94 - g * 88).toFixed(2)}" stroke="currentColor" stroke-width="1" stroke-dasharray="2 4" vector-effect="non-scaling-stroke"/>`)
    .join('');
  return `<svg viewBox="0 0 300 100" preserveAspectRatio="none" style="display:block;${FILL}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bitcoin price chart">
${grid}
<line x1="0" y1="99" x2="300" y2="99" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
</svg>`;
}

function titleBar(ctx) {
  return `<div class="title_bar">
<img class="image" src="${esc(ctx.baseUrl)}/title-icon.svg" alt="">
<span class="title">Bitcoin</span>
<span class="instance">${esc(ctx.instance || 'BTC / USD')}</span>
</div>`;
}

// Responsive type ramps. Base = OG (800x480), lg: = TRMNL X, lg:portrait: = TRMNL X held upright.
const T = {
  rowLabel: 'label lg:label--large lg:portrait:label--xlarge',
  rowValue: 'value value--xsmall lg:value--small lg:portrait:value--base value--tnums',
  chartLabel: 'label label--small lg:label--base lg:portrait:label--large',
  meta: 'description lg:description--large lg:portrait:description--xlarge',
};

// The price sits in its own full-width box: classes pick the size per screen, and data-value-fit lets the
// framework shrink it if a long price (say $123,456) would still not fit.
function priceBox(d, cls, align = 'left') {
  return `<div style="flex:none;min-width:0;width:100%;text-align:${align}"><span class="value ${cls} value--tnums" data-value-fit="true" style="white-space:nowrap">${esc(formatPrice(d.price))}</span></div>`;
}

function changeLine(d, cls, labelCls = T.rowLabel) {
  if (!Number.isFinite(d.change24h)) return '';
  return `<div class="flex flex--row ${cls}" style="flex:none;align-items:center;gap:0.3em;white-space:nowrap">${arrowSvg(d.change24h)}<span>${esc(formatPct(d.change24h))}</span><span class="${labelCls}">24h</span></div>`;
}

function staleNote(d, ctx) {
  if (!d.updatedAt || ctx.now - d.updatedAt.getTime() < STALE_MS) return '';
  return `<span class="${T.meta}" style="flex:none">as of ${esc(formatTime(d.updatedAt, ctx.timeZone))}</span>`;
}

// Stacked "30d high  $91,200" rows: reads better than one long line and grows with the screen.
function statRows(d, display = 'flex') {
  const s = rangeStats(d.history);
  if (!s) return '';
  const p = shortInterval(d.days);
  const rows = [
    [`${p} high`, formatPrice(s.high)],
    [`${p} low`, formatPrice(s.low)],
    [`${p} change`, formatPct(s.change)],
  ]
    .map(([name, val]) => `<div class="flex flex--row" style="justify-content:space-between;align-items:baseline;gap:24px">
<span class="${T.rowLabel}" style="white-space:nowrap">${esc(name)}</span>
<span class="${T.rowValue}" style="white-space:nowrap">${esc(val)}</span>
</div>`)
    .join('');
  return `<div class="${display} flex--col" style="flex:none;align-items:stretch;gap:2px;min-width:0;width:100%">${rows}</div>`;
}

function chartBlock(d, extraClass = '') {
  const chart = chartSvg(d.history);
  if (!chart) return '';
  return `<div class="flex flex--col ${extraClass}" style="flex:1 1 0;${FILL};align-items:stretch;gap:4px">
<div style="flex:1 1 0;min-height:0">${chart}</div>
<span class="${T.chartLabel}" style="align-self:flex-start">Last ${esc(intervalLabel(d.days))}</span>
</div>`;
}

function full(d, ctx) {
  return `<div class="view view--full">
<div class="layout">
<div class="flex flex--row portrait:flex--col gap--xlarge" style="${FILL};align-items:stretch">
  <div class="flex flex--col gap--small" style="flex:1.25 1 0;min-width:0;min-height:0;justify-content:center;align-items:stretch">
    <div class="flex flex--row gap--medium" style="flex:none;align-items:center;min-width:0">
      <div class="value portrait:value--large lg:value--base lg:portrait:value--xlarge" style="width:2em;height:2em;flex:none">${coinSvg()}</div>
      <div style="flex:1 1 0;min-width:0">${priceBox(d, 'value--large portrait:value--xlarge lg:value--xxlarge lg:portrait:value--xxxlarge')}</div>
    </div>
    ${changeLine(d, 'title title--large lg:title--xlarge lg:portrait:title--xxlarge')}
    ${staleNote(d, ctx)}
    <div style="height:8px;flex:none"></div>
    ${statRows(d)}
  </div>
  ${chartBlock(d)}
</div>
</div>
${titleBar(ctx)}
</div>`;
}

function halfHorizontal(d, ctx) {
  return `<div class="view view--half_horizontal">
<div class="layout">
<div class="flex flex--row portrait:flex--col gap--large" style="${FILL};align-items:stretch">
  <div class="flex flex--col gap--xsmall" style="flex:1 1 0;min-width:0;min-height:0;justify-content:center;align-items:flex-start">
    ${priceBox(d, 'value--large lg:value--xlarge lg:portrait:value--xxlarge')}
    ${changeLine(d, 'title lg:title--large lg:portrait:title--xlarge')}
    ${staleNote(d, ctx)}
    ${statRows(d, 'hidden lg:flex lg:portrait:hidden')}
  </div>
  ${chartBlock(d)}
</div>
</div>
${titleBar(ctx)}
</div>`;
}

function halfVertical(d, ctx) {
  return `<div class="view view--half_vertical">
<div class="layout">
<div class="flex flex--col gap--small" style="${FILL};align-items:stretch;justify-content:center">
  ${priceBox(d, 'value--large portrait:value--base lg:value--xlarge', 'center')}
  <div class="flex flex--row" style="flex:none;justify-content:center">${changeLine(d, 'title lg:title--large lg:portrait:title--xlarge')}</div>
  ${staleNote(d, ctx) ? `<div class="flex flex--row" style="flex:none;justify-content:center">${staleNote(d, ctx)}</div>` : ''}
  ${chartBlock(d)}
  ${statRows(d)}
</div>
</div>
${titleBar(ctx)}
</div>`;
}

function quadrant(d, ctx) {
  // TRMNL X has room for the chart under the price; smaller screens show price and 24h change only.
  // The quadrant is the same size in both orientations on X, so there is no portrait step here.
  const chart = chartBlock(d);
  return `<div class="view view--quadrant">
<div class="layout">
<div class="flex flex--col gap--small" style="${FILL};align-items:stretch;justify-content:center">
  <div class="flex flex--col" style="flex:none;align-items:center;gap:2px">
    ${priceBox(d, 'value--large portrait:value--base lg:value--xlarge', 'center')}
    ${changeLine(d, 'title lg:title--large', 'label lg:label--large')}
  </div>
  ${chart ? `<div class="hidden lg:flex" style="flex:1 1 0;min-height:0">${chart}</div>` : ''}
</div>
</div>
${titleBar(ctx)}
</div>`;
}

function unavailable(view, ctx) {
  return `<div class="view view--${view}">
<div class="layout layout--col layout--center gap--small">
  <span class="title lg:title--large lg:portrait:title--xlarge text--center">Bitcoin price unavailable</span>
  <span class="${T.meta} text--center">CoinGecko did not respond. It will retry on the next refresh.</span>
</div>
${titleBar(ctx)}
</div>`;
}

// data: { price, change24h, history, days, updatedAt } or null. ctx: { baseUrl, instance, timeZone, now }
function renderAll(data, ctx = {}) {
  const c = { baseUrl: '', now: Date.now(), ...ctx };
  const ok = data && Number.isFinite(data.price) && data.price > 0;
  if (!ok) {
    return {
      markup: unavailable('full', c),
      markup_half_horizontal: unavailable('half_horizontal', c),
      markup_half_vertical: unavailable('half_vertical', c),
      markup_quadrant: unavailable('quadrant', c),
    };
  }
  return {
    markup: full(data, c),
    markup_half_horizontal: halfHorizontal(data, c),
    markup_half_vertical: halfVertical(data, c),
    markup_quadrant: quadrant(data, c),
  };
}

module.exports = { renderAll, esc, formatPrice, formatPct, rangeStats, chartSvg, coinSvg, intervalLabel };
