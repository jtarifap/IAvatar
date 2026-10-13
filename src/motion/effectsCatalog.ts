// ======================================================
// Catálogo de efectos de baile (carpeta public/efects)
// ======================================================
// La lista viva viene del backend (GET /api/effects),
// que escanea la carpeta en cada petición: basta con
// copiar un .fbx nuevo para que aparezca en la pestaña
// Bailes sin tocar código. Si el backend no responde
// (p. ej. build estático), se usa la lista local.

export interface DanceEffect {
    id: string;
    file: string;
    label: string;
    url: string;
}

const EFFECTS_BASE = '/efects';

export function effectUrl(file: string): string {
    return `${EFFECTS_BASE}/${encodeURIComponent(file)}`;
}

export function prettifyEffectLabel(file: string): string {
    return String(file)
        .replace(/\.(fbx|glb|gltf)$/i, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || file;
}

// Reserva local: refleja el contenido actual de
// public/efects por si /api/effects no está disponible.
const FALLBACK_FILES = [
    'Belly Dance.fbx',
    'Macarena Dance.fbx',
    'Silly Dancing.fbx',
    'Swing Dancing.fbx'
];

export function fallbackEffects(): DanceEffect[] {
    return FALLBACK_FILES.map((file) => ({
        id: file.toLowerCase(),
        file,
        label: prettifyEffectLabel(file),
        url: effectUrl(file)
    }));
}

let cache: DanceEffect[] | null = null;

export async function fetchEffects(
    force = false
): Promise<DanceEffect[]> {

    if (cache && !force) {
        return cache;
    }

    try {

        const res = await fetch('/api/effects');

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        const list = Array.isArray(data?.effects)
            ? data.effects
            : [];

        const effects: DanceEffect[] = [];

        for (const entry of list) {

            const file = typeof entry?.file === 'string'
                ? entry.file
                : '';

            if (!file) {
                continue;
            }

            const label = typeof entry?.label === 'string' && entry.label
                ? entry.label
                : prettifyEffectLabel(file);

            effects.push({
                id: file.toLowerCase(),
                file,
                label,
                url: effectUrl(file)
            });
        }

        cache = effects.length ? effects : fallbackEffects();

    } catch {
        cache = fallbackEffects();
    }

    return cache;
}

export function getCachedEffects(): DanceEffect[] {
    return cache ?? fallbackEffects();
}

// ------------------------------------------------------
// Órdenes de baile en español ("baila macarena", "haz
// el baile del vientre"...). Devuelve el efecto y el
// resto del texto (lo que sí va a la IA).
// ------------------------------------------------------

const DANCE_VERBS = /\b(baila|bailame|báilame|bailar|bailando|danza|danzar|haz|hazme|pon|ponte|quiero|muestra|muestrame|muéstrame)\b/;

function fold(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, ' ');
}

export interface DanceCommand {
    effect: DanceEffect | null;
    cleaned: string;
    isPureCommand: boolean;
}

export function extractDanceCommand(
    text: string,
    effects: DanceEffect[]
): DanceCommand {

    const empty: DanceCommand = {
        effect: null,
        cleaned: text,
        isPureCommand: false
    };

    const sentences = text
        .split(/(?<=[.!?;])\s+|\n+/)
        .map((s) => s.trim())
        .filter(Boolean);

    if (!sentences.length || !effects.length) {
        return empty;
    }

    let effect: DanceEffect | null = null;
    const rest: string[] = [];

    for (const sentence of sentences) {

        const norm = ` ${fold(sentence)} `;

        let found: DanceEffect | null = null;

        if (DANCE_VERBS.test(norm) || /baile/.test(norm)) {

            // 1) Coincidencia por etiqueta completa
            //    ("macarena dance", "belly dance"...).
            for (const e of effects) {

                const words = fold(e.label)
                    .split(/\s+/)
                    .filter((w) => w.length > 2);

                if (
                    words.length &&
                    words.every((w) => norm.includes(w))
                ) {
                    found = e;
                    break;
                }
            }

            // 2) Coincidencia por palabra significativa
            //    ("macarena", "vientre"/"belly", "swing"...).
            if (!found) {

                const synonyms: Record<string, string[]> = {
                    belly: ['vientre', 'belly', 'danza arabe', 'danza del vientre'],
                    silly: ['loco', 'loca', 'divertido', 'divertida', 'gracioso', 'silly', 'tonto'],
                    swing: ['swing'],
                    macarena: ['macarena']
                };

                outer:
                for (const e of effects) {

                    const key = fold(e.label).split(/\s+/)[0] ?? '';
                    const labelWords = fold(e.label)
                        .split(/\s+/)
                        .filter((w) => w.length > 2);

                    const candidates = [
                        ...labelWords,
                        ...(synonyms[key] ?? [])
                    ];

                    for (const w of candidates) {

                        const needle = fold(w).trim();

                        if (
                            needle.length > 2 &&
                            norm.includes(needle)
                        ) {
                            found = e;
                            break outer;
                        }
                    }
                }
            }

            // 3) "baila algo / pon un baile" sin nombre:
            //    primer efecto de la lista.
            if (!found && /\b(baile|baila|bailar|danza)\b/.test(norm)) {
                found = effects[0];
            }
        }

        if (found) {
            effect = found;
        } else {
            rest.push(sentence);
        }
    }

    if (!effect) {
        return empty;
    }

    return {
        effect,
        cleaned: rest.join(' ').trim(),
        isPureCommand: rest.length === 0
    };
}
