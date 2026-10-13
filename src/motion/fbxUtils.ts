// ======================================================
// Utilidades compartidas FBX (avatares + idles Mixamo)
// ======================================================
// Los FBX Mixamo vienen con o sin namespace:
// "mixamorigHips" o "mixamorig:Hips". Además algunos
// personajes traen dedos de 4 segmentos (...Index1-4)
// en vez de 3. Todo el mapeo pasa por normalizeFbxKey.

import * as THREE from 'three';

// "mixamorig:LeftUpLeg" -> "leftupleg"
// "mixamorigLeftUpLeg"  -> "leftupleg"
// "LeftUpLeg"           -> "leftupleg"
export function normalizeFbxKey(name: string): string {

    let clean = String(name ?? '');

    const colon = clean.indexOf(':');

    if (colon >= 0) {
        clean = clean.slice(colon + 1);
    }

    clean = clean.replace(/^mixamorig/i, '');

    return clean.toLowerCase();
}

// Clave VRM (la que pide getNormalizedBoneNode) ->
// candidatas FBX ya normalizadas, en orden de intento.
// Dedos: en rigs de 4 segmentos se usa 2/3/4 (se ignora
// el 1, base casi inmóvil); en rigs de 3, 1/2/3.
export const VRM_TO_FBX_KEYS: Record<string, string[]> = {
    hips: ['hips'],
    spine: ['spine'],
    chest: ['spine1'],
    upperchest: ['upperchest', 'spine2'],
    neck: ['neck1', 'neck'],
    head: ['head'],
    jaw: [],
    leftshoulder: ['leftshoulder'],
    rightshoulder: ['rightshoulder'],
    leftupperarm: ['leftarm'],
    rightupperarm: ['rightarm'],
    leftlowerarm: ['leftforearm'],
    rightlowerarm: ['rightforearm'],
    lefthand: ['lefthand'],
    righthand: ['righthand'],
    leftupperleg: ['leftupleg'],
    rightupperleg: ['rightupleg'],
    leftlowerleg: ['leftleg'],
    rightlowerleg: ['rightleg'],
    leftfoot: ['leftfoot'],
    rightfoot: ['rightfoot'],
    lefttoes: ['lefttoebase', 'leftfoot'],
    righttoes: ['righttoebase', 'rightfoot']
};

const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];
const FINGER_JOINTS = ['proximal', 'intermediate', 'distal'];

for (const side of ['left', 'right']) {
    for (const finger of FINGERS) {
        // 4 segmentos: 2/3/4 (el 1 apenas se mueve)
        VRM_TO_FBX_KEYS[`${side}${finger}proximal`] = [`${side}hand${finger}2`, `${side}hand${finger}1`];
        VRM_TO_FBX_KEYS[`${side}${finger}intermediate`] = [`${side}hand${finger}3`, `${side}hand${finger}2`];
        VRM_TO_FBX_KEYS[`${side}${finger}distal`] = [`${side}hand${finger}4`, `${side}hand${finger}3`];
    }
}

// Busca un hueso en un Object3D por candidatas ya
// normalizadas. Devuelve el objeto o null.
export function findFbxBone(
    root: THREE.Object3D,
    candidates: string[]
): THREE.Object3D | null {

    if (!root || !candidates.length) {
        return null;
    }

    const wanted = new Set(candidates.map((c) => c.toLowerCase()));
    let found: THREE.Object3D | null = null;

    root.traverse((obj) => {

        if (found || !(obj as any).isBone) {
            return;
        }

        if (wanted.has(normalizeFbxKey(obj.name))) {
            found = obj as THREE.Object3D;
        }
    });

    return found;
}

// Unidades por los DATOS de un track de posición:
// |valor| máx > 10 = centímetros Mixamo.
export function detectUnitScale(values: ArrayLike<number>): number {

    let maxAbs = 0;

    for (let i = 0; i < values.length; i++) {
        const a = Math.abs(values[i]);
        if (a > maxAbs) maxAbs = a;
    }

    return maxAbs > 10 ? 0.01 : 1;
}
