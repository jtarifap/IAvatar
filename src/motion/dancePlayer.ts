// ======================================================
// Reproductor de bailes FBX sobre el avatar VRM
// ======================================================
// - Carga cada .fbx una sola vez (caché por fichero).
// - Convierte el clip por deltas con alineación de
//   marcos Mixamo->VRM (q = snap·A·D·A^-1): respeta que
//   los reposos difieran (giro de 180° en muslos...).
// - Reproducción única (LoopOnce) con fundido de entrada
//   desde la pose actual y de salida a la pose inicial.
// - Cadera relativa al primer frame y en metros; resto de
//   posiciones y escalas se ignoran (pies plantados).
// - Mientras baila, main.ts debe saltarse el idle
//   procedural (usa isDancing()/weight como puerta).

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import type { DanceEffect } from './effectsCatalog';

// Mixamo (sin prefijo, minúsculas) -> hueso VRM.
// Si el primero no existe en el modelo se prueba el
// siguiente de la lista (p. ej. upperChest en VRM0).
const BONE_MAP: Record<string, string[]> = {
    hips: ['hips'],
    spine: ['spine'],
    spine1: ['chest'],
    spine2: ['upperChest', 'chest'],
    neck: ['neck'],
    head: ['head'],
    leftshoulder: ['leftShoulder'],
    rightshoulder: ['rightShoulder'],
    leftarm: ['leftUpperArm'],
    rightarm: ['rightUpperArm'],
    leftforearm: ['leftLowerArm'],
    rightforearm: ['rightLowerArm'],
    lefthand: ['leftHand'],
    righthand: ['rightHand'],
    leftupleg: ['leftUpperLeg'],
    rightupleg: ['rightUpperLeg'],
    leftleg: ['leftLowerLeg'],
    rightleg: ['rightLowerLeg'],
    leftfoot: ['leftFoot'],
    rightfoot: ['rightFoot'],
    lefttoebase: ['leftToes', 'leftFoot'],
    righttoebase: ['rightToes', 'rightFoot'],
    lefthandthumb1: ['leftThumbMetacarpal', 'leftThumbProximal'],
    lefthandthumb2: ['leftThumbProximal'],
    lefthandthumb3: ['leftThumbDistal'],
    righthandthumb1: ['rightThumbMetacarpal', 'rightThumbProximal'],
    righthandthumb2: ['rightThumbProximal'],
    righthandthumb3: ['rightThumbDistal'],
    lefthandindex1: ['leftIndexProximal'],
    lefthandindex2: ['leftIndexIntermediate'],
    lefthandindex3: ['leftIndexDistal'],
    righthandindex1: ['rightIndexProximal'],
    righthandindex2: ['rightIndexIntermediate'],
    righthandindex3: ['rightIndexDistal'],
    lefthandmiddle1: ['leftMiddleProximal'],
    lefthandmiddle2: ['leftMiddleIntermediate'],
    lefthandmiddle3: ['leftMiddleDistal'],
    righthandmiddle1: ['rightMiddleProximal'],
    righthandmiddle2: ['rightMiddleIntermediate'],
    righthandmiddle3: ['rightMiddleDistal'],
    lefthandring1: ['leftRingProximal'],
    lefthandring2: ['leftRingIntermediate'],
    lefthandring3: ['leftRingDistal'],
    righthandring1: ['rightRingProximal'],
    righthandring2: ['rightRingIntermediate'],
    righthandring3: ['rightRingDistal'],
    lefthandpinky1: ['leftLittleProximal'],
    lefthandpinky2: ['leftLittleIntermediate'],
    lefthandpinky3: ['leftLittleDistal'],
    righthandpinky1: ['rightLittleProximal'],
    righthandpinky2: ['rightLittleIntermediate'],
    righthandpinky3: ['rightLittleDistal']
};

const FADE_IN_S = 0.3;
const FADE_OUT_S = 0.45;
const HIP_CLAMP_M = 0.35;

interface SourceBone {
    name: string;
    restQ: THREE.Quaternion;
    restP: THREE.Vector3;
}

interface CachedSource {
    clip: THREE.AnimationClip;
    bones: Map<string, SourceBone>;
}

interface DrivenBone {
    obj: THREE.Object3D;
    snapQ: THREE.Quaternion;
    snapP: THREE.Vector3;
    snapS: THREE.Vector3;
    endQ: THREE.Quaternion;
    endP: THREE.Vector3;
}

type Phase = 'idle' | 'play' | 'out';

const loader = new FBXLoader();
const sourceCache = new Map<string, CachedSource>();

let vrm: any = null;
let mixer: THREE.AnimationMixer | null = null;
let action: THREE.AnimationAction | null = null;
let phase: Phase = 'idle';
let outT = 0;
let fadeT = 0;
let clipDuration = 0;
let elapsed = 0;
let currentLabel = '';
let driven: DrivenBone[] = [];
let endNotified = true;

let onEnd: (() => void) | null = null;

export function setDanceEndListener(fn: (() => void) | null) {
    onEnd = fn;
}

function stripMixamo(name: string): string {
    return name.replace(/^mixamorig/i, '').toLowerCase();
}

interface ResolvedBone {
    obj: THREE.Object3D;
    name: string;
}

function resolveVrmBone(names: string[]): ResolvedBone | null {

    if (!vrm?.humanoid) {
        return null;
    }

    for (const n of names) {

        try {

            const bone = vrm.humanoid.getNormalizedBoneNode(n);

            if (bone) {
                return { obj: bone as THREE.Object3D, name: n };
            }

        } catch {
            // Nombre no válido en este modelo: probar siguiente.
        }
    }

    return null;
}

// Reposo del VRM (capturado al cargar el avatar, antes
// del primer frame procedural). Sirve para alinear los
// marcos locales: los huesos Mixamo y VRM no comparten
// orientación de reposo (p. ej. el muslo Mixamo trae un
// giro de 180°) y sin esta alineación las piernas se
// voltean hacia el techo.
const vrmRest = new Map<string, THREE.Quaternion>();

function captureVrmRest() {

    vrmRest.clear();

    if (!vrm?.humanoid) {
        return;
    }

    const names = new Set<string>();

    for (const candidates of Object.values(BONE_MAP)) {
        for (const n of candidates) {
            names.add(n);
        }
    }

    for (const n of names) {

        try {

            const bone = vrm.humanoid.getNormalizedBoneNode(n);

            if (bone) {
                vrmRest.set(n, (bone as THREE.Object3D).quaternion.clone());
            }

        } catch {
            // Hueso ausente en este modelo: se ignora.
        }
    }
}

async function loadSource(
    effect: DanceEffect
): Promise<CachedSource> {

    const hit = sourceCache.get(effect.id);

    if (hit) {
        return hit;
    }

    const fbx = await loader.loadAsync(effect.url);

    const clip = fbx.animations?.[0] ?? null;

    if (!clip) {
        throw new Error(`"${effect.label}" no trae animación.`);
    }

    const bones = new Map<string, SourceBone>();

    // Clave EXACTA del FBX: puede haber nodos que, al
    // quitar el prefijo mixamorig, colisionen entre sí y
    // pisen el reposo correcto (p. ej. la cadera).
    fbx.traverse((obj: any) => {

        if (!obj?.isBone) {
            return;
        }

        if (!bones.has(obj.name)) {
            bones.set(obj.name, {
                name: obj.name,
                restQ: obj.quaternion.clone(),
                restP: obj.position.clone()
            });
        }
    });

    // Unidades por los DATOS del track de cadera (no por
    // el reposo, que puede venir de un nodo colisionado):
    // Mixamo trae centímetros (|Y| ~100), otros en metros.
    let units = '?';
    let hipsRange = '';

    const hipsPosTrack = clip.tracks.find(
        (t) => t.name.endsWith('.position') &&
            stripMixamo(t.name.slice(0, t.name.lastIndexOf('.'))) === 'hips'
    ) as THREE.VectorKeyframeTrack | undefined;

    if (hipsPosTrack) {

        let minY = Infinity;
        let maxY = -Infinity;
        let maxAbs = 0;

        const v = hipsPosTrack.values;

        for (let i = 0; i < v.length; i += 3) {
            if (v[i + 1] < minY) minY = v[i + 1];
            if (v[i + 1] > maxY) maxY = v[i + 1];
            const a = Math.abs(v[i + 1]);
            if (a > maxAbs) maxAbs = a;
        }

        units = maxAbs > 10 ? 'cm' : 'm';
        hipsRange = ` caderaY[${minY.toFixed(1)}..${maxY.toFixed(1)}]`;
    }

    const hipsBone = hipsPosTrack
        ? (bones.get(hipsPosTrack.name.slice(0, hipsPosTrack.name.lastIndexOf('.')))?.name ?? '(reposo desde clave)')
        : '(sin track)';

    // Diagnóstico útil al añadir efectos nuevos:
    // qué huesos del FBX se aprovechan y cuáles no.
    if (bones.size) {

        const mapped = [...bones.keys()].filter((k) => BONE_MAP[stripMixamo(k)]).length;

        console.log(
            `[bailes] "${effect.file}": ${bones.size} huesos FBX, ` +
            `${mapped} con equivalencia VRM, ` +
            `unidades ${units},${hipsRange} hueso cadera: ${hipsBone}, ` +
            `duración ${clip.duration.toFixed(2)}s.`
        );
    }

    const cached: CachedSource = { clip, bones };

    sourceCache.set(effect.id, cached);

    return cached;
}

function splitTrack(track: THREE.KeyframeTrack): {
    node: string;
    prop: string;
} | null {

    const at = track.name.lastIndexOf('.');

    if (at < 0) {
        return null;
    }

    return {
        node: track.name.slice(0, at),
        prop: track.name.slice(at + 1)
    };
}

interface BonePair {
    vrmObj: THREE.Object3D;
    vrmName: string;
    fbxName: string;
}

function collectPairs(source: CachedSource): BonePair[] {

    const exactByKey = new Map<string, string>();

    for (const name of source.bones.keys()) {

        const key = stripMixamo(name);

        if (!exactByKey.has(key)) {
            exactByKey.set(key, name);
        }
    }

    const pairs: BonePair[] = [];

    for (const key of Object.keys(BONE_MAP)) {

        const fbxName = exactByKey.get(key);

        if (!fbxName) {
            continue;
        }

        const resolved = resolveVrmBone(BONE_MAP[key]);

        if (!resolved) {
            continue;
        }

        pairs.push({
            vrmObj: resolved.obj,
            vrmName: resolved.name,
            fbxName
        });
    }

    return pairs;
}

// Convierte el clip por deltas relativos con alineación
// de marcos: D = reposoFbx^-1 * q_anim en marco Mixamo,
// A = reposoVrm^-1 * reposoFbx (paso a marco VRM).
// La cadera sale relativa a su reposo y en metros.
interface BuiltClip {
    clip: THREE.AnimationClip;
    align: Map<string, { srcRest: THREE.Quaternion; vrmName: string }>;
}

function buildRetargetedClip(
    source: CachedSource,
    pairs: BonePair[],
    snapPos: Map<string, THREE.Vector3>
): BuiltClip | null {

    if (!vrm?.scene || !pairs.length) {
        return null;
    }

    const pairByFbx = new Map<string, BonePair>();

    for (const p of pairs) {

        if (!pairByFbx.has(p.fbxName)) {
            pairByFbx.set(p.fbxName, p);
        }
    }

    const tracks: THREE.KeyframeTrack[] = [];
    const align = new Map<string, { srcRest: THREE.Quaternion; vrmName: string }>();

    const qRestInv = new THREE.Quaternion();
    const qTmp = new THREE.Quaternion();
    const qAnim = new THREE.Quaternion();

    for (const track of source.clip.tracks) {

        const split = splitTrack(track);

        if (!split) {
            continue;
        }

        const key = stripMixamo(split.node);

        if (!BONE_MAP[key]) {
            continue;
        }

        const pair = pairByFbx.get(split.node);

        if (!pair) {
            continue;
        }

        if (split.prop === 'quaternion') {

            const srcTrack = track as THREE.QuaternionKeyframeTrack;
            const bone = source.bones.get(split.node);

            // Reposo exacto y, si faltara, primera clave
            const restQ = bone
                ? bone.restQ.clone()
                : new THREE.Quaternion(
                    srcTrack.values[0],
                    srcTrack.values[1],
                    srcTrack.values[2],
                    srcTrack.values[3]
                );

            if (!align.has(pair.vrmObj.name)) {
                align.set(pair.vrmObj.name, {
                    srcRest: restQ.clone(),
                    vrmName: pair.vrmName
                });
            }

            const times = srcTrack.times.slice();
            const values = new Float32Array(srcTrack.values);

            qRestInv.copy(restQ).invert();

            for (let i = 0; i < values.length; i += 4) {

                qAnim.set(
                    values[i],
                    values[i + 1],
                    values[i + 2],
                    values[i + 3]
                );

                // Delta relativo al reposo del FBX
                qTmp.copy(qRestInv).premultiply(qAnim).normalize();

                values[i] = qTmp.x;
                values[i + 1] = qTmp.y;
                values[i + 2] = qTmp.z;
                values[i + 3] = qTmp.w;
            }

            tracks.push(
                new THREE.QuaternionKeyframeTrack(
                    `${pair.vrmObj.name}.quaternion`,
                    times as any,
                    values as any
                )
            );

        } else if (split.prop === 'position' && key === 'hips') {

            // Solo la cadera, como delta relativa clampada
            // y en metros (Mixamo trae centímetros), más
            // la base actual para arrancar en su sitio.
            const srcTrack = track as THREE.VectorKeyframeTrack;
            const bone = source.bones.get(split.node);
            const base = snapPos.get(pair.vrmObj.name);

            if (!base) {
                continue;
            }

            const times = srcTrack.times.slice();
            const values = new Float32Array(srcTrack.values);

            let maxAbs = 0;

            for (let i = 0; i < values.length; i++) {
                const a = Math.abs(values[i]);
                if (a > maxAbs) maxAbs = a;
            }

            const unit = maxAbs > 10 ? 0.01 : 1;

            const refX = bone && Number.isFinite(bone.restP.x) ? bone.restP.x : values[0];
            const refY = bone && Number.isFinite(bone.restP.y) ? bone.restP.y : values[1];
            const refZ = bone && Number.isFinite(bone.restP.z) ? bone.restP.z : values[2];

            for (let i = 0; i < values.length; i += 3) {

                let dx = (values[i] - refX) * unit;
                let dy = (values[i + 1] - refY) * unit;
                let dz = (values[i + 2] - refZ) * unit;

                const len = Math.hypot(dx, dy, dz);

                if (len > HIP_CLAMP_M) {
                    const k = HIP_CLAMP_M / len;
                    dx *= k;
                    dy *= k;
                    dz *= k;
                }

                values[i] = base.x + dx;
                values[i + 1] = base.y + dy;
                values[i + 2] = base.z + dz;
            }

            tracks.push(
                new THREE.VectorKeyframeTrack(
                    `${pair.vrmObj.name}.position`,
                    times as any,
                    values as any
                )
            );
        }
        // Escalas y demás posiciones: se ignoran.
    }

    if (!tracks.length) {
        return null;
    }

    return {
        clip: new THREE.AnimationClip(
            source.clip.name || 'dance',
            source.clip.duration,
            tracks,
            THREE.NormalBlending
        ),
        align
    };
}

// Aplica pose capturada + alineación de marcos a cada
// clave: q_final = q_snap * A * D * A^-1. Sin A, los
// huesos cuyo reposo difiere (muslos) salen volteados.
function applySnapshotAndAlign(
    built: BuiltClip,
    snapOf: Map<string, THREE.Quaternion>
) {

    const qKey = new THREE.Quaternion();
    const qD = new THREE.Quaternion();
    const qA = new THREE.Quaternion();
    const qAInv = new THREE.Quaternion();
    const qFinal = new THREE.Quaternion();

    for (const track of built.clip.tracks) {

        const split = splitTrack(track);

        if (!split || split.prop !== 'quaternion') {
            continue;
        }

        const snap = snapOf.get(split.node);
        const info = built.align.get(split.node);

        if (!snap || !info) {
            continue;
        }

        const restVrm = vrmRest.get(info.vrmName);

        if (restVrm) {
            // A = reposoVrm^-1 * reposoFbx
            qA.copy(restVrm).invert().multiply(info.srcRest);
        } else {
            qA.identity();
        }

        qAInv.copy(qA).invert();

        const values = (track as THREE.QuaternionKeyframeTrack).values;

        for (let i = 0; i < values.length; i += 4) {

            qKey.set(
                values[i],
                values[i + 1],
                values[i + 2],
                values[i + 3]
            );

            // D = reposoFbx^-1 * q_anim
            qD.copy(info.srcRest).invert().multiply(qKey);

            // q_final = q_snap * A * D * A^-1
            qFinal.copy(snap).multiply(qA).multiply(qD).multiply(qAInv).normalize();

            values[i] = qFinal.x;
            values[i + 1] = qFinal.y;
            values[i + 2] = qFinal.z;
            values[i + 3] = qFinal.w;
        }
    }
}

function snapshotDriven(targets: THREE.Object3D[]): DrivenBone[] {

    return targets.map((obj) => ({
        obj,
        snapQ: obj.quaternion.clone(),
        snapP: obj.position.clone(),
        snapS: obj.scale.clone(),
        endQ: obj.quaternion.clone(),
        endP: obj.position.clone()
    }));
}

export function attachDanceVrm(next: any) {

    if (vrm !== next) {
        stopMixer();
        phase = 'idle';
        driven = [];
    }

    vrm = next ?? null;

    // Se llama desde el callback de carga del avatar, en el
    // mismo tick: los huesos aún guardan la pose de reposo
    // del fichero (el idle procedural no ha corrido todavía
    // con este modelo), así que es el momento de capturarla.
    captureVrmRest();
}

function stopMixer() {

    if (action) {
        action.stop();
        action = null;
    }

    if (mixer) {
        mixer.stopAllAction();
        mixer = null;
    }
}

/** Corta el baile y restaura la pose inicial al instante. */
export function cancelDance() {

    if (phase === 'idle') {
        return;
    }

    for (const d of driven) {
        d.obj.quaternion.copy(d.snapQ);
        d.obj.position.copy(d.snapP);
    }

    stopMixer();
    phase = 'idle';
    driven = [];
    currentLabel = '';

    if (!endNotified) {
        endNotified = true;
        onEnd?.();
    }
}

function finishToOut() {

    if (phase !== 'play') {
        return;
    }

    for (const d of driven) {
        d.endQ.copy(d.obj.quaternion);
        d.endP.copy(d.obj.position);
    }

    stopMixer();
    phase = 'out';
    outT = 0;
}

export function isDancing(): boolean {
    return phase !== 'idle';
}

export function danceWeight(): number {
    return phase === 'idle' ? 0 : 1;
}

export function currentDanceLabel(): string {
    return currentLabel;
}

export async function playDance(
    effect: DanceEffect
): Promise<void> {

    if (!vrm?.scene) {
        throw new Error('Todavía no hay avatar cargado.');
    }

    // Interrumpe el anterior dejando los huesos tal cual:
    // el nuevo baile captura esa pose como arranque.
    if (phase !== 'idle') {
        stopMixer();
        phase = 'idle';
        driven = [];
    }

    const source = await loadSource(effect);
    const pairs = collectPairs(source);

    if (!pairs.length) {
        throw new Error(
            `"${effect.label}" no encaja con este avatar.`
        );
    }

    // Horneado por reproducción (barato: ~50 huesos): se
    // captura la pose actual y se vuelcan deltas,
    // alineación de marcos y base de cadera.
    const targets = pairs.map((p) => p.vrmObj);

    driven = snapshotDriven(targets);

    const snapOf = new Map<string, THREE.Quaternion>(
        driven.map((d) => [d.obj.name, d.snapQ] as const)
    );

    const snapPos = new Map<string, THREE.Vector3>(
        driven.map((d) => [d.obj.name, d.snapP] as const)
    );

    const built = buildRetargetedClip(source, pairs, snapPos);

    if (!built) {
        throw new Error(
            `"${effect.label}" no encaja con este avatar.`
        );
    }

    applySnapshotAndAlign(built, snapOf);

    const playClip = built.clip;

    if (!mixer) {
        mixer = new THREE.AnimationMixer(vrm.scene);
        mixer.addEventListener('finished', () => {
            finishToOut();
        });
    }

    action = mixer.clipAction(playClip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.enabled = true;
    action.reset().play();

    clipDuration = playClip.duration;
    elapsed = 0;
    fadeT = 0;
    currentLabel = effect.label;
    phase = 'play';
    endNotified = false;

    console.log(
        `[bailes] Reproduciendo "${effect.label}": ` +
        `${driven.length} huesos, ${clipDuration.toFixed(1)}s, una vez.`
    );
}

/**
 * Avanza el reproductor. Llamar cada frame ANTES de
 * vrm.update(). Devuelve el peso actual (0 = reposo).
 */
export function updateDance(delta: number): number {

    if (phase === 'play' && mixer) {
        mixer.update(delta);
        elapsed += delta;

        // Fundido de entrada: de la pose actual al baile
        if (fadeT < FADE_IN_S) {

            fadeT = Math.min(FADE_IN_S, fadeT + delta);

            const k = fadeT / FADE_IN_S;
            const blend = 1 - k * k * (3 - 2 * k);

            if (blend > 0) {

                for (const d of driven) {
                    d.obj.quaternion.slerp(d.snapQ, blend);
                    d.obj.position.lerp(d.snapP, blend);
                }
            }
        }

        // Red de seguridad por si el evento finished
        // no llegara (formatos FBX peculiares).
        if (elapsed >= clipDuration + 0.25) {
            finishToOut();
        }

        return 1;
    }

    if (phase === 'out') {

        outT += delta;

        const p = Math.min(1, outT / FADE_OUT_S);
        const eased = p * p * (3 - 2 * p);

        for (const d of driven) {
            d.obj.quaternion.slerpQuaternions(d.endQ, d.snapQ, eased);
            d.obj.position.lerpVectors(d.endP, d.snapP, eased);
        }

        if (p >= 1) {
            phase = 'idle';
            driven = [];
            currentLabel = '';
            endNotified = true;
            onEnd?.();
            return 0;
        }

        return 1;
    }

    return 0;
}
