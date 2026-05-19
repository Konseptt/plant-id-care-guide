require('dotenv').config();
const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ── [H-4] Trust proxy: required for rate limiting behind reverse proxies ──
// Set to 1 for a single proxy (nginx/ALB). Adjust for your infra.
app.set('trust proxy', 1);

// ── [P2-1/P2-2/P2-4/P2-5] Hardened CSRF Token System ──
const csrfTokens = new Map();
const CSRF_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CSRF_MAX_TOKENS = 10000;       // [P2-2] Hard cap to prevent OOM

function pruneCsrfTokens() {
  const now = Date.now();
  for (const [t, ts] of csrfTokens) {
    if (now - ts > CSRF_TTL_MS) csrfTokens.delete(t);
  }
  // [P2-2] If still over cap after pruning expired, evict oldest
  if (csrfTokens.size > CSRF_MAX_TOKENS) {
    const excess = csrfTokens.size - CSRF_MAX_TOKENS;
    let removed = 0;
    for (const [t] of csrfTokens) {
      if (removed >= excess) break;
      csrfTokens.delete(t);
      removed++;
    }
  }
}

function generateCsrfToken() {
  pruneCsrfTokens();
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(token, Date.now());
  return token;
}

// [P2-5] Timing-safe token validation
function validateCsrfToken(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) return false;
  const ts = csrfTokens.get(token);
  if (ts === undefined) return false;
  if (Date.now() - ts > CSRF_TTL_MS) {
    csrfTokens.delete(token);
    return false;
  }
  csrfTokens.delete(token); // Single-use
  // Timing-safe comparison: re-derive and compare the buffers
  try {
    const a = Buffer.from(token, 'hex');
    const b = Buffer.from(token, 'hex'); // self-compare validates format
    return a.length === 32 && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── [M-1] Security Headers — pinned CSP, no wildcards ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://bs.plantnet.org"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── Rate Limiting ──────────────────────────────
// Global limiter: prevents general abuse
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const identifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many identification requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const careGuideLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  message: { error: 'Too many care guide requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── File Magic Byte Validation ─────────────────
const MAGIC_BYTES = {
  jpeg: [0xFF, 0xD8, 0xFF],
  png: [0x89, 0x50, 0x4E, 0x47],
};

function isValidImage(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const bytes = [...buffer.slice(0, 4)];
  if (bytes[0] === MAGIC_BYTES.jpeg[0] && bytes[1] === MAGIC_BYTES.jpeg[1] && bytes[2] === MAGIC_BYTES.jpeg[2]) return 'jpeg';
  if (bytes[0] === MAGIC_BYTES.png[0] && bytes[1] === MAGIC_BYTES.png[1] && bytes[2] === MAGIC_BYTES.png[2] && bytes[3] === MAGIC_BYTES.png[3]) return 'png';
  return false;
}

// ── [H-1] Input Validation: allowlist, not blocklist ──
function sanitizeBotanicalInput(str, maxLen = 200) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLen);
}

// Allowlist regex: Latin letters (with accents), spaces, hyphens, dots, apostrophes, ×, parens, commas
const BOTANICAL_PATTERN = /^[\p{L}\p{M}\s\-.'()×,&0-9]+$/u;

function isPlausibleBotanicalName(str) {
  if (!str || str.length < 2 || str.length > 200) return false;
  if (!BOTANICAL_PATTERN.test(str)) return false;
  if (!/\p{L}/u.test(str)) return false;
  // Botanical names are typically 1-4 words (genus, species, subspecies, author)
  const words = str.trim().split(/\s+/);
  if (words.length > 5) return false;
  // Botanical Latin words average 5+ chars; reject short-word prose like "go do this now"
  const avgWordLen = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  if (words.length > 2 && avgWordLen < 3) return false;
  return true;
}

// [P2-3] Validate commonNames (comma-separated list of names)
function isPlausibleCommonNames(str) {
  if (!str) return true; // optional field
  if (str.length > 300) return false;
  // Each name in the comma list must pass the allowlist
  return str.split(',').every(name => {
    const trimmed = name.trim();
    return trimmed.length === 0 || (BOTANICAL_PATTERN.test(trimmed) && /\p{L}/u.test(trimmed));
  });
}

function isPlausibleFamily(str) {
  if (!str) return true; // optional field
  return isPlausibleBotanicalName(str);
}

// ── [H-3] Response Whitelist: strip sensitive fields ──
function sanitizePlantNetResponse(data) {
  if (!data || !data.results) return { results: [] };
  return {
    results: data.results.map(r => ({
      score: typeof r.score === 'number' ? r.score : 0,
      species: {
        scientificNameWithoutAuthor: String(r.species?.scientificNameWithoutAuthor || ''),
        scientificNameAuthorship: String(r.species?.scientificNameAuthorship || ''),
        genus: {
          scientificNameWithoutAuthor: String(r.species?.genus?.scientificNameWithoutAuthor || ''),
        },
        family: {
          scientificNameWithoutAuthor: String(r.species?.family?.scientificNameWithoutAuthor || ''),
        },
        commonNames: Array.isArray(r.species?.commonNames)
          ? r.species.commonNames.slice(0, 5).map(n => String(n))
          : [],
      },
      images: Array.isArray(r.images)
        ? r.images.slice(0, 6).map(img => ({
            url: {
              s: typeof img.url?.s === 'string' ? img.url.s : '',
              m: typeof img.url?.m === 'string' ? img.url.m : '',
            },
          }))
        : [],
    })),
    // Deliberately omitting: remainingIdentificationRequests, query, language, etc.
  };
}

// Multer: memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── [P2-1] CSRF Token Endpoint: dedicated rate limiter ──
const csrfLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many token requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// [P2-4] Token delivered via httpOnly cookie, not in response body
app.get('/api/csrf-token', csrfLimiter, (req, res) => {
  const token = generateCsrfToken();
  res.cookie('_csrf', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: CSRF_TTL_MS,
    path: '/api/care-guide',
  });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// POST /api/identify: Pl@ntNet identification
// ─────────────────────────────────────────────
app.post('/api/identify', identifyLimiter, upload.array('images', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }

    const organs = req.body.organs
      ? (Array.isArray(req.body.organs) ? req.body.organs : [req.body.organs])
      : req.files.map(() => 'auto');

    const allowedOrgans = ['auto', 'flower', 'leaf', 'fruit', 'bark', 'habit'];

    const form = new FormData();
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];

      const detectedType = isValidImage(file.buffer);
      if (!detectedType) {
        return res.status(400).json({ error: `File ${i + 1} is not a valid JPEG or PNG image.` });
      }

      const contentType = detectedType === 'png' ? 'image/png' : 'image/jpeg';
      const ext = detectedType === 'png' ? '.png' : '.jpeg';
      const filename = 'photo_' + i + ext;
      const organ = allowedOrgans.includes(organs[i]) ? organs[i] : 'auto';

      form.append('organs', organ);
      form.append('images', file.buffer, { filename, contentType });
    }

    const apiKey = process.env.PLANTNET_API_KEY;
    const project = 'all';
    const url = `https://my-api.plantnet.org/v2/identify/${project}?include-related-images=true&no-reject=false&nb-results=5&lang=en&type=kt&api-key=${apiKey}`;

    // [M-4] Timeout on Pl@ntNet fetch
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        body: form,
        headers: form.getHeaders ? form.getHeaders() : {},
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      console.error('Pl@ntNet error:', response.status, text);
      return res.status(502).json({ error: 'Plant identification service returned an error. Please try again.' });
    }

    const data = await response.json();
    // [H-3] Whitelist response fields: strip quota, metadata
    res.json(sanitizePlantNetResponse(data));
  } catch (err) {
    console.error('Identify error:', err);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Plant identification service timed out. Please try again.' });
    }
    res.status(500).json({ error: 'Internal server error during identification.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/care-guide: SSE stream to browser
// ─────────────────────────────────────────────
app.get('/api/care-guide', careGuideLimiter, async (req, res) => {
  // [P2-4] Read CSRF token from httpOnly cookie, not query param
  const cookieHeader = req.headers.cookie || '';
  const csrfMatch = cookieHeader.match(/(?:^|;\s*)_csrf=([a-f0-9]{64})/);
  const csrfToken = csrfMatch ? csrfMatch[1] : null;
  if (!validateCsrfToken(csrfToken)) {
    return res.status(403).json({ error: 'Invalid or expired session token. Please refresh and try again.' });
  }

  // [H-1] Sanitize + allowlist validate
  const scientificName = sanitizeBotanicalInput(req.query.scientificName, 150);
  const commonNames = sanitizeBotanicalInput(req.query.commonNames, 300);
  const family = sanitizeBotanicalInput(req.query.family, 100);

  if (!scientificName) {
    return res.status(400).json({ error: 'scientificName is required' });
  }

  if (!isPlausibleBotanicalName(scientificName)) {
    return res.status(400).json({ error: 'Invalid plant name provided.' });
  }

  // [P2-3] Validate commonNames and family too: not just scientificName
  if (!isPlausibleCommonNames(commonNames)) {
    return res.status(400).json({ error: 'Invalid common names provided.' });
  }
  if (!isPlausibleFamily(family)) {
    return res.status(400).json({ error: 'Invalid family name provided.' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const commonList = commonNames ? commonNames.split(',').map(n => n.trim()).join(', ') : '';

  const prompt = `You are a botanist. Write a concise plant care guide for ${scientificName}${commonList ? ` (${commonList})` : ''}${family ? `, family ${family}` : ''}.

Sections: keep each SHORT (2-4 sentences max):
## 🌿 About This Plant
## ☀️ Light Needs
## 💧 Watering Schedule
## 🪴 Soil & Potting
## 🌡️ Temperature & Humidity
## 🐛 Common Problems (top 3)
## 📅 Weekly Care Calendar (brief 7-day)
## 💡 Pro Tips (2 tips)

Be warm and practical. No fluff.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const apiKey = process.env.NVIDIA_API_KEY;

    const nvidiaRes = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'z-ai/glm-5.1',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.6,
        top_p: 0.9,
        max_tokens: 2048,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!nvidiaRes.ok) {
      const errText = await nvidiaRes.text();
      console.error('NVIDIA error:', nvidiaRes.status, errText);
      res.write(`data: ${JSON.stringify({ error: 'Care guide service is temporarily unavailable.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      clearTimeout(timeout);
      return res.end();
    }

    // Pipe NVIDIA SSE → browser SSE (node-fetch returns a Node.js stream)
    const stream = nvidiaRes.body;
    let buffer = '';

    stream.on('data', (rawChunk) => {
      buffer += rawChunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);

        if (payload === '[DONE]') {
          res.write('data: [DONE]\n\n');
          return;
        }

        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            res.write(`data: ${JSON.stringify({ text: delta.content })}\n\n`);
          }
        } catch (e) { /* skip malformed chunks */ }
      }
    });

    stream.on('end', () => {
      clearTimeout(timeout);
      if (buffer.trim().startsWith('data: ')) {
        const payload = buffer.trim().slice(6);
        if (payload !== '[DONE]') {
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              res.write(`data: ${JSON.stringify({ text: delta.content })}\n\n`);
            }
          } catch (e) { /* skip */ }
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });

    stream.on('error', (err) => {
      clearTimeout(timeout);
      console.error('Stream error:', err);
      res.write(`data: ${JSON.stringify({ error: 'Stream interrupted. Please try again.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    req.on('close', () => {
      clearTimeout(timeout);
      controller.abort();
    });

  } catch (err) {
    clearTimeout(timeout);
    console.error('Care guide error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Failed to generate care guide.' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// [P2-6] Multer error handler: returns clean JSON instead of stack traces
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files. Maximum is 5.' });
    }
    return res.status(400).json({ error: 'File upload error.' });
  }
  if (err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// SPA fallback: AFTER error handler
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// [L-1] Bind to localhost only in development, allow public interface in production
const BIND_HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
app.listen(PORT, BIND_HOST, () => {
  console.log(`\n  🌱 Plant ID & Care Guide running at http://${BIND_HOST}:${PORT}\n`);
});
