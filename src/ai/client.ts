// ======================================================
// Cliente del backend de IA (cloud u Ollama local)
// ======================================================

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
    role: ChatRole;
    content: string;
}

export interface CloudProfile {
    id: string;
    label: string;
    type: 'openai-compat' | 'anthropic' | 'ollama';
    baseUrl: string;
    model: string;
    keyPresent: boolean;
    keyLast4: string;
    custom: boolean;
    curatedModels?: string[];
}

export interface ChatConfig {
    provider: string;
    model: string;
    ollamaUrl: string;
    ollamaModel: string;
    openaiBaseUrl: string;
    openaiModel: string;
    openaiKeyPresent: boolean;
    activeProfile?: CloudProfile | null;
    profiles?: CloudProfile[];
    avatarName: string;
    ttsVoice: string;
    ttsSpeaker: number;
}

export interface TokenUsage {
    input: number;
    output: number;
    total: number;
}

export interface ChatResponse {
    respuesta: string;
    proveedor: string;
    modelo: string;
    usage?: TokenUsage;
    costEstimateUSD?: number | null;
    ms?: number;
}

export interface CloudTestResult {
    ok: boolean;
    profile?: string;
    label?: string;
    model?: string;
    respuesta?: string;
    ms?: number;
    usage?: TokenUsage;
    costEstimateUSD?: number | null;
    priceKnown?: boolean;
    note?: string;
    error?: string;
}

const API_BASE_KEY = 'iavatar.apiBase';

export function getApiBase(): string {

    try {

        const saved =
            localStorage.getItem(API_BASE_KEY);

        if (saved) {

            const clean = saved.replace(/\/+$/, '');

            // En https un backend http:// se bloquea por
            // contenido mixto: se ignora y va por el proxy.
            try {

                if (
                    window.location.protocol === 'https:' &&
                    clean.startsWith('http://')
                ) {
                    localStorage.removeItem(API_BASE_KEY);
                } else {
                    return clean;
                }

            } catch {
                return clean;
            }
        }

    } catch {
        // localStorage no disponible: usar defecto.
    }

    // En red local (móvil en el mismo WiFi) el backend está
    // en el mismo PC que sirve la página, puerto 3001.
    // En https se usa el mismo origen (proxy /api de vite)
    // para no mezclar contenido seguro con http.
    try {

        if (window.location.protocol === 'https:') {
            return '';
        }

        const host = window.location.hostname;

        if (host && host !== 'localhost' && host !== '127.0.0.1') {
            return `http://${host}:3001`;
        }

    } catch {
        // Sin window (tests): usar defecto.
    }

    return 'http://localhost:3001';
}

export function setApiBase(url: string) {

    try {
        localStorage.setItem(API_BASE_KEY, url.replace(/\/+$/, ''));
    } catch {
        // Ignorar: seguirá usando el valor por defecto.
    }
}

export class BackendError extends Error {

    readonly status: number;

    constructor(message: string, status = 0) {
        super(message);
        this.name = 'BackendError';
        this.status = status;
    }
}

async function parseJson(res: Response): Promise<any> {

    const text = await res.text();

    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { error: text };
    }
}

export async function chat(
    mensaje: string,
    historial: ChatMessage[] = [],
    options: { signal?: AbortSignal } = {}
): Promise<ChatResponse> {

    let res: Response;

    try {

        res = await fetch(`${getApiBase()}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mensaje, historial }),
            signal: options.signal
        });

    } catch (err) {

        if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
        }

        throw new BackendError(
            'No puedo conectar con el backend de IA. ' +
            'Arráncalo con "npm run server".'
        );
    }

    const data = await parseJson(res);

    if (!res.ok) {
        throw new BackendError(data.error || 'Error del backend.', res.status);
    }

    return data as ChatResponse;
}

export async function getConfig(): Promise<ChatConfig> {

    const res = await fetch(`${getApiBase()}/api/config`);

    if (!res.ok) {
        throw new BackendError('No se pudo leer la configuración.');
    }

    return parseJson(res);
}

export async function setConfig(
    patch: { provider?: string; model?: string; ollamaUrl?: string; voice?: string; speaker?: number; apiKey?: string; baseUrl?: string }
): Promise<ChatConfig> {

    let res: Response;

    try {

        res = await fetch(`${getApiBase()}/api/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });

    } catch {

        throw new BackendError(
            'No puedo conectar con el backend de IA. ' +
            'Arráncalo con "npm run server".'
        );
    }

    const data = await parseJson(res);

    if (!res.ok) {
        throw new BackendError(data.error || 'No se pudo guardar.', res.status);
    }

    return data as ChatConfig;
}

export async function listOllamaModels(): Promise<string[]> {

    const res = await fetch(`${getApiBase()}/api/ollama/models`);

    const data = await parseJson(res);

    if (!res.ok) {
        throw new BackendError(
            data.error || 'Ollama no disponible.',
            res.status
        );
    }

    return data.models || [];
}

export async function listCloudProfiles(): Promise<{ active: string; profiles: CloudProfile[] }> {

    const res = await fetch(`${getApiBase()}/api/cloud/profiles`);
    const data = await parseJson(res);

    if (!res.ok) {
        throw new BackendError(data.error || 'No se pudo listar las APIs.', res.status);
    }

    return data;
}

export async function createCloudProfile(
    input: { id?: string; label: string; type: string; baseUrl: string; model: string; apiKey?: string }
): Promise<CloudProfile> {

    const res = await fetch(`${getApiBase()}/api/cloud/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
    });

    const data = await parseJson(res);

    if (!res.ok) {
        throw new BackendError(data.error || 'No se pudo añadir la API.', res.status);
    }

    return data as CloudProfile;
}

export async function updateCloudProfile(
    id: string,
    patch: { label?: string; type?: string; baseUrl?: string; model?: string; apiKey?: string }
): Promise<CloudProfile> {

    const res = await fetch(`${getApiBase()}/api/cloud/profiles/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
    });

    const data = await parseJson(res);

    if (!res.ok) {
        throw new BackendError(data.error || 'No se pudo modificar la API.', res.status);
    }

    return data as CloudProfile;
}

export async function deleteCloudProfile(id: string): Promise<ChatConfig> {

    const res = await fetch(`${getApiBase()}/api/cloud/profiles/${encodeURIComponent(id)}`, {
        method: 'DELETE'
    });

    const data = await parseJson(res);

    if (!res.ok) {
        throw new BackendError(data.error || 'No se pudo eliminar la API.', res.status);
    }

    return data as ChatConfig;
}

export async function setActiveProfile(id: string): Promise<ChatConfig> {

    const res = await fetch(`${getApiBase()}/api/cloud/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });

    const data = await parseJson(res);

    if (!res.ok) {
        throw new BackendError(data.error || 'No se pudo activar la API.', res.status);
    }

    return data as ChatConfig;
}

export async function listCloudModels(id: string): Promise<{ models: string[]; curated?: boolean; note?: string }> {

    const res = await fetch(`${getApiBase()}/api/cloud/models?id=${encodeURIComponent(id)}`);
    const data = await parseJson(res);

    if (!res.ok) {
        throw new BackendError(data.error || 'No se pudo listar modelos.', res.status);
    }

    return data;
}

export async function testCloud(id: string): Promise<CloudTestResult> {

    const res = await fetch(`${getApiBase()}/api/cloud/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });

    return parseJson(res);
}

export function formatCost(usd: number | null | undefined): string {
    if (usd === null || usd === undefined || Number.isNaN(usd)) {
        return 'coste n/d';
    }
    if (usd < 0.0001) {
        return `~$${usd.toFixed(6)}`;
    }
    if (usd < 0.01) {
        return `~$${usd.toFixed(5)}`;
    }
    return `~$${usd.toFixed(4)}`;
}
