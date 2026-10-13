// ======================================================
// Idle en bucle para avatares FBX (p. ej. Breathing Idle)
// ======================================================
// - Un clip .fbx de public/anims sonando en LoopRepeat
//   con fundido de entrada/salida.
// - Mismo horneado que los bailes (q = snap·A·D·A^-1,
//   validado con piernas abajo) + cadera relativa en
//   metros con base actual.
// - main.ts pausa el idle procedural absoluto mientras
//   suena (usa idleLoopWeight() como puerta) y mantiene
//   mirada/gestos (escrituras +=, compatibles).

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { normalizeFbxKey, detectUnitScale, VRM_TO_FBX_KEYS } from './fbxUtils.js';

// Nombre canónico VRM (el que entiende un humanoid de
// verdad; la fachada FBX acepta minúsculas igual).
const CANONICAL: Record<string, string> = {
    hips: 'hips',
    spine: 'spine',
    chest: 'chest',
    upperchest: 'upperChest',
    neck: 'neck',
    head: 'head',
    jaw: 'jaw',
    leftshoulder: 'leftShoulder',
    rightshoulder: 'rightShoulder',
    leftupperarm: 'leftUpperArm',
    rightupperarm: 'rightUpperArm',
    leftlowerarm: 'leftLowerArm',
    rightlowerarm: 'rightLowerArm',
    lefthand: 'leftHand',
    righthand: 'rightHand',
    leftupperleg: 'leftUpperLeg',
    rightupperleg: 'rightUpperLeg',
    leftlowerleg: 'leftLowerLeg',
    rightlowerleg: 'rightLowerLeg',
    leftfoot: 'leftFoot',
    rightfoot: 'rightFoot',
    lefttoes: 'leftToes',
    righttoes: 'rightToes'
};

for (const side of ['left', 'right']) {
    for (const [f, c] of [['thumb', 'Thumb'], ['index', 'Index'], ['middle', 'Middle'], ['ring', 'Ring'], ['little', 'Little']] as const) {
        for (const [j, J] of [['proximal', 'Proximal'], ['intermediate', 'Intermediate'], ['distal', 'Distal']] as const) {
            CANONICAL[`${side}${f}${j}`] = `${side === 'left' ? 'left' : 'right'}${c}${J}`;
        }
    }
}

// fbxKey normalizada -> nombre VRM canónico
const REVERSE = new Map<string, string>();

for (const [vrmLower, candidates] of Object.entries(VRM_TO_FBX_KEYS)) {

    const canonical = CANONICAL[vrmLower] ?? vrmLower;

    for (const c of candidates) {

        if (!REVERSE.has(c)) {
            REVERSE.set(c, canonical);
        }
    }
}

export interface LoopRig {
    scene: THREE.Object3D;
    humanoid: {
        getNormalizedBoneNode(name: string): THREE.Object3D | null;
    };
    rest?: Map<string, THREE.Quaternion>;
}

interface DrivenBone {
    obj: THREE.Object3D;
    snapQ: THREE.Quaternion;
    snapP: THREE.Vector3;
    endQ: THREE.Quaternion;
    endP: THREE.Vector3;
}

type Phase = 'idle' | 'play' | 'out';

const FADE_IN_S = 0.5;
const FADE_OUT_S = 0.5;
const HIP_CLAMP_M = 0.3;

const loader = new FBXLoader();
const clipCache = new Map<string, THREE.AnimationClip>();

let rig: LoopRig | null = null;
let mixer: THREE.AnimationMixer | null = null;
let action: THREE.AnimationAction | null = null;
let phase: Phase = 'idle';
let fadeT = 0;
let outT = 0;
let driven: DrivenBone[] = [];
let currentLabel = '';

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

function resolveTarget(vrmName: string): THREE.Object3D | null {

    if (!rig?.humanoid) {
        return null;
    }

    try {
        return rig.humanoid.getNormalizedBoneNode(vrmName) ?? null;
    } catch {
        return null;
    }
}

function snapshot(targets: THREE.Object3D[]): DrivenBone[] {

    return targets.map((obj) => ({
        obj,
        snapQ: obj.quaternion.clone(),
        snapP: obj.position.clone(),
        endQ: obj.quaternion.clone(),
        endP: obj.position.clone()
    }));
}

export function isIdleLooping(): boolean {
    return phase !== 'idle';
}

export function idleLoopWeight(): number {
    return phase === 'idle' ? 0 : 1;
}

export function currentIdleLabel(): string {
    return currentLabel;
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

/** Corta el loop restaurando la pose (con fundido salvo instant). */
export function stopIdleLoop(instant = false) {

    if (phase === 'idle') {
        return;
    }

    if (instant) {

        for (const d of driven) {
            d.obj.quaternion.copy(d.snapQ);
            d.obj.position.copy(d.snapP);
        }

        stopMixer();
        phase = 'idle';
        driven = [];
        currentLabel = '';
        return;
    }

    // Fundido de salida
    for (const d of driven) {
        d.endQ.copy(d.obj.quaternion);
        d.endP.copy(d.obj.position);
    }

    stopMixer();
    phase = 'out';
    outT = 0;
}

export function attachIdleRig(next: LoopRig | null) {

    if (rig !== next) {
        stopIdleLoop(true);
    }

    rig = next;
}

export async function startIdleLoop(
    targetRig: LoopRig,
    file: string,
    label: string
): Promise<void> {

    attachIdleRig(targetRig);

    if (!rig?.scene) {
        throw new Error('Sin avatar para el idle.');
    }

    // Reinicia si ya sonaba este u otro
    stopIdleLoop(true);

    let baked = clipCache.get(`${file}`);

    if (!baked) {

        const fbx = await loader.loadAsync(
            `/anims/${encodeURIComponent(file)}`
        );

        const clip = fbx.animations?.[0] ?? null;

        if (!clip) {
            throw new Error(`"${label}" no trae animación.`);
        }

        // Reposo fuente por nombre exacto
        const srcRest = new Map<string, { q: THREE.Quaternion; p: THREE.Vector3 }>();

        fbx.traverse((obj: any) => {

            if (!obj?.isBone) {
                return;
            }

            if (!srcRest.has(obj.name)) {
                srcRest.set(obj.name, {
                    q: obj.quaternion.clone(),
                    p: obj.position.clone()
                });
            }
        });

        const unit = (() => {

            const hpos = clip.tracks.find((t) => {
                const at = t.name.lastIndexOf('.');
                return at > 0 &&
                    t.name.slice(at + 1) === 'position' &&
                    normalizeFbxKey(t.name.slice(0, at)) === 'hips';
            }) as THREE.VectorKeyframeTrack | undefined;

            return hpos ? detectUnitScale(hpos.values) : 1;
        })();

        const seen = new Set<string>();
        const tracks: THREE.KeyframeTrack[] = [];

        const qRestInv = new THREE.Quaternion();
        const qTmp = new THREE.Quaternion();
        const qAnim = new THREE.Quaternion();
        const qA = new THREE.Quaternion();

        for (const track of clip.tracks) {

            const split = splitTrack(track);

            if (!split) {
                continue;
            }

            const vrmName = REVERSE.get(normalizeFbxKey(split.node));

            if (!vrmName) {
                continue;
            }

            const target = resolveTarget(vrmName);

            if (!target || seen.has(target.name + '.' + split.prop)) {
                continue;
            }

            seen.add(target.name + '.' + split.prop);

            if (split.prop === 'quaternion') {

                const srcTrack = track as THREE.QuaternionKeyframeTrack;
                const rest = srcRest.get(split.node);

                const restQ = rest
                    ? rest.q.clone()
                    : new THREE.Quaternion(
                        srcTrack.values[0],
                        srcTrack.values[1],
                        srcTrack.values[2],
                        srcTrack.values[3]
                    );

                // A se aplica en play (ver abajo); aquí
                // solo el delta relativo al reposo FBX.
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

                    qTmp.copy(qRestInv).premultiply(qAnim).normalize();

                    values[i] = qTmp.x;
                    values[i + 1] = qTmp.y;
                    values[i + 2] = qTmp.z;
                    values[i + 3] = qTmp.w;
                }

                // Guarda el reposo para la alineación en play
                (track as any).__restQ = restQ;
                (track as any).__vrmName = vrmName;

                tracks.push(
                    new THREE.QuaternionKeyframeTrack(
                        `${target.name}.quaternion`,
                        times as any,
                        values as any
                    )
                );

            } else if (split.prop === 'position' && vrmName === 'hips') {

                const srcTrack = track as THREE.VectorKeyframeTrack;
                const rest = srcRest.get(split.node);

                const refX = rest ? rest.p.x : srcTrack.values[0];
                const refY = rest ? rest.p.y : srcTrack.values[1];
                const refZ = rest ? rest.p.z : srcTrack.values[2];

                const times = srcTrack.times.slice();
                const values = new Float32Array(srcTrack.values);

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

                    values[i] = dx;
                    values[i + 1] = dy;
                    values[i + 2] = dz;
                }

                tracks.push(
                    new THREE.VectorKeyframeTrack(
                        `${target.name}.position`,
                        times as any,
                        values as any
                    )
                );
            }
        }

        if (!tracks.length) {
            throw new Error(`"${label}" no encaja con este avatar.`);
        }

        baked = new THREE.AnimationClip(
            clip.name || 'idle',
            clip.duration,
            tracks,
            THREE.NormalBlending
        );

        // Adjunta alineación (reposo FBX + VRM) por track
        const aligns = new Map<string, { srcRest: THREE.Quaternion; vrmKey: string }>();

        for (const track of clip.tracks) {

            const split = splitTrack(track);

            if (!split || split.prop !== 'quaternion') {
                continue;
            }

            const restQ = (track as any).__restQ as THREE.Quaternion | undefined;
            const vrmName = (track as any).__vrmName as string | undefined;

            if (!restQ || !vrmName) {
                continue;
            }

            const target = resolveTarget(vrmName);

            if (target && !aligns.has(target.name)) {
                aligns.set(target.name, {
                    srcRest: restQ,
                    vrmKey: vrmName.toLowerCase()
                });
            }
        }

        (baked as any).__aligns = aligns;

        // Cadera: deltas relativos -> se suma la base en play
        (baked as any).__hipsRelative = true;

        clipCache.set(file, baked);

        const mapped = new Set<string>();

        for (const t of tracks) {
            const s = splitTrack(t);
            if (s) mapped.add(s.node);
        }

        console.log(
            `[idle] "${file}": ${mapped.size} huesos, ` +
            `${clip.duration.toFixed(1)}s en bucle, unidades ` +
            `${unit === 0.01 ? 'cm' : 'm'}.`
        );
    }

    // Objetivos = huesos del clip ya convertido
    const targets: THREE.Object3D[] = [];
    const seenTargets = new Set<string>();

    for (const track of baked.tracks) {

        const split = splitTrack(track);

        if (!split || seenTargets.has(split.node)) {
            continue;
        }

        const obj = rig.scene.getObjectByName(split.node);

        if (obj) {
            seenTargets.add(split.node);
            targets.push(obj as THREE.Object3D);
        }
    }

    if (!targets.length) {
        throw new Error(`"${label}" no encaja con este avatar.`);
    }

    driven = snapshot(targets);

    const snapOf = new Map<string, THREE.Quaternion>(
        driven.map((d) => [d.obj.name, d.snapQ] as const)
    );

    const snapPos = new Map<string, THREE.Vector3>(
        driven.map((d) => [d.obj.name, d.snapP] as const)
    );

    // Aplica alineación + pose + base con una copia por
    // reproducción (el cacheado queda intacto).
    const playTracks: THREE.KeyframeTrack[] = [];
    const aligns = ((baked as any).__aligns ?? new Map()) as Map<string, { srcRest: THREE.Quaternion; vrmKey: string }>;

    const qKey = new THREE.Quaternion();
    const qD = new THREE.Quaternion();
    const qAInv = new THREE.Quaternion();
    const qFinal = new THREE.Quaternion();

    for (const track of baked.tracks) {

        const split = splitTrack(track);

        if (!split) {
            continue;
        }

        if (split.prop === 'quaternion') {

            const snap = snapOf.get(split.node);
            const info = aligns.get(split.node);

            if (!snap || !info) {
                playTracks.push(track);
                continue;
            }

            const restVrm = rig.rest?.get(info.vrmKey);
            const qA = new THREE.Quaternion();

            if (restVrm) {
                qA.copy(restVrm).invert().multiply(info.srcRest);
            } else {
                qA.identity();
            }

            qAInv.copy(qA).invert();

            const srcTrack = track as THREE.QuaternionKeyframeTrack;
            const values = new Float32Array(srcTrack.values);

            for (let i = 0; i < values.length; i += 4) {

                qKey.set(
                    values[i],
                    values[i + 1],
                    values[i + 2],
                    values[i + 3]
                );

                qD.copy(info.srcRest).invert().multiply(qKey);
                qFinal.copy(snap).multiply(qA).multiply(qD).multiply(qAInv).normalize();

                values[i] = qFinal.x;
                values[i + 1] = qFinal.y;
                values[i + 2] = qFinal.z;
                values[i + 3] = qFinal.w;
            }

            playTracks.push(
                new THREE.QuaternionKeyframeTrack(
                    track.name,
                    (srcTrack.times.slice() as any),
                    values as any
                )
            );

        } else if (split.prop === 'position') {

            const base = snapPos.get(split.node);
            const srcTrack = track as THREE.VectorKeyframeTrack;

            if (!base) {
                playTracks.push(track);
                continue;
            }

            const values = new Float32Array(srcTrack.values);

            for (let i = 0; i < values.length; i += 3) {
                values[i] += base.x;
                values[i + 1] += base.y;
                values[i + 2] += base.z;
            }

            playTracks.push(
                new THREE.VectorKeyframeTrack(
                    track.name,
                    (srcTrack.times.slice() as any),
                    values as any
                )
            );

        } else {
            playTracks.push(track);
        }
    }

    const playClip = new THREE.AnimationClip(
        baked.name || 'idle',
        baked.duration,
        playTracks
    );

    if (!mixer) {
        mixer = new THREE.AnimationMixer(rig.scene);
    } else {
        mixer.stopAllAction();
    }

    action = mixer.clipAction(playClip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.enabled = true;
    action.reset().play();

    fadeT = 0;
    currentLabel = label;
    phase = 'play';

    console.log(
        `[idle] Sonando "${label}" en bucle ` +
        `(${driven.length} huesos).`
    );
}

/**
 * Avanza el loop. Llamar cada frame ANTES de la
 * actualización del avatar. Devuelve peso actual.
 */
export function updateIdleLoop(delta: number): number {

    if (phase === 'play' && mixer) {

        mixer.update(delta);

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
            return 0;
        }

        return 1;
    }

    return 0;
}
