// ======================================================
// IAvatar · Mini-backend de IA + voz (Piper local)
// ======================================================
// - POST /api/chat  { mensaje, historial? } -> { respuesta }
// - GET  /api/health, GET /api/config, PUT /api/config
// - GET  /api/ollama/models (lista modelos locales)
// - POST /api/tts   { texto } -> audio/wav (voz local)
// - GET  /api/tts/voices (voces instaladas en server/voices)
//
// Proveedores: "ollama" (local, gratis) y "openai"
// (cualquier API compatible OpenAI: OpenAI, Azure,
// OpenRouter, LM Studio...).
//
// Arranque:  npm run server   (puerto 3001 por defecto)
// Config:    server/.env (ver .env.example) o variables
//            de entorno. Se puede cambiar proveedor y
//            modelo en caliente con PUT /api/config.

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickDefaultOllamaModel } from './model-picker.mjs';
import { listVoices, synthesize, encodeWav } from './tts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- .env mínimo (sin dependencias) ----------

function loadDotEnv(path) {

    if (!existsSync(path)) {
        return;
    }

    const text = readFileSync(path, 'utf8');

    for (const line of text.split('\n')) {

        const clean = line.trim();

        if (!clean || clean.startsWith('#')) {
            continue;
        }

        const eq = clean.indexOf('=');

        if (eq < 0) {
            continue;
        }

        const key = clean.slice(0, eq).trim();
        let value = clean.slice(eq + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        if (!(key in process.env)) {
            process.env[key] = value;
        }
    }
}

loadDotEnv(join(__dirname, '.env'));

// ---------- Config ----------

const config = {
    provider: process.env.PROVIDER || 'ollama',
    ollamaUrl: (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1',
    openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    systemPrompt:
        process.env.SYSTEM_PROMPT ||
        'Soy Paseta, la colega virtual que lo sabe casi todo. Respondo en español, de forma breve, clara y amable. Máximo 3 frases salvo que me pidan más detalle. ' +
        'Si el usuario incluye un emoticono o emoji, no lo explico ni lo describo nunca: respondo con naturalidad y, si encaja, pongo UN emoji al final. ' +
        'Nunca escribo acciones entre asteriscos (nada de *sonrío*) ni explico qué significa cada emoticono.',
    avatarName: process.env.AVATAR_NAME || 'Paseta',
    ttsVoice: process.env.TTS_VOICE || 'sharvard-medium',
    ttsSpeaker: Number(process.env.TTS_SPEAKER || 1)
};

const PORT = Number(process.env.PORT || 3001);

function currentModel() {
    return config.provider === 'ollama'
        ? config.ollamaModel
        : config.openaiModel;
}

function publicConfig() {
    return {
        provider: config.provider,
        model: currentModel(),
        ollamaUrl: config.ollamaUrl,
        ollamaModel: config.ollamaModel,
        openaiBaseUrl: config.openaiBaseUrl,
        openaiModel: config.openaiModel,
        openaiKeyPresent: Boolean(config.openaiApiKey),
        avatarName: config.avatarName,
        ttsVoice: config.ttsVoice,
        ttsSpeaker: config.ttsSpeaker
    };
}

// ---------- Avatares ----------
// Escanea public/models (dev) y dist/models (build) y
// devuelve [{ file, label }]. Así basta con copiar un
// .vrm nuevo a public/models para que aparezca en el
// desplegable, sin tocar código.

function prettifyAvatarLabel(file) {

    const base = String(file).replace(/\.vrm$/i, '');

    const sample = base.match(/^avatarsample[_-](.+)$/i);

    if (sample) {
        return `Avatar ${sample[1].replace(/[_-]+/g, ' ').trim()}`;
    }

    return base.replace(/[_-]+/g, ' ').trim() || file;
}

function listAvatars() {

    const dirs = [
        join(__dirname, '..', 'public', 'models'),
        join(__dirname, '..', 'dist', 'models')
    ];

    const seen = new Set();
    const out = [];

    for (const dir of dirs) {

        let entries;

        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {

            if (!entry.isFile()) {
                continue;
            }

            if (!/\.vrm$/i.test(entry.name)) {
                continue;
            }

            if (seen.has(entry.name)) {
                continue;
            }

            seen.add(entry.name);
            out.push({ file: entry.name, label: prettifyAvatarLabel(entry.name) });
        }
    }

    out.sort((a, b) => a.file.localeCompare(b.file, 'es'));

    return out;
}

// ---------- HTTP helpers ----------

function sendJson(res, status, data) {

    const body = JSON.stringify(data);

    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Length': Buffer.byteLength(body)
    });

    res.end(body);
}

function readJson(req, limit = 1024 * 1024) {

    return new Promise((resolve, reject) => {

        let size = 0;
        const chunks = [];

        req.on('data', (chunk) => {

            size += chunk.length;

            if (size > limit) {
                reject(new Error('Cuerpo demasiado grande'));
                req.destroy();
                return;
            }

            chunks.push(chunk);
        });

        req.on('end', () => {

            if (!chunks.length) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new Error('JSON no válido'));
            }
        });

        req.on('error', reject);
    });
}

async function fetchWithTimeout(url, options = {}, ms = 120000) {

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ---------- Proveedores ----------

function buildMessages(mensaje, historial) {

    const messages = [{ role: 'system', content: config.systemPrompt }];

    if (Array.isArray(historial)) {
        for (const m of historial.slice(-12)) {
            if (
                m &&
                (m.role === 'user' || m.role === 'assistant') &&
                typeof m.content === 'string'
            ) {
                messages.push({ role: m.role, content: m.content });
            }
        }
    }

    messages.push({ role: 'user', content: mensaje });

    return messages;
}

async function chatOllama(mensaje, historial) {

    let res;

    try {
        res = await fetchWithTimeout(`${config.ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.ollamaModel,
                messages: buildMessages(mensaje, historial),
                stream: false
            })
        });
    } catch (err) {
        throw new Error(
            `No puedo conectar con Ollama en ${config.ollamaUrl}. ` +
            '¿Está arrancarado con "ollama serve" y el modelo descargado?'
        );
    }

    if (!res.ok) {

        const detail = await res.text().catch(() => '');

        throw new Error(
            `Ollama devolvió ${res.status}. ${detail.slice(0, 200)}`.trim()
        );
    }

    const data = await res.json();

    const respuesta = data?.message?.content?.trim();

    if (!respuesta) {
        throw new Error('Ollama devolvió una respuesta vacía.');
    }

    return respuesta;
}

async function chatOpenAi(mensaje, historial) {

    if (!config.openaiApiKey) {
        throw new Error(
            'Falta OPENAI_API_KEY en server/.env para usar el proveedor cloud.'
        );
    }

    let res;

    try {
        res = await fetchWithTimeout(`${config.openaiBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.openaiApiKey}`
            },
            body: JSON.stringify({
                model: config.openaiModel,
                messages: buildMessages(mensaje, historial)
            })
        });
    } catch (err) {
        throw new Error(
            `No puedo conectar con la API cloud (${config.openaiBaseUrl}). Revisa tu conexión.`
        );
    }

    if (!res.ok) {

        const detail = await res.text().catch(() => '');

        throw new Error(
            `La API cloud devolvió ${res.status}. ${detail.slice(0, 200)}`.trim()
        );
    }

    const data = await res.json();

    const respuesta = data?.choices?.[0]?.message?.content?.trim();

    if (!respuesta) {
        throw new Error('La API cloud devolvió una respuesta vacía.');
    }

    return respuesta;
}

// ---------- Servidor ----------

const server = createServer(async (req, res) => {

    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
    }

    try {

        // Salud
        if (req.method === 'GET' && url.pathname === '/api/health') {
            sendJson(res, 200, {
                ok: true,
                provider: config.provider,
                model: currentModel()
            });
            return;
        }

        // Config actual
        if (req.method === 'GET' && url.pathname === '/api/config') {
            sendJson(res, 200, publicConfig());
            return;
        }

        // Cambiar proveedor / modelo en caliente
        if (req.method === 'PUT' && url.pathname === '/api/config') {

            const body = await readJson(req);

            if (body.provider !== undefined) {

                if (!['ollama', 'openai'].includes(body.provider)) {
                    sendJson(res, 400, {
                        error: 'Proveedor no válido. Usa "ollama" u "openai".'
                    });
                    return;
                }

                config.provider = body.provider;
            }

            if (body.model !== undefined) {

                if (typeof body.model !== 'string' || !body.model.trim()) {
                    sendJson(res, 400, { error: 'Modelo no válido.' });
                    return;
                }

                if (config.provider === 'ollama') {
                    config.ollamaModel = body.model.trim();
                } else {
                    config.openaiModel = body.model.trim();
                }
            }

            if (body.ollamaUrl !== undefined) {
                config.ollamaUrl = String(body.ollamaUrl).replace(/\/+$/, '');
            }

            if (body.voice !== undefined) {

                const available = listVoices().map((v) => v.id);

                if (!available.includes(body.voice)) {
                    sendJson(res, 400, {
                        error:
                            `Voz no válida. Disponibles: ` +
                            (available.join(', ') || '(ninguna instalada en server/voices)')
                    });
                    return;
                }

                config.ttsVoice = body.voice;
            }

            if (body.speaker !== undefined) {

                const speaker = Number(body.speaker);

                if (!Number.isInteger(speaker) || speaker < 0) {
                    sendJson(res, 400, {
                        error: 'Locutor no válido (usa 0, 1, ...).'
                    });
                    return;
                }

                config.ttsSpeaker = speaker;
            }

            console.log(
                `[IA] Ahora: ${config.provider} / ${currentModel()} / voz ${config.ttsVoice}`
            );

            sendJson(res, 200, publicConfig());
            return;
        }

        // Modelos locales de Ollama
        if (req.method === 'GET' && url.pathname === '/api/ollama/models') {

            let ollamaRes;

            try {
                ollamaRes = await fetchWithTimeout(
                    `${config.ollamaUrl}/api/tags`,
                    {},
                    15000
                );
            } catch {
                sendJson(res, 502, {
                    error:
                        `No puedo conectar con Ollama en ${config.ollamaUrl}. ` +
                        'Arráncalo con "ollama serve".'
                });
                return;
            }

            if (!ollamaRes.ok) {
                sendJson(res, 502, {
                    error: `Ollama devolvió ${ollamaRes.status} al listar modelos.`
                });
                return;
            }

            const data = await ollamaRes.json();
            const models = (data?.models || []).map((m) => m.name);

            sendJson(res, 200, { models });
            return;
        }

        // Voces TTS instaladas
        if (req.method === 'GET' && url.pathname === '/api/tts/voices') {
            sendJson(res, 200, {
                voices: listVoices(),
                active: config.ttsVoice
            });
            return;
        }

        // Avatares .vrm disponibles (detección automática)
        if (req.method === 'GET' && url.pathname === '/api/avatars') {
            sendJson(res, 200, { avatars: listAvatars() });
            return;
        }

        // Sintetizar voz (devuelve WAV)
        if (req.method === 'POST' && url.pathname === '/api/tts') {

            const body = await readJson(req);

            const texto = String(body.texto || '').trim();

            if (!texto) {
                sendJson(res, 400, { error: 'Falta el campo "texto".' });
                return;
            }

            const voice = typeof body.voice === 'string' && body.voice
                ? body.voice
                : config.ttsVoice;

            const speaker = body.speaker !== undefined
                ? Number(body.speaker)
                : config.ttsSpeaker;

            let result;

            try {
                result = synthesize(voice, texto, speaker);
            } catch (err) {
                sendJson(res, 500, {
                    error: err instanceof Error ? err.message : 'Error sintetizando voz.'
                });
                return;
            }

            const wav = encodeWav(result.samples, result.sampleRate);

            res.writeHead(200, {
                'Content-Type': 'audio/wav',
                'Access-Control-Allow-Origin': '*',
                'X-Voice': voice,
                'Content-Length': wav.length
            });

            res.end(wav);
            return;
        }

        // Chat
        if (req.method === 'POST' && url.pathname === '/api/chat') {

            const body = await readJson(req);

            const mensaje = String(body.mensaje || '').trim();

            if (!mensaje) {
                sendJson(res, 400, { error: 'Falta el campo "mensaje".' });
                return;
            }

            const respuesta = config.provider === 'ollama'
                ? await chatOllama(mensaje, body.historial)
                : await chatOpenAi(mensaje, body.historial);

            sendJson(res, 200, {
                respuesta,
                proveedor: config.provider,
                modelo: currentModel()
            });
            return;
        }

        sendJson(res, 404, { error: 'Ruta no encontrada.' });

    } catch (err) {

        const message = err instanceof Error
            ? err.message
            : 'Error interno.';

        const status = message.includes('Falta el campo') ||
            message.includes('no válido') ||
            message.includes('JSON')
            ? 400
            : 500;

        sendJson(res, status, { error: message });
    }
});

// ---------- Auto-selección de modelo local ----------
// Al arrancar revisa los modelos de Ollama y, si el
// proveedor es "ollama", escoge por defecto:
// gemma3:2b > cualquier :2b > :1b > :0.5b.
// (Lógica en model-picker.mjs.)

async function autoSelectOllamaModel() {

    if (config.provider !== 'ollama') {
        return;
    }

    let res;

    try {
        res = await fetchWithTimeout(`${config.ollamaUrl}/api/tags`, {}, 10000);
    } catch {
        console.log('[IA] Ollama no responde al arrancar; se mantiene', config.ollamaModel);
        return;
    }

    if (!res.ok) {
        console.log('[IA] Ollama no lista modelos al arrancar; se mantiene', config.ollamaModel);
        return;
    }

    const data = await res.json().catch(() => ({}));
    const models = (data?.models || []).map((m) => m.name).filter(Boolean);

    console.log('[IA] Modelos Ollama:', models.length ? models.join(', ') : '(ninguno)');

    const best = pickDefaultOllamaModel(models);

    if (best && best !== config.ollamaModel) {
        config.ollamaModel = best;
        console.log('[IA] Modelo auto-seleccionado:', best);
    }
}

server.on('error', (err) => {

    if (err && err.code === 'EADDRINUSE') {
        console.error(
            `[IA] El puerto ${PORT} ya está en uso: hay otro servidor corriendo. ` +
            'Ciérralo o usa PORT=otro_puerto npm run server'
        );
        process.exit(1);
    }

    throw err;
});

server.listen(PORT, () => {
    console.log(`[IA] Backend listo en http://localhost:${PORT}`);
    console.log('[IA] Cambia de modelo con PUT /api/config (sin reiniciar)');

    const voices = listVoices();

    if (!voices.length) {
        console.log('[IA] Sin voces TTS: instala alguna en server/voices (ver tts.mjs)');
    } else if (!voices.some((v) => v.id === config.ttsVoice)) {
        config.ttsVoice = voices[0].id;
        console.log(`[IA] Voz configurada no encontrada; usando ${config.ttsVoice}`);
    }

    console.log(`[IA] Voz TTS: ${config.ttsVoice}`);

    autoSelectOllamaModel().then(() => {
        console.log(`[IA] Proveedor: ${config.provider} / ${currentModel()}`);
    });
});
