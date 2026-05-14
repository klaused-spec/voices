// Gemini TTS Streaming Proxy — Node.js
// Usa streamGenerateContent (SSE) para reduzir TTFB e delay entre parágrafos.
// Cache em memória + connection pooling + key rotation.

require('dotenv').config();

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

// ─── Configuração ───────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3100');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || 'Kore';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gemini-2.5-flash-preview-tts';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL || String(86400 * 7)) * 1000;
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '500');

// ─── Pool de API keys ───────────────────────────────────────
const apiKeys = [];
if (process.env.GEMINI_API_KEY) apiKeys.push(process.env.GEMINI_API_KEY);
for (let i = 1; i <= 10; i++) {
  const k = process.env[`GEMINI_KEY_${i}`];
  if (k) apiKeys.push(k);
}
const keys = [...new Set(apiKeys)];
if (keys.length === 0) {
  console.error('Nenhuma API key configurada. Defina GEMINI_API_KEY ou GEMINI_KEY_1..10 no .env');
  process.exit(1);
}
console.log(`[init] ${keys.length} API key(s) carregada(s)`);

// ─── Vozes OpenAI → Gemini ──────────────────────────────────
const voiceMap = {
  alloy: 'Kore', echo: 'Charon', fable: 'Puck',
  onyx: 'Enceladus', nova: 'Zephyr', shimmer: 'Sulafat',
};

// ─── HTTPS Agent com keep-alive (reutiliza conexão TLS) ─────
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 20,
  maxFreeSockets: 5,
});

// ─── Cache LRU em memória ───────────────────────────────────
const cache = new Map();

function ck(text, voice, model) {
  return crypto.createHash('md5').update(`${text}|${voice}|${model}`).digest('hex');
}

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  cache.delete(key); cache.set(key, e); // LRU bump
  return e.pcm;
}

function cacheSet(key, pcm) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { pcm, ts: Date.now() });
}

// ─── WAV header ─────────────────────────────────────────────
function wavHeader(pcmSize) {
  const sr = 24000, bps = 16, ch = 1;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcmSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * bps / 8, 28);
  buf.writeUInt16LE(ch * bps / 8, 32);
  buf.writeUInt16LE(bps, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcmSize, 40);
  return buf;
}

// ─── Hash simples para round-robin ──────────────────────────
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ─── Streaming do Gemini via SSE ────────────────────────────
// Retorna { pcm: Buffer } e escreve chunks no httpRes conforme chegam
function streamFromGemini(text, voice, model, apiKey, httpRes, format) {
  return new Promise((resolve, reject) => {
    const u = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
    );
    const payload = Buffer.from(JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
        }
      }
    }), 'utf8');

    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      agent,
      timeout: 60000,
    }, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => reject({ code: res.statusCode, body }));
        return;
      }

      const chunks = [];
      let headerSent = false;
      let sseBuf = '';

      res.on('data', (raw) => {
        sseBuf += raw.toString();
        const parts = sseBuf.split('\n\n');
        sseBuf = parts.pop(); // fragmento incompleto

        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const d = line.slice(6).trim();
            if (d === '[DONE]') continue;
            try {
              const j = JSON.parse(d);
              const b64 = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
              if (!b64) continue;
              const pcm = Buffer.from(b64, 'base64');
              chunks.push(pcm);

              // Streaming: envia o chunk pro cliente assim que chega
              if (httpRes && !httpRes.writableEnded) {
                if (!headerSent) {
                  if (format === 'pcm') {
                    httpRes.writeHead(200, { 'Content-Type': 'audio/pcm' });
                  } else {
                    // WAV header com tamanho grande — cliente lê até EOF
                    httpRes.writeHead(200, { 'Content-Type': 'audio/wav' });
                    httpRes.write(wavHeader(0x7FFFFF00));
                  }
                  headerSent = true;
                }
                httpRes.write(pcm);
              }
            } catch { /* ignora JSON malformado */ }
          }
        }
      });

      res.on('end', () => {
        // Processa resto do buffer SSE
        if (sseBuf.trim()) {
          for (const line of sseBuf.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const d = line.slice(6).trim();
            if (d === '[DONE]') continue;
            try {
              const j = JSON.parse(d);
              const b64 = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
              if (b64) {
                const pcm = Buffer.from(b64, 'base64');
                chunks.push(pcm);
                if (httpRes && !httpRes.writableEnded) {
                  if (!headerSent) {
                    if (format === 'pcm') {
                      httpRes.writeHead(200, { 'Content-Type': 'audio/pcm' });
                    } else {
                      httpRes.writeHead(200, { 'Content-Type': 'audio/wav' });
                      httpRes.write(wavHeader(0x7FFFFF00));
                    }
                    headerSent = true;
                  }
                  httpRes.write(pcm);
                }
              }
            } catch {}
          }
        }

        if (chunks.length === 0) {
          reject({ code: 502, body: 'Resposta sem áudio' });
        } else {
          resolve(Buffer.concat(chunks));
        }
      });

      res.on('error', e => reject({ code: 500, body: e.message }));
    });

    req.on('error', e => reject({ code: 500, body: e.message }));
    req.on('timeout', () => { req.destroy(); reject({ code: 504, body: 'Timeout' }); });
    req.write(payload);
    req.end();
  });
}

// ─── Síntese com fallback de keys e cache ───────────────────
async function synthesize(text, voice, model, httpRes, format) {
  const key = ck(text, voice, model);
  const cached = cacheGet(key);
  if (cached) {
    console.log(`[cache hit] ${text.slice(0, 40)}...`);
    if (format === 'pcm') {
      httpRes.writeHead(200, { 'Content-Type': 'audio/pcm', 'Content-Length': cached.length });
      httpRes.end(cached);
    } else {
      const wav = Buffer.concat([wavHeader(cached.length), cached]);
      httpRes.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      httpRes.end(wav);
    }
    return;
  }

  const start = hashCode(text) % keys.length;
  let lastErr = '';

  for (let retry = 0; retry <= 2; retry++) {
    let all429 = true;
    for (let i = 0; i < keys.length; i++) {
      const idx = (start + i) % keys.length;
      try {
        const t0 = Date.now();
        const pcm = await streamFromGemini(text, voice, model, keys[idx], httpRes, format);
        console.log(`[synth] ${Date.now() - t0}ms, key#${idx}, ${pcm.length}b, "${text.slice(0, 40)}..."`);
        cacheSet(key, pcm);
        // Streaming já escreveu no httpRes — só finaliza
        if (!httpRes.writableEnded) httpRes.end();
        return;
      } catch (err) {
        lastErr = err.body || err.message || String(err);
        if (httpRes.headersSent) {
          // Já começou a enviar, não dá pra retry
          httpRes.end();
          return;
        }
        if (err.code === 429) { console.log(`[429] key#${idx}`); continue; }
        if (err.code === 403) { console.log(`[403] key#${idx}`); all429 = false; continue; }
        all429 = false;
      }
    }
    if (all429 && retry < 2) {
      console.log(`[retry] Todas 429, aguardando 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    } else {
      break;
    }
  }

  if (!httpRes.headersSent) {
    httpRes.writeHead(502, { 'Content-Type': 'application/json' });
    httpRes.end(JSON.stringify({ error: `Falha após tentar todas as keys. ${lastErr}` }));
  }
}

// ─── Leitura do body HTTP ───────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const bufs = [];
    req.on('data', c => bufs.push(c));
    req.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── Servidor HTTP ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', keys: keys.length, cached: cache.size }));
    return;
  }

  // Lista de vozes
  if (req.method === 'GET' && path === '/v1/voices') {
    const voices = [
      'Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede',
      'Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba',
      'Despina','Erinome','Gacrux','Laomedeia','Pulcherrima','Sulafat',
      'Vindemiatrix','Sadachbia','Sadaltager','Schedar','Zubenelgenubi',
      'Zubeneschamali','Achernar','Rasalgethi','Alnilam','Sirius',
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ voices: voices.map(v => ({ name: v, voice_id: v })) }));
    return;
  }

  // ─── Autenticação ─────────────────────────────────────────
  if (AUTH_TOKEN) {
    const hdr = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const qry = url.searchParams.get('token') || '';
    if (hdr !== AUTH_TOKEN && qry !== AUTH_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token inválido' }));
      return;
    }
  }

  // ─── Leitura dos parâmetros ───────────────────────────────
  try {
    const rawBody = await readBody(req);
    const ct = req.headers['content-type'] || '';
    let data = {};

    if (ct.includes('application/json')) {
      try { data = JSON.parse(rawBody); } catch {}
    } else if (rawBody.includes('=') && rawBody.includes('&')) {
      data = Object.fromEntries(new URLSearchParams(rawBody));
    }

    let text = data.input || url.searchParams.get('input') || url.searchParams.get('text') || '';
    if (!text && rawBody && !rawBody.includes('{') && !(rawBody.includes('=') && rawBody.includes('&'))) {
      text = rawBody;
    }

    if (!text.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Texto vazio' }));
      return;
    }

    const voiceKey = data.voice || url.searchParams.get('voice') || DEFAULT_VOICE;
    const voice = voiceMap[voiceKey] || voiceKey;
    const modelHint = data.model || url.searchParams.get('model') || '';
    const format = data.response_format || url.searchParams.get('format') || 'wav';

    let model = DEFAULT_MODEL;
    if (modelHint.includes('pro') || modelHint.includes('hd')) {
      model = 'gemini-2.5-pro-preview-tts';
    }

    await synthesize(text, voice, model, res, format);

  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[init] Gemini TTS streaming proxy em http://localhost:${PORT}`);
  console.log(`[init] Modelo padrão: ${DEFAULT_MODEL}`);
  console.log(`[init] Voz padrão: ${DEFAULT_VOICE}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); agent.destroy(); });
process.on('SIGINT', () => { server.close(); agent.destroy(); process.exit(0); });
