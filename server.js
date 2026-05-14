// Gemini TTS Streaming Proxy — Node.js
// Modo LIVE (WebSocket) para streaming real de áudio com TTFB baixo.
// Fallback para streamGenerateContent (HTTP SSE).

require('dotenv').config();

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const WebSocket = require('ws');

// ─── Configuração ───────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3100');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || 'Kore';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gemini-2.5-flash-preview-tts';
const LIVE_MODEL = process.env.LIVE_MODEL || 'gemini-2.0-flash-live-001';
const LIVE_SYSTEM = 'Você é um leitor de texto. Leia o texto do usuário em voz alta, exatamente como escrito, sem comentários adicionais.';
const GEMINI_MODE = process.env.GEMINI_MODE || 'stream'; // 'live' ou 'stream'
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
  console.error('Nenhuma API key configurada.');
  process.exit(1);
}
console.log(`[init] ${keys.length} API key(s), modo: ${GEMINI_MODE}`);

// ─── Vozes OpenAI → Gemini ──────────────────────────────────
const voiceMap = {
  alloy: 'Kore', echo: 'Charon', fable: 'Puck',
  onyx: 'Enceladus', nova: 'Zephyr', shimmer: 'Sulafat',
};

// ─── HTTPS Agent com keep-alive ─────────────────────────────
const agent = new https.Agent({
  keepAlive: true, keepAliveMsecs: 30000,
  maxSockets: 20, maxFreeSockets: 5,
});

// ─── Cache: memória + disco (persiste entre reinícios) ──────
const fs = require('fs');
const path = require('path');
// Cache FORA da pasta de deploy pra sobreviver a re-deploys
const CACHE_DIR = process.env.CACHE_DIR || path.join(require('os').homedir(), '.gemini-tts-cache');
const memCache = new Map();

// Cria pasta de cache na inicialização
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
console.log(`[init] Cache dir: ${CACHE_DIR}`);

// Normaliza texto pra evitar cache miss por diferença de espaço/quebra de linha
function normalizeText(text) {
  return text.trim().replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
}

function cacheKey(text, voice, model) {
  return crypto.createHash('md5').update(`${normalizeText(text)}|${voice}|${model}`).digest('hex');
}

function cachePath(key) {
  const sub = path.join(CACHE_DIR, key.slice(0, 2));
  try { fs.mkdirSync(sub, { recursive: true }); } catch {}
  return path.join(sub, key + '.pcm');
}

function cacheGet(key) {
  // Tenta memória primeiro
  const e = memCache.get(key);
  if (e) {
    if (Date.now() - e.ts > CACHE_TTL_MS) { memCache.delete(key); }
    else { memCache.delete(key); memCache.set(key, e); return e.pcm; }
  }
  // Tenta disco
  const fp = cachePath(key);
  try {
    const stat = fs.statSync(fp);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) { fs.unlinkSync(fp); return null; }
    const pcm = fs.readFileSync(fp);
    console.log(`[disk-cache hit] ${key.slice(0, 8)}... ${pcm.length}b`);
    // Promove pra memória
    if (memCache.size >= MAX_CACHE_ENTRIES) memCache.delete(memCache.keys().next().value);
    memCache.set(key, { pcm, ts: stat.mtimeMs });
    return pcm;
  } catch { return null; }
}

function cacheSet(key, pcm) {
  // Salva em memória
  if (memCache.size >= MAX_CACHE_ENTRIES) memCache.delete(memCache.keys().next().value);
  memCache.set(key, { pcm, ts: Date.now() });
  // Salva em disco (async, não bloqueia)
  const fp = cachePath(key);
  fs.writeFile(fp, pcm, (err) => {
    if (err) console.log(`[cache-write err] ${err.message}`);
    else console.log(`[disk-cache set] ${key.slice(0, 8)}... ${pcm.length}b`);
  });
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

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ═══════════════════════════════════════════════════════════════
// MODO LIVE — WebSocket para streaming real de áudio
// ═══════════════════════════════════════════════════════════════

function synthesizeLive(text, voice, apiKey, httpRes, format) {
  return new Promise((resolve, reject) => {
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    const ws = new WebSocket(wsUrl);

    const chunks = [];
    let headerSent = false;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch {}
        reject({ code: 504, body: 'Timeout (60s)' });
      }
    }, 60000);

    function finish(err) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      if (err) return reject(err);
      if (chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject({ code: 502, body: 'Resposta sem áudio' });
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        setup: {
          model: `models/${LIVE_MODEL}`,
          systemInstruction: {
            parts: [{ text: LIVE_SYSTEM }]
          },
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice }
              }
            }
          }
        }
      }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Debug: loga as mensagens do WebSocket
      const keys = Object.keys(msg);
      console.log(`[live-ws] msg keys: ${keys.join(', ')}`);
      if (msg.serverContent?.modelTurn?.parts) {
        const partTypes = msg.serverContent.modelTurn.parts.map(p => p.inlineData ? 'audio' : p.text ? 'text' : 'unknown');
        console.log(`[live-ws] parts: ${partTypes.join(', ')}`);
      }

      if (msg.setupComplete) {
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete: true
          }
        }));
        return;
      }

      if (msg.serverContent) {
        const parts = msg.serverContent.modelTurn?.parts || [];
        for (const part of parts) {
          const b64 = part.inlineData?.data;
          if (!b64) continue;
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

        if (msg.serverContent.turnComplete) finish(null);
      }
    });

    ws.on('error', (err) => finish({ code: 500, body: err.message }));
    ws.on('close', () => finish(null));
  });
}

// ═══════════════════════════════════════════════════════════════
// MODO STREAM — HTTP SSE (streamGenerateContent) — fallback
// ═══════════════════════════════════════════════════════════════

function synthesizeStream(text, voice, model, apiKey, httpRes, format) {
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
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      agent, timeout: 60000,
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

      function processSSE(block) {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6).trim();
          if (d === '[DONE]') continue;
          try {
            const j = JSON.parse(d);
            const b64 = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (!b64) continue;
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
          } catch {}
        }
      }

      res.on('data', (raw) => {
        sseBuf += raw.toString();
        const parts = sseBuf.split('\n\n');
        sseBuf = parts.pop();
        for (const part of parts) processSSE(part);
      });

      res.on('end', () => {
        if (sseBuf.trim()) processSSE(sseBuf);
        if (chunks.length > 0) resolve(Buffer.concat(chunks));
        else reject({ code: 502, body: 'Resposta sem áudio' });
      });

      res.on('error', e => reject({ code: 500, body: e.message }));
    });

    req.on('error', e => reject({ code: 500, body: e.message }));
    req.on('timeout', () => { req.destroy(); reject({ code: 504, body: 'Timeout' }); });
    req.write(payload);
    req.end();
  });
}

// ─── Tenta sintetizar com um modelo específico ─────────────
async function tryModel(text, voice, model, httpRes, format) {
  const start = hashCode(text) % keys.length;
  let lastErr = '';

  for (let retry = 0; retry <= 2; retry++) {
    let all429 = true;
    for (let i = 0; i < keys.length; i++) {
      const idx = (start + i) % keys.length;
      try {
        const t0 = Date.now();
        let pcm;
        if (GEMINI_MODE === 'live') {
          pcm = await synthesizeLive(text, voice, keys[idx], httpRes, format);
        } else {
          pcm = await synthesizeStream(text, voice, model, keys[idx], httpRes, format);
        }
        console.log(`[synth] ${Date.now() - t0}ms, key#${idx}, ${pcm.length}b, model=${model}`);
        return pcm;
      } catch (err) {
        lastErr = err.body || err.message || String(err);
        if (httpRes.headersSent) throw err;
        if (err.code === 429) { console.log(`[429] key#${idx} model=${model}`); continue; }
        if (err.code === 403) { console.log(`[403] key#${idx}`); all429 = false; continue; }
        all429 = false;
        console.log(`[err] key#${idx}: ${lastErr.slice(0, 100)}`);
      }
    }
    if (all429 && retry < 2) {
      console.log(`[retry] Todas 429 em ${model}, aguardando 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    } else break;
  }
  throw { code: 429, body: lastErr };
}

// ─── Modelo fallback quando TTS esgota quota ────────────────
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || 'gemini-2.0-flash';

async function synthesize(text, voice, model, httpRes, format) {
  const effectiveModel = GEMINI_MODE === 'live' ? LIVE_MODEL : model;

  // Tenta cache do modelo principal
  const key1 = cacheKey(text, voice, effectiveModel);
  const cached1 = cacheGet(key1);
  if (cached1) {
    console.log(`[CACHE HIT] "${normalizeText(text).slice(0, 60)}" → ${cached1.length}b`);
    const hdr = { 'X-Cache': 'HIT', 'X-Model': effectiveModel };
    if (format === 'pcm') {
      httpRes.writeHead(200, { 'Content-Type': 'audio/pcm', 'Content-Length': cached1.length, ...hdr });
      httpRes.end(cached1);
    } else {
      const wav = Buffer.concat([wavHeader(cached1.length), cached1]);
      httpRes.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, ...hdr });
      httpRes.end(wav);
    }
    return;
  }

  // Tenta cache do fallback
  const key2 = cacheKey(text, voice, FALLBACK_MODEL);
  const cached2 = cacheGet(key2);
  if (cached2) {
    console.log(`[CACHE HIT fallback] "${normalizeText(text).slice(0, 60)}" → ${cached2.length}b`);
    const hdr = { 'X-Cache': 'HIT', 'X-Model': FALLBACK_MODEL };
    if (format === 'pcm') {
      httpRes.writeHead(200, { 'Content-Type': 'audio/pcm', 'Content-Length': cached2.length, ...hdr });
      httpRes.end(cached2);
    } else {
      const wav = Buffer.concat([wavHeader(cached2.length), cached2]);
      httpRes.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, ...hdr });
      httpRes.end(wav);
    }
    return;
  }

  console.log(`[CACHE MISS] "${normalizeText(text).slice(0, 60)}"`);

  // Tenta modelo principal
  let pcm, usedModel;
  try {
    pcm = await tryModel(text, voice, effectiveModel, httpRes, format);
    usedModel = effectiveModel;
  } catch (err) {
    if (httpRes.headersSent) { httpRes.end(); return; }
    // Fallback para gemini-2.0-flash
    if (effectiveModel !== FALLBACK_MODEL) {
      console.log(`[fallback] ${effectiveModel} esgotado, tentando ${FALLBACK_MODEL}...`);
      try {
        pcm = await tryModel(text, voice, FALLBACK_MODEL, httpRes, format);
        usedModel = FALLBACK_MODEL;
      } catch (err2) {
        if (!httpRes.headersSent) {
          httpRes.writeHead(502, { 'Content-Type': 'application/json' });
          httpRes.end(JSON.stringify({ error: `Falha em ambos modelos. ${err2.body || err2.message}` }));
        }
        return;
      }
    } else {
      if (!httpRes.headersSent) {
        httpRes.writeHead(502, { 'Content-Type': 'application/json' });
        httpRes.end(JSON.stringify({ error: `Falha: ${err.body || err.message}` }));
      }
      return;
    }
  }

  // Cacheia e finaliza
  const ckey = cacheKey(text, voice, usedModel);
  cacheSet(ckey, pcm);
  if (!httpRes.writableEnded) httpRes.end();
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

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', mode: GEMINI_MODE, keys: keys.length, memCached: memCache.size }));
  }

  if (req.method === 'GET' && path === '/v1/voices') {
    const voices = [
      'Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede',
      'Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba',
      'Despina','Erinome','Gacrux','Laomedeia','Pulcherrima','Sulafat',
      'Vindemiatrix','Sadachbia','Sadaltager','Schedar','Zubenelgenubi',
      'Zubeneschamali','Achernar','Rasalgethi','Alnilam','Sirius',
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ voices: voices.map(v => ({ name: v, voice_id: v })) }));
  }

  if (AUTH_TOKEN) {
    const hdr = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const qry = url.searchParams.get('token') || '';
    if (hdr !== AUTH_TOKEN && qry !== AUTH_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Token inválido' }));
    }
  }

  try {
    const rawBody = await readBody(req);
    const ct = req.headers['content-type'] || '';
    let data = {};
    if (ct.includes('application/json')) { try { data = JSON.parse(rawBody); } catch {} }
    else if (rawBody.includes('=') && rawBody.includes('&')) { data = Object.fromEntries(new URLSearchParams(rawBody)); }

    let text = data.input || url.searchParams.get('input') || url.searchParams.get('text') || '';
    if (!text && rawBody && !rawBody.includes('{') && !(rawBody.includes('=') && rawBody.includes('&'))) text = rawBody;

    if (!text.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Texto vazio' }));
    }

    const voiceKey = data.voice || url.searchParams.get('voice') || DEFAULT_VOICE;
    const voice = voiceMap[voiceKey] || voiceKey;
    const modelHint = data.model || url.searchParams.get('model') || '';
    const format = data.response_format || url.searchParams.get('format') || 'wav';

    let model = DEFAULT_MODEL;
    if (modelHint.includes('pro') || modelHint.includes('hd')) model = 'gemini-2.5-pro-preview-tts';

    await synthesize(text, voice, model, res, format);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[init] Gemini TTS proxy em http://localhost:${PORT}`);
  console.log(`[init] Modo: ${GEMINI_MODE} | Modelo: ${GEMINI_MODE === 'live' ? LIVE_MODEL : DEFAULT_MODEL} | Voz: ${DEFAULT_VOICE}`);
});

process.on('SIGTERM', () => { server.close(); agent.destroy(); });
process.on('SIGINT', () => { server.close(); agent.destroy(); process.exit(0); });
