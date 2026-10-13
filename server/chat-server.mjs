// ======================================================
// IAvatar · Mini-backend de IA + voz (Piper local)
// ======================================================
// - POST /api/chat  { mensaje, historial? } -> { respuesta }
// - GET  /api/health, GET /api/config, PUT /api/config
// - GET  /api/ollama/models (lista modelos locales)
// - POST /api/tts   { texto } -> audio/wav (voz local)
// - GET  /api/tts/voices (voces instaladas en server/voices)
//
// Proveedores: "ollama" (local, gratis) y perfiles cloud
// (OpenAI, Gemini vía endpoint compatible OpenAI,
// Anthropic nativo, Groq compatible OpenAI,
// personalizado/OpenRouter...).
// Las API keys viven SOLO en memoria (nunca en disco
// ni en respuestas GET) y se gestionan con:
//   GET/POST /api/cloud/profiles, PUT/DELETE /api/cloud/profiles/:id,
//   POST /api/cloud/active, GET /api/cloud/models,
//   POST /api/cloud/test.
// Arranque:  npm run server   (puerto 3001 por defecto)
// Config:    server/.env (ver .env.example) o variables
//            de entorno. Se puede cambiar proveedor y
//            modelo en caliente con PUT /api/config.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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

// ---------- Tabla de precios estimados ($ por 1M tokens) ----------
// Solo orientativo para probar gasto. El cobro real lo marca
// el dashboard de cada proveedor. Actualizar cuando cambien.

const PRICE_TABLE = {
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1': { input: 2, output: 8 },
    'o4-mini': { input: 1.1, output: 4.4 },
    'gemini-2.0-flash': { input: 0.1, output: 0.4 },
    'gemini-1.5-flash': { input: 0.075, output: 0.3 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5 },
    'claude-3-5-haiku-latest': { input: 0.8, output: 4 },
    'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
    'claude-sonnet-4-20250514': { input: 3, output: 15 },
    'openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
    'openai/gpt-oss-120b': { input: 0.15, output: 0.6 }
};

function estimateCost(model, usage) {
    if (!usage || !model) return null;
    const price = PRICE_TABLE[String(model).trim()];
    if (!price) return null;
    const inp = Number(usage.input || 0);
    const out = Number(usage.output || 0);
    return (inp * price.input + out * price.output) / 1_000_000;
}

// ---------- Perfiles cloud (multi-API, claves solo en memoria) ----------
// type: 'openai-compat' (OpenAI, Gemini-compat, Groq, OpenRouter...)
//     | 'anthropic' (API nativa) | 'ollama' (local, sin clave)

const CLOUD_DEFAULTS = [
    { id: 'openai', label: 'OpenAI', type: 'openai-compat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'gemini', label: 'Gemini', type: 'openai-compat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.0-flash' },
    { id: 'anthropic', label: 'Anthropic (Claude)', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest' },
    { id: 'groq', label: 'Groq (rápida y barata)', type: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b' }
];

const CURATED_MODELS = {
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
    gemini: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-flash'],
    anthropic: ['claude-3-5-haiku-latest', 'claude-sonnet-4-20250514'],
    groq: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
    custom: ['gpt-4o-mini']
};

const PROFILES_FILE = join(__dirname, 'cloud-profiles.json');
const profiles = new Map();

// Corrige errores típicos de Base URL (p. ej. "https://openai.com"
// en vez de "https://api.openai.com/v1", que devuelve 403, o pegar
// el endpoint completo ".../chat/completions" en vez de la base).
function normalizeBaseUrl(id, raw) {
    let base = String(raw || '').trim().replace(/\/+$/, '');
    if (!base) {
        return base;
    }
    // Si pegan el endpoint completo, quedarse con la base:
    // ".../openai/v1/chat/completions" -> ".../openai/v1".
    base = base.replace(/\/(chat\/completions|completions|messages|models)$/i, '').replace(/\/+$/, '');
    let url;
    try {
        url = new URL(base);
    } catch {
        return base;
    }
    const host = url.hostname.toLowerCase();
    if (host === 'openai.com' || host === 'www.openai.com') {
        return 'https://api.openai.com/v1';
    }
    if (host === 'api.openai.com' && !/\/v1$/i.test(base)) {
        return 'https://api.openai.com/v1';
    }
    if (host === 'api.groq.com' && !/^\/openai\/v1/i.test(url.pathname)) {
        return 'https://api.groq.com/openai/v1';
    }
    return base;
}

function publicProfile(p) {
    return {
        id: p.id,
        label: p.label,
        type: p.type,
        baseUrl: p.baseUrl,
        model: p.model,
        keyPresent: Boolean(p.apiKey),
        keyLast4: p.apiKey ? String(p.apiKey).slice(-4) : '',
        custom: Boolean(p.custom),
        curatedModels: CURATED_MODELS[p.id] || CURATED_MODELS.custom
    };
}

function saveProfiles() {
    try {
        const data = [...profiles.values()].map((p) => ({
            id: p.id, label: p.label, type: p.type,
            baseUrl: p.baseUrl, model: p.model, custom: p.custom
            // apiKey NUNCA se guarda en disco
        }));
        writeFileSync(PROFILES_FILE, JSON.stringify({ profiles: data }, null, 2), 'utf8');
    } catch {
        // Sin persistencia: sigue en memoria.
    }
}

function loadProfiles() {
    for (const d of CLOUD_DEFAULTS) {
        profiles.set(d.id, { ...d, apiKey: '', custom: false });
    }
    // Semilla .env histórica -> perfil openai
    if (config.openaiApiKey && profiles.has('openai')) {
        const p = profiles.get('openai');
        p.apiKey = config.openaiApiKey;
        if (config.openaiBaseUrl) p.baseUrl = config.openaiBaseUrl;
        if (config.openaiModel) p.model = config.openaiModel;
    }
    try {
        if (!existsSync(PROFILES_FILE)) return;
        const parsed = JSON.parse(readFileSync(PROFILES_FILE, 'utf8'));
        if (Array.isArray(parsed?.profiles)) {
            for (const s of parsed.profiles) {
                if (!s || typeof s.id !== 'string' || !s.id.trim()) continue;
                const id = s.id.trim();
                const prev = profiles.get(id);
                profiles.set(id, {
                    id,
                    label: String(s.label || prev?.label || id),
                    type: s.type === 'anthropic' ? 'anthropic' : (s.type === 'ollama' ? 'ollama' : 'openai-compat'),
                    baseUrl: normalizeBaseUrl(id, s.baseUrl || prev?.baseUrl || ''),
                    model: String(s.model || prev?.model || 'gpt-4o-mini'),
                    apiKey: prev?.apiKey || '',
                    custom: Boolean(s.custom ?? (prev ? prev.custom : true))
                });
            }
        }
    } catch {
        // Fichero corrupto: se queda con los valores por defecto.
    }
}

loadProfiles();

// Migración: el perfil "grok" (xAI) se eliminó en favor de "groq".
// Si existía en disco o estaba activo, se borra y se activa Groq.
if (profiles.has('grok')) {
    profiles.delete('grok');
    saveProfiles();
}

if (config.provider === 'grok') {
    config.provider = 'groq';
    console.log('[IA] Proveedor "grok" eliminado; usando "groq".');
}

function getActiveProfile() {
    if (config.provider === 'ollama') return null;
    return profiles.get(config.provider) || null;
}

function currentModel() {
    if (config.provider === 'ollama') return config.ollamaModel;
    const p = getActiveProfile();
    return p ? p.model : config.openaiModel;
}

function publicConfig() {
    const active = getActiveProfile();
    return {
        provider: config.provider,
        model: currentModel(),
        ollamaUrl: config.ollamaUrl,
        ollamaModel: config.ollamaModel,
        openaiBaseUrl: active && active.type !== 'anthropic' ? active.baseUrl : config.openaiBaseUrl,
        openaiModel: active ? active.model : config.openaiModel,
        openaiKeyPresent: active ? Boolean(active.apiKey) : Boolean(config.openaiApiKey),
        activeProfile: active ? publicProfile(active) : null,
        profiles: [...profiles.values()].map(publicProfile),
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

    const isFbx = /\.fbx$/i.test(file);
    const base = String(file).replace(/\.(vrm|fbx)$/i, '');

    const sample = base.match(/^avatarsample[_-](.+)$/i);

    let label;

    if (sample) {
        label = `Avatar ${sample[1].replace(/[_-]+/g, ' ').trim()}`;
    } else {
        label = base.replace(/[_-]+/g, ' ').trim() || file;
    }

    return isFbx ? `${label} (FBX)` : label;
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

            if (!/\.(vrm|fbx)$/i.test(entry.name)) {
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

// ---------- Animaciones de idle ----------
// Escanea public/anims (dev) y dist/anims (build) y
// devuelve [{ file, label }] con los .fbx de animación
// (p. ej. "Breathing Idle.fbx"). Viven aparte de
// public/models para no mezclarse con los personajes.

function prettifyAnimLabel(file) {

    const base = String(file).replace(/\.fbx$/i, '');

    return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || file;
}

function listAnims() {

    const dirs = [
        join(__dirname, '..', 'public', 'anims'),
        join(__dirname, '..', 'dist', 'anims')
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

            if (!/\.fbx$/i.test(entry.name)) {
                continue;
            }

            if (seen.has(entry.name)) {
                continue;
            }

            seen.add(entry.name);
            out.push({ file: entry.name, label: prettifyAnimLabel(entry.name) });
        }
    }

    out.sort((a, b) => a.file.localeCompare(b.file, 'es'));

    return out;
}

// ---------- Efectos de baile ----------
// Escanea public/efects (dev) y dist/efects (build) y
// devuelve [{ file, label }]. Así basta con copiar un
// .fbx nuevo a public/efects para que aparezca en la
// pestaña Bailes, sin tocar código.

function prettifyEffectLabel(file) {

    const base = String(file).replace(/\.(fbx|glb|gltf)$/i, '');

    return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || file;
}

function listEffects() {

    const dirs = [
        join(__dirname, '..', 'public', 'efects'),
        join(__dirname, '..', 'dist', 'efects')
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

            if (!/\.(fbx|glb|gltf)$/i.test(entry.name)) {
                continue;
            }

            if (seen.has(entry.name)) {
                continue;
            }

            seen.add(entry.name);
            out.push({ file: entry.name, label: prettifyEffectLabel(entry.name) });
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

function normalizeUsageOpenAi(usage) {
    if (!usage) return { input: 0, output: 0, total: 0 };
    const input = Number(usage.prompt_tokens ?? 0);
    const output = Number(usage.completion_tokens ?? 0);
    return { input, output, total: Number(usage.total_tokens ?? (input + output)) };
}

function normalizeUsageAnthropic(usage) {
    if (!usage) return { input: 0, output: 0, total: 0 };
    const input = Number(usage.input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    return { input, output, total: input + output };
}

async function chatOpenAiCompat(profile, mensaje, historial, maxTokens) {

    if (!profile.apiKey) {
        throw new Error(
            `Falta la API key de "${profile.label}". Añádela desde el panel IA (solo memoria, no se guarda en disco).`
        );
    }

    const body = {
        model: profile.model,
        messages: buildMessages(mensaje, historial)
    };

    if (Number.isInteger(maxTokens) && maxTokens > 0) {
        body.max_tokens = maxTokens;
    }

    let res;

    try {
        res = await fetchWithTimeout(`${profile.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${profile.apiKey}`
            },
            body: JSON.stringify(body)
        });
    } catch (err) {
        throw new Error(
            `No puedo conectar con ${profile.label} (${profile.baseUrl}). Revisa tu conexión.`
        );
    }

    if (!res.ok) {

        const detail = await res.text().catch(() => '');

        let hint = '';

        if (res.status === 401) {
            hint = ' Clave incorrecta o sin saldo: revísala en el dashboard del proveedor.';
        } else if (res.status === 403) {
            hint = ' Revisa la Base URL (OpenAI es https://api.openai.com/v1, no https://openai.com), que la clave sea del proyecto correcto y que la cuenta tenga pago activado.';
        } else if (res.status === 429) {
            hint = ' Límite de uso o sin saldo: mira el dashboard de facturación.';
        }

        throw new Error(
            `${profile.label} devolvió ${res.status}.${hint} ${detail.slice(0, 300)}`.trim()
        );
    }

    const data = await res.json();

    const respuesta = data?.choices?.[0]?.message?.content?.trim();

    if (!respuesta) {
        throw new Error(`La API ${profile.label} devolvió una respuesta vacía.`);
    }

    return { respuesta, usage: normalizeUsageOpenAi(data?.usage) };
}

async function chatAnthropic(profile, mensaje, historial, maxTokens) {

    if (!profile.apiKey) {
        throw new Error(
            `Falta la API key de "${profile.label}". Añádela desde el panel IA (solo memoria, no se guarda en disco).`
        );
    }

    const messages = [{ role: 'user', content: mensaje }];

    if (Array.isArray(historial)) {
        const prev = [];
        for (const m of historial.slice(-12)) {
            if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
                prev.push({ role: m.role, content: m.content });
            }
        }
        messages.unshift(...prev);
    }

    let res;

    try {
        res = await fetchWithTimeout(`${profile.baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': profile.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: profile.model,
                system: config.systemPrompt,
                messages,
                max_tokens: (Number.isInteger(maxTokens) && maxTokens > 0) ? maxTokens : 512
            })
        });
    } catch (err) {
        throw new Error(
            `No puedo conectar con ${profile.label} (${profile.baseUrl}). Revisa tu conexión.`
        );
    }

    if (!res.ok) {

        const detail = await res.text().catch(() => '');

        throw new Error(
            `${profile.label} devolvió ${res.status}. ${detail.slice(0, 300)}`.trim()
        );
    }

    const data = await res.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const respuesta = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();

    if (!respuesta) {
        throw new Error(`La API ${profile.label} devolvió una respuesta vacía.`);
    }

    return { respuesta, usage: normalizeUsageAnthropic(data?.usage) };
}

async function chatCloud(profile, mensaje, historial, maxTokens) {
    if (profile.type === 'anthropic') {
        return chatAnthropic(profile, mensaje, historial, maxTokens);
    }
    return chatOpenAiCompat(profile, mensaje, historial, maxTokens);
}

// Compatibilidad con el proveedor histórico "openai" de .env
async function chatOpenAi(mensaje, historial) {
    const active = getActiveProfile();
    const profile = active || {
        id: 'openai', label: 'Cloud', type: 'openai-compat',
        baseUrl: config.openaiBaseUrl, model: config.openaiModel,
        apiKey: config.openaiApiKey
    };
    const out = await chatCloud(profile, mensaje, historial);
    return out.respuesta;
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
        // (compat: provider "openai" = perfil cloud activo)
        if (req.method === 'PUT' && url.pathname === '/api/config') {

            const body = await readJson(req);

            if (body.provider !== undefined) {

                const id = String(body.provider).trim();

                if (id !== 'ollama' && !profiles.has(id)) {
                    sendJson(res, 400, {
                        error: 'Proveedor no válido. Usa "ollama" o un id de /api/cloud/profiles.'
                    });
                    return;
                }

                // Alias histórico: "openai" sigue funcionando
                config.provider = id === 'openai' && !profiles.has('openai') ? 'openai' : id;
                if (id === 'openai' && profiles.has('openai')) {
                    config.provider = 'openai';
                }
            }

            if (body.model !== undefined) {

                if (typeof body.model !== 'string' || !body.model.trim()) {
                    sendJson(res, 400, { error: 'Modelo no válido.' });
                    return;
                }

                if (config.provider === 'ollama') {
                    config.ollamaModel = body.model.trim();
                } else {
                    const active = getActiveProfile();
                    if (active) {
                        active.model = body.model.trim();
                        saveProfiles();
                    } else {
                        config.openaiModel = body.model.trim();
                    }
                }
            }

            // Compat: actualizar clave/baseUrl del perfil activo
            if (body.apiKey !== undefined || body.openaiApiKey !== undefined) {
                const key = String(body.apiKey ?? body.openaiApiKey ?? '');
                const active = getActiveProfile();
                if (active) {
                    active.apiKey = key;
                    console.log(`[IA] Clave de "${active.label}" actualizada (solo memoria${key ? `, ****${key.slice(-4)}` : ', borrada'}).`);
                } else {
                    config.openaiApiKey = key;
                }
            }

            if (body.baseUrl !== undefined || body.openaiBaseUrl !== undefined) {
                const base = normalizeBaseUrl(config.provider, body.baseUrl ?? body.openaiBaseUrl ?? '');
                const active = getActiveProfile();
                if (active && base) {
                    active.baseUrl = base;
                    saveProfiles();
                } else if (base) {
                    config.openaiBaseUrl = base;
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

        // ---------- Perfiles cloud: añadir / modificar / eliminar ----------
        if (req.method === 'GET' && url.pathname === '/api/cloud/profiles') {
            sendJson(res, 200, {
                active: config.provider,
                profiles: [...profiles.values()].map(publicProfile)
            });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/cloud/profiles') {
            const body = await readJson(req);
            const label = String(body.label || body.id || '').trim();
            const type = body.type === 'anthropic' ? 'anthropic' : 'openai-compat';
            const baseUrl = normalizeBaseUrl(body.id || label, body.baseUrl || '');
            const model = String(body.model || '').trim();
            const apiKey = body.apiKey !== undefined ? String(body.apiKey) : '';
            if (!label || !baseUrl || !model) {
                sendJson(res, 400, { error: 'Faltan campos: nombre, baseUrl y modelo son obligatorios.' });
                return;
            }
            let id = String(body.id || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || label.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
            if (!id) {
                sendJson(res, 400, { error: 'Nombre no válido para generar el id.' });
                return;
            }
            if (id === 'ollama' || profiles.has(id)) {
                sendJson(res, 409, { error: `Ya existe una API con id "${id}". Usa otro nombre o edítala.` });
                return;
            }
            const created = { id, label, type, baseUrl, model, apiKey, custom: true };
            profiles.set(id, created);
            saveProfiles();
            console.log(`[IA] API añadida: ${label} (${id}, ${type}, solo memoria para la clave).`);
            sendJson(res, 201, publicProfile(created));
            return;
        }

        if ((req.method === 'PUT' || req.method === 'DELETE') && url.pathname.startsWith('/api/cloud/profiles/')) {
            const id = decodeURIComponent(url.pathname.slice('/api/cloud/profiles/'.length)).trim();
            const p = profiles.get(id);
            if (!p) {
                sendJson(res, 404, { error: `No existe la API "${id}".` });
                return;
            }
            if (req.method === 'DELETE') {
                profiles.delete(id);
                if (config.provider === id) {
                    config.provider = 'ollama';
                }
                saveProfiles();
                console.log(`[IA] API eliminada: ${id} (su clave en memoria también).`);
                sendJson(res, 200, publicConfig());
                return;
            }
            const body = await readJson(req);
            if (body.label !== undefined && String(body.label).trim()) {
                p.label = String(body.label).trim();
            }
            if (body.type !== undefined) {
                if (!['openai-compat', 'anthropic'].includes(body.type)) {
                    sendJson(res, 400, { error: 'Tipo no válido: usa "openai-compat" o "anthropic".' });
                    return;
                }
                p.type = body.type;
            }
            if (body.baseUrl !== undefined && String(body.baseUrl).trim()) {
                p.baseUrl = normalizeBaseUrl(id, body.baseUrl);
            }
            if (body.model !== undefined && String(body.model).trim()) {
                p.model = String(body.model).trim();
            }
            if (body.apiKey !== undefined) {
                p.apiKey = String(body.apiKey);
                console.log(`[IA] Clave de "${p.label}" actualizada (solo memoria${p.apiKey ? `, ****${p.apiKey.slice(-4)}` : ', borrada'}).`);
            }
            saveProfiles();
            sendJson(res, 200, publicProfile(p));
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/cloud/active') {
            const body = await readJson(req);
            const id = String(body.id || body.provider || '').trim();
            if (id !== 'ollama' && !profiles.has(id)) {
                sendJson(res, 400, { error: 'Id de API no válido.' });
                return;
            }
            config.provider = id;
            console.log(`[IA] Ahora: ${config.provider} / ${currentModel()}`);
            sendJson(res, 200, publicConfig());
            return;
        }

        // Listar modelos cloud (para elegir y comparar gasto)
        if (req.method === 'GET' && url.pathname === '/api/cloud/models') {
            const id = String(url.searchParams.get('id') || config.provider);
            if (id === 'ollama') {
                sendJson(res, 400, { error: 'Usa /api/ollama/models para Ollama.' });
                return;
            }
            const p = profiles.get(id);
            if (!p) {
                sendJson(res, 404, { error: `No existe la API "${id}".` });
                return;
            }
            const curated = CURATED_MODELS[p.id] || CURATED_MODELS.custom;
            if (!p.apiKey) {
                sendJson(res, 200, { models: curated, curated: true, note: 'Sin clave: mostrando sugeridos. Añade la clave y recarga.' });
                return;
            }
            try {
                let modelsRes;
                if (p.type === 'anthropic') {
                    modelsRes = await fetchWithTimeout(`${p.baseUrl}/models`, {
                        headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }
                    }, 20000);
                } else {
                    modelsRes = await fetchWithTimeout(`${p.baseUrl}/models`, {
                        headers: { 'Authorization': `Bearer ${p.apiKey}` }
                    }, 20000);
                }
                if (!modelsRes.ok) {
                    const detail = await modelsRes.text().catch(() => '');
                    sendJson(res, 200, { models: curated, curated: true, note: `${p.label} devolvió ${modelsRes.status}. Mostrando sugeridos. ${detail.slice(0, 120)}` });
                    return;
                }
                const data = await modelsRes.json();
                const raw = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
                const live = raw.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
                const merged = [...new Set([...live, ...curated])].sort();
                sendJson(res, 200, { models: merged.length ? merged : curated, curated: !live.length });
            } catch {
                sendJson(res, 200, { models: curated, curated: true, note: `Sin conexión con ${p.label}. Mostrando sugeridos.` });
            }
            return;
        }

        // Probar conexión con gasto mínimo (1 llamada barata)
        if (req.method === 'POST' && url.pathname === '/api/cloud/test') {
            const body = await readJson(req);
            const id = String(body.id || config.provider);
            if (id === 'ollama') {
                sendJson(res, 400, { error: 'El test es solo para APIs cloud.' });
                return;
            }
            const p = profiles.get(id);
            if (!p) {
                sendJson(res, 404, { error: `No existe la API "${id}".` });
                return;
            }
            const t0 = Date.now();
            try {
                const out = await chatCloud(p, 'Responde solo con la palabra "ok".', [], 16);
                const ms = Date.now() - t0;
                const cost = estimateCost(p.model, out.usage);
                sendJson(res, 200, {
                    ok: true, profile: p.id, label: p.label, model: p.model,
                    respuesta: out.respuesta, ms, usage: out.usage,
                    costEstimateUSD: cost,
                    priceKnown: cost !== null,
                    note: cost === null ? 'Modelo sin precio en tabla: mira el dashboard del proveedor.' : 'Estimación orientativa, no factura real.'
                });
            } catch (err) {
                sendJson(res, 502, { ok: false, profile: p.id, model: p.model, error: err instanceof Error ? err.message : 'Error de conexión.' });
            }
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

        // Avatares .vrm/.fbx disponibles (detección automática)
        if (req.method === 'GET' && url.pathname === '/api/avatars') {
            sendJson(res, 200, { avatars: listAvatars() });
            return;
        }

        // Animaciones de idle .fbx (detección automática)
        if (req.method === 'GET' && url.pathname === '/api/anims') {
            sendJson(res, 200, { anims: listAnims() });
            return;
        }

        // Efectos de baile .fbx disponibles (detección automática)
        if (req.method === 'GET' && url.pathname === '/api/effects') {
            sendJson(res, 200, { effects: listEffects() });
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

            if (config.provider === 'ollama') {
                const respuesta = await chatOllama(mensaje, body.historial);
                sendJson(res, 200, {
                    respuesta,
                    proveedor: config.provider,
                    modelo: currentModel()
                });
                return;
            }

            const active = getActiveProfile();

            if (!active) {
                const respuesta = await chatOpenAi(mensaje, body.historial);
                sendJson(res, 200, {
                    respuesta,
                    proveedor: config.provider,
                    modelo: currentModel()
                });
                return;
            }

            const t0 = Date.now();
            const out = await chatCloud(active, mensaje, body.historial);
            const cost = estimateCost(active.model, out.usage);

            sendJson(res, 200, {
                respuesta: out.respuesta,
                proveedor: config.provider,
                modelo: currentModel(),
                usage: out.usage,
                costEstimateUSD: cost,
                ms: Date.now() - t0
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
