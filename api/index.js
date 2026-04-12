// ─── /api/index.js — Vercel Serverless Function ──────────────────────────────
// Handles: platform detection, rate limiting (in-memory), SMM Panel API call

// ── In-memory rate limit store ────────────────────────────────────────────────
// Structure: { "ip": { count: number, firstOrderAt: timestamp } }
// NOTE: In-memory resets on cold starts. For persistent limits across all
//       serverless instances, swap this with Upstash Redis (see instructions).
const rateLimitStore = {};

const MAX_ORDERS   = 2;          // max orders per window
const WINDOW_MS    = 24 * 60 * 60 * 1000; // 24 hours in ms

// ── Platform → service ID map ─────────────────────────────────────────────────
const PLATFORM_MAP = {
  'tiktok.com':    3067,
  'instagram.com': 1370,
};

// ── SMM Panel API ─────────────────────────────────────────────────────────────
const SMM_API_URL = 'https://cheapestsmmpanels.com/api/v2';

// ── Helper: get real client IP ────────────────────────────────────────────────
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for can be a comma-separated list; take the first (client IP)
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ── Helper: detect platform from URL ─────────────────────────────────────────
function detectPlatform(url) {
  for (const [domain, serviceId] of Object.entries(PLATFORM_MAP)) {
    if (url.includes(domain)) return { domain, serviceId };
  }
  return null;
}

// ── Helper: check & update rate limit ────────────────────────────────────────
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore[ip];

  if (!entry) {
    // First order from this IP
    rateLimitStore[ip] = { count: 1, firstOrderAt: now };
    return { allowed: true, remaining: MAX_ORDERS - 1 };
  }

  const elapsed = now - entry.firstOrderAt;

  if (elapsed > WINDOW_MS) {
    // Window expired — reset
    rateLimitStore[ip] = { count: 1, firstOrderAt: now };
    return { allowed: true, remaining: MAX_ORDERS - 1 };
  }

  if (entry.count >= MAX_ORDERS) {
    // Within window and limit hit
    const resetInMs  = WINDOW_MS - elapsed;
    const resetInHrs = Math.ceil(resetInMs / (1000 * 60 * 60));
    return {
      allowed: false,
      message: `Daily limit reached. You can place orders again in ~${resetInHrs} hour${resetInHrs !== 1 ? 's' : ''}.`,
    };
  }

  // Within window, still has quota
  entry.count += 1;
  return { allowed: true, remaining: MAX_ORDERS - entry.count };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // ── CORS headers (adjust origin in production if needed) ──────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // ── Only allow POST ────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed.' });
  }

  // ── Route guard: only /api/order is valid ──────────────────────────────────
  const pathname = req.url?.split('?')[0];
  if (pathname !== '/api/order') {
    return res.status(404).json({ success: false, message: 'Not found.' });
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  const { url } = req.body || {};

  // ── Validate URL presence ──────────────────────────────────────────────────
  if (!url || typeof url !== 'string' || url.trim() === '') {
    return res.status(400).json({ success: false, message: 'A video URL is required.' });
  }

  const trimmedUrl = url.trim();

  // ── Validate URL format ────────────────────────────────────────────────────
  try {
    new URL(trimmedUrl);
  } catch {
    return res.status(400).json({ success: false, message: 'Please enter a valid URL (include https://).' });
  }

  // ── Detect platform ────────────────────────────────────────────────────────
  const platform = detectPlatform(trimmedUrl);
  if (!platform) {
    return res.status(400).json({
      success: false,
      message: 'Unsupported platform. Only TikTok and Instagram URLs are accepted.',
    });
  }

  // ── Rate limit check ───────────────────────────────────────────────────────
  const ip = getClientIP(req);
  const limit = checkRateLimit(ip);

  if (!limit.allowed) {
    return res.status(429).json({ success: false, message: limit.message });
  }

  // ── SMM Panel API key ──────────────────────────────────────────────────────
  const SMM_API_KEY = process.env.SMM_API_KEY;
  if (!SMM_API_KEY) {
    console.error('SMM_API_KEY environment variable is not set.');
    return res.status(500).json({ success: false, message: 'Server configuration error. Please contact support.' });
  }

  // ── Call SMM Panel API ─────────────────────────────────────────────────────
  try {
    const smmRes = await fetch(SMM_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key:      SMM_API_KEY,
        action:   'add',
        service:  platform.serviceId,
        link:     trimmedUrl,
        quantity: 100,          // always 100
      }),
    });

    let smmData;
    try {
      smmData = await smmRes.json();
    } catch {
      throw new Error('Invalid response from SMM provider.');
    }

    // SMM panel returns { order: <id> } on success, or { error: "..." } on failure
    if (smmData.error) {
      console.error('SMM API error:', smmData.error);
      return res.status(502).json({
        success: false,
        message: 'Order provider error. Please try again later.',
      });
    }

    if (!smmData.order) {
      console.error('SMM API unexpected response:', smmData);
      return res.status(502).json({
        success: false,
        message: 'Unexpected response from order provider. Please try again.',
      });
    }

    // ── Success ──────────────────────────────────────────────────────────────
    return res.status(200).json({
      success:  true,
      message:  'Order placed successfully! Views will be delivered within 12 hours.',
      orderId:  smmData.order,
      remaining: limit.remaining,
    });

  } catch (err) {
    console.error('SMM fetch error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to reach the order provider. Please try again.',
    });
  }
}
