// ======================================================
// Selección del modelo Ollama por defecto:
// gemma3:2b > cualquier :2b > :1b > :0.5b
// ======================================================

export function pickDefaultOllamaModel(models) {

    const list = (models || []).map(String);

    if (!list.length) {
        return null;
    }

    const lower = list.map((m) => m.toLowerCase());

    const exact = list[lower.indexOf('gemma3:2b')];

    if (exact) {
        return exact;
    }

    const gemma = list.find((m) => m.toLowerCase().startsWith('gemma3:'));

    if (gemma) {
        return gemma;
    }

    for (const suffix of [':2b', ':1b', ':0.5b']) {

        const found = list.find((m) =>
            m.toLowerCase().endsWith(suffix)
        );

        if (found) {
            return found;
        }
    }

    return null;
}
