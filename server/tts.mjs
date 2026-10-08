// ======================================================
// TTS local gratuito (Piper vía sherpa-onnx, offline)
// ======================================================
// Las voces viven en server/voices/<id>/ con:
//   - un .onnx (+ su .onnx.json)
//   - tokens.txt y espeak-ng-data/
// (ver patch-onnx-meta.cjs para adaptar modelos en crudo)

import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const VOICES_DIR = join(__dirname, 'voices');

const FRIENDLY_NAMES = {
    'mls_10246-low': 'Lucía · femenina',
    'davefx-medium': 'Diego · masculina',
    'sharvard-medium': 'Sharvard'
};

// Número de locutores por voz (sid 0..N-1). Al añadir una
// voz multi-locutor, indica aquí cuántos trae.
const VOICE_SPEAKERS = {
    'sharvard-medium': 2
};

function speakerCount(id) {
    return VOICE_SPEAKERS[id] || 1;
}

let ttsCache = {};
let sherpa = null;

function getSherpa() {

    if (!sherpa) {
        sherpa = require('sherpa-onnx-node');
    }

    return sherpa;
}

export function listVoices() {

    if (!existsSync(VOICES_DIR)) {
        return [];
    }

    return readdirSync(VOICES_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((id) => voiceFiles(id) !== null)
        .map((id) => ({
            id,
            label: FRIENDLY_NAMES[id] || id,
            speakers: speakerCount(id)
        }));
}

function voiceFiles(id) {

    if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
        return null;
    }

    const dir = join(VOICES_DIR, id);

    if (!existsSync(dir)) {
        return null;
    }

    const onnx = readdirSync(dir)
        .find((f) => f.endsWith('.onnx') && !f.endsWith('.orig'));

    if (!onnx) {
        return null;
    }

    const tokens = join(dir, 'tokens.txt');
    const dataDir = join(dir, 'espeak-ng-data');

    if (!existsSync(tokens) || !existsSync(dataDir)) {
        return null;
    }

    return { dir, onnx: join(dir, onnx), tokens, dataDir };
}

function getTts(id) {

    if (ttsCache[id]) {
        return ttsCache[id];
    }

    const files = voiceFiles(id);

    if (!files) {
        throw new Error(
            `Voz "${id}" no disponible. Voces: ` +
            (listVoices().map((v) => v.id).join(', ') || '(ninguna)')
        );
    }

    const s = getSherpa();

    const tts = new s.OfflineTts({
        model: {
            vits: {
                model: files.onnx,
                tokens: files.tokens,
                dataDir: files.dataDir
            },
            numThreads: 2,
            provider: 'cpu'
        },
        maxNumSentences: 4
    });

    ttsCache[id] = tts;

    return tts;
}

export function synthesize(id, text, sid = 0) {

    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);

    if (!clean) {
        throw new Error('Texto vacío para sintetizar.');
    }

    const speaker = Number(sid) || 0;

    if (speaker < 0 || speaker >= speakerCount(id)) {
        throw new Error(`Locutor no válido para "${id}".`);
    }

    const s = getSherpa();
    const tts = getTts(id);

    const audio = tts.generate({
        text: clean,
        generationConfig: new s.GenerationConfig({ sid: speaker, speed: 1.0 })
    });

    return {
        samples: audio.samples,
        sampleRate: audio.sampleRate
    };
}

// WAV mono 16-bit para la respuesta HTTP
export function encodeWav(samples, sampleRate) {

    const buffer = Buffer.alloc(44 + samples.length * 2);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + samples.length * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples.length * 2, 40);

    for (let i = 0; i < samples.length; i++) {

        const v = Math.max(-1, Math.min(1, samples[i]));

        buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }

    return buffer;
}
