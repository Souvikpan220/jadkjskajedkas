const express = require('express');
const cors    = require('cors');
const app     = express();

// ── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['POST', 'GET'],
}));

// ── Env ──────────────────────────────────────────────────────
const ORDER_WEBHOOK = process.env.ORDER_WEBHOOK_URL;
const LOG_WEBHOOK   = process.env.LOG_WEBHOOK_URL;
const COOLDOWN_MS   = 15 * 60 * 1000; // 15 minutes

// ── In-memory stores ─────────────────────────────────────────
const cooldowns    = new Map(); // ip → last order timestamp
const rateLimiter  = new Map(); // ip → { count, windowStart }
const RATE_WINDOW  = 60 * 1000; // 1 min window
const RATE_MAX     = 5;         // max 5 requests per minute per IP

// ── Helpers ──────────────────────────────────────────────────
function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function sanitizeURL(raw) {
  return raw?.replace(/[<>"'`]/g, '').trim().slice(0, 500) || '';
}

async function sendWebhook(url, payload) {
  if (!url) return;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error('[Webhook]', r.status, await r.text());
  } catch (e) { console.error('[Webhook error]', e.message); }
}

async function getGeo(ip) {
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=country,city,isp`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

// ── Cleanup stale entries (prevent memory leak) ──────────────
function cleanup() {
  const now = Date.now();
  for (const [k, v] of cooldowns.entries()) {
    if (now - v > COOLDOWN_MS * 2) cooldowns.delete(k);
  }
  for (const [k, v] of rateLimiter.entries()) {
    if (now - v.windowStart > RATE_WINDOW * 5) rateLimiter.delete(k);
  }
}
setInterval(cleanup, 5 * 60 * 1000);

// ── Rate limit middleware ─────────────────────────────────────
function rateLimit(req, res, next) {
  const ip  = getIP(req);
  const now = Date.now();
  const rec = rateLimiter.get(ip) || { count: 0, windowStart: now };

  if (now - rec.windowStart > RATE_WINDOW) {
    rec.count = 0; rec.windowStart = now;
  }
  rec.count++;
  rateLimiter.set(ip, rec);

  if (rec.count > RATE_MAX) {
    return res.status(429).json({ message: 'Too many requests. Please slow down.' });
  }
  next();
}

// ── Origin check middleware ───────────────────────────────────
function originCheck(req, res, next) {
  const xrw = req.headers['x-requested-with'];
  if (!xrw || xrw !== 'XMLHttpRequest') {
    return res.status(403).json({ message: 'Forbidden.' });
  }
  next();
}

// ════════════════════════════════════════════════════════════
//  POST /order
// ════════════════════════════════════════════════════════════
app.post('/order', rateLimit, originCheck, async (req, res) => {
  const ip        = getIP(req);
  const ua        = req.headers['user-agent'] || 'unknown';
  const now       = Date.now();

  // ── Input validation ────────────────────────────────────────
  const { platform, url: rawUrl, amount } = req.body;
  const url = sanitizeURL(rawUrl);

  const validPlatforms = ['TikTok', 'Instagram'];
  if (!validPlatforms.includes(platform)) {
    return res.status(400).json({ message: 'Invalid platform.' });
  }
  if (!url) {
    return res.status(400).json({ message: 'Video URL is required.' });
  }
  try { new URL(url); } catch {
    return res.status(400).json({ message: 'Invalid URL format.' });
  }
  if (platform === 'TikTok' && !url.includes('tiktok.com')) {
    return res.status(400).json({ message: 'URL must be a TikTok link.' });
  }
  if (platform === 'Instagram' && !url.includes('instagram.com')) {
    return res.status(400).json({ message: 'URL must be an Instagram link.' });
  }

  // ── Cooldown check ──────────────────────────────────────────
  const last = cooldowns.get(ip);
  if (last) {
    const remaining = COOLDOWN_MS - (now - last);
    if (remaining > 0) {
      const mins = Math.ceil(remaining / 60000);
      return res.status(429).json({
        message: `You can place your next order in ${mins} minute${mins !== 1 ? 's' : ''}.`
      });
    }
  }

  // ── Register cooldown ───────────────────────────────────────
  cooldowns.set(ip, now);

  // ── Geo + device detection ──────────────────────────────────
  const [geo] = await Promise.all([getGeo(ip)]);
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const device   = isMobile ? '📱 Mobile' : '🖥️ Desktop';
  const location = [geo.country, geo.city].filter(Boolean).join(', ') || 'Unknown';
  const tz       = req.headers['x-timezone'] || 'Unknown';
  const ts       = new Date().toISOString();

  // ── Platform color ──────────────────────────────────────────
  const color = platform === 'TikTok' ? 0x69C9D0 : 0xBC1888;

  // ── Order webhook ───────────────────────────────────────────
  await sendWebhook(ORDER_WEBHOOK, {
    username: 'ViewFlow Orders',
    embeds: [{
      title: `🚀 New ${platform} Order`,
      color,
      fields: [
        { name: '📱 Platform', value: platform,    inline: true },
        { name: '👁️ Amount',   value: '100 views', inline: true },
        { name: '🔗 Video URL', value: url },
      ],
      footer: { text: `Submitted at ${new Date().toUTCString()}` },
      timestamp: ts,
    }],
  });

  // ── Log webhook ─────────────────────────────────────────────
  await sendWebhook(LOG_WEBHOOK, {
    username: 'ViewFlow Logs',
    embeds: [{
      title: '📊 Access Log',
      color: 0x5865F2,
      fields: [
        { name: '🌐 IP',        value: ip,          inline: true },
        { name: '🗺️ Location',  value: location,    inline: true },
        { name: '📡 ISP',       value: geo.isp || 'Unknown', inline: true },
        { name: '🖥️ Device',    value: device,      inline: true },
        { name: '⏰ Timezone',  value: tz,           inline: true },
        { name: '📱 Platform',  value: platform,    inline: true },
        { name: '🔍 User Agent', value: `\`${ua.slice(0, 120)}\`` },
      ],
      footer: { text: `Logged at ${new Date().toUTCString()}` },
      timestamp: ts,
    }],
  });

  // ── Respond ─────────────────────────────────────────────────
  return res.json({
    success: true,
    message: 'Your order will be delivered shortly. Orders are processed until your free credits are exhausted.',
  });
});

// ── Health ───────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'ViewFlow API' }));

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[ViewFlow] Running on http://localhost:${PORT}`));

module.exports = app;
