// ======================================================
// Voz del backend (Piper local) con envolvente para la boca
// ======================================================

import { getApiBase } from '../ai/client.js';

export interface TtsVoice {
    id: string;
    label: string;
    speakers: number;
}

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let smoothedLevel = 0;

function getContext(): AudioContext {

    if (!audioCtx) {
        audioCtx = new AudioContext();
    }

    if (audioCtx.state === 'suspended') {
        void audioCtx.resume();
    }

    return audioCtx;
}

export async function fetchTtsVoices(): Promise<{ voices: TtsVoice[]; active: string }> {

    const res = await fetch(`${getApiBase()}/api/tts/voices`);

    if (!res.ok) {
        throw new Error('No se pudo listar las voces.');
    }

    return res.json();
}

export function backendVoiceActive(): boolean {
    return currentSource !== null;
}

export function stopBackendVoice() {

    if (currentSource) {

        try {
            currentSource.onended = null;
            currentSource.stop();
        } catch {
            // Ya terminada: nada que hacer.
        }

        currentSource = null;
    }

    smoothedLevel = 0;
}

// Nivel 0..1 del volumen actual (para mover la mandíbula)
export function getVoiceLevel(): number {

    if (!analyser || !currentSource) {
        return 0;
    }

    const data = new Uint8Array(analyser.fftSize);

    analyser.getByteTimeDomainData(data);

    let sum = 0;

    for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
    }

    const rms = Math.sqrt(sum / data.length);
    const instant = Math.min(1, rms * 4);

    smoothedLevel += (instant - smoothedLevel) * 0.45;

    return smoothedLevel;
}

export function playBackendVoice(
    texto: string,
    options: { signal?: AbortSignal; voice?: string } = {}
): Promise<void> {

    return new Promise(async (resolve, reject) => {

        if (options.signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }

        let res: Response;

        try {

            res = await fetch(`${getApiBase()}/api/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texto, voice: options.voice }),
                signal: options.signal
            });

        } catch (err) {

            if (err instanceof DOMException && err.name === 'AbortError') {
                reject(err);
            } else {
                reject(new Error('BACKEND_DOWN'));
            }

            return;
        }

        if (!res.ok) {
            reject(new Error('TTS_ERROR'));
            return;
        }

        let buffer: AudioBuffer;

        try {

            const bytes = await res.arrayBuffer();

            buffer = await getContext().decodeAudioData(bytes);

        } catch {

            if (options.signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
            } else {
                reject(new Error('TTS_DECODE'));
            }

            return;
        }

        const ctx = getContext();

        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;

        const source = ctx.createBufferSource();

        source.buffer = buffer;
        source.connect(analyser);
        analyser.connect(ctx.destination);

        currentSource = source;

        const onAbort = () => {
            stopBackendVoice();
            reject(new DOMException('Aborted', 'AbortError'));
        };

        options.signal?.addEventListener('abort', onAbort, { once: true });

        source.onended = () => {

            if (currentSource === source) {
                currentSource = null;
            }

            options.signal?.removeEventListener('abort', onAbort);

            smoothedLevel = 0;
            resolve();
        };

        source.start();
    });
}
