// ======================================================
// Fachada de avatar FBX (personajes Mixamo)
// ======================================================
// Expone lo mismo que un VRM para que el idle/mirada/
// gestos de main.ts funcionen sin cambios:
//
//   { scene, humanoid: { getNormalizedBoneNode },
//     expressionManager: undefined, lookAt: undefined,
//     meta: { metaVersion: 'fbx' } }
//
// Sin cara: sin expresiones, parpadeo, visemas ni
// mandíbula (el código ya lo tolera con guardas).
// Sin lookAt: la mirada de cabeza sigue funcionando
// (solo usa headBone); el target se omite.

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { VRM_TO_FBX_KEYS, findFbxBone, normalizeFbxKey } from './fbxUtils.js';

export interface FbxRig {
    kind: 'fbx';
    scene: THREE.Object3D;
    humanoid: {
        getNormalizedBoneNode(name: string): THREE.Object3D | null;
    };
    expressionManager: undefined;
    lookAt: undefined;
    meta: { metaVersion: string };
    update: undefined;
    /** Reposo por nombre VRM (para alinear clips). */
    rest: Map<string, THREE.Quaternion>;
}

// Altura objetivo (m): como los AvatarSample VRM
const TARGET_HEIGHT_M = 1.45;

const fbxLoader = new FBXLoader();

export function isFbxFile(file: string): boolean {
    return /\.fbx$/i.test(file || '');
}

function collectBones(root: THREE.Object3D): THREE.Object3D[] {

    const out: THREE.Object3D[] = [];

    root.traverse((obj) => {

        if ((obj as THREE.Object3D & { isBone?: boolean }).isBone) {
            out.push(obj as THREE.Object3D);
        }
    });

    return out;
}

export async function loadFbxRig(file: string): Promise<FbxRig> {

    const group = await fbxLoader.loadAsync(
        `/models/${encodeURIComponent(file)}`
    );

    group.rotation.set(0, 0, 0);
    group.position.set(0, 0, 0);

    // ---------- Auto-escala por altura (Mixamo = cm) ----------
    group.updateMatrixWorld(true);

    const bbox = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    bbox.getSize(size);

    if (size.y > 0.01) {
        const s = TARGET_HEIGHT_M / size.y;
        group.scale.setScalar(s);
    }

    // Pies al suelo
    group.updateMatrixWorld(true);
    const grounded = new THREE.Box3().setFromObject(group);

    if (Number.isFinite(grounded.min.y)) {
        group.position.y -= grounded.min.y;
    }

    // ---------- Mapa VRM -> hueso FBX ----------
    const byVrm = new Map<string, THREE.Object3D>();
    const missing: string[] = [];

    for (const [vrmName, candidates] of Object.entries(VRM_TO_FBX_KEYS)) {

        const bone = findFbxBone(group, candidates);

        if (bone) {
            byVrm.set(vrmName.toLowerCase(), bone);
        } else if (candidates.length) {
            missing.push(vrmName);
        }
    }

    const rest = new Map<string, THREE.Quaternion>();

    for (const [vrmName, bone] of byVrm) {
        rest.set(vrmName, bone.quaternion.clone());
    }

    // ---------- Pose de reposo corregida para FBX ----------
    // El FBX Mixamo trae piernas/brazos arriba; forzamos la
    // pose que el idle procedural espera (-70/70/0/0).
    const DEG = THREE.MathUtils.degToRad;

    const applyRest = (name: string, x: number, y: number, z: number) => {
        const b = byVrm.get(name);
        if (b) b.rotation.set(DEG(x), DEG(y), DEG(z));
    };

    const relaxFingers = (prefix: string) => {
        const joints = ['proximal', 'intermediate', 'distal'];
        for (const f of ['thumb', 'index', 'middle', 'ring', 'little']) {
            for (const j of joints) {
                const b = byVrm.get(`${prefix}${f}${j}`);
                if (b) b.rotation.set(0, 0, 0);
            }
        }
    };

    // Brazos: Mixamo usa Z para arriba/abajo.
    // Abajo = left Z+, right Z- (mirando desde el hombro).
    applyRest('leftupperarm', 0, 0, 70);
    applyRest('rightupperarm', 0, 0, -70);
    applyRest('leftlowerarm', 0, 0, 0);
    applyRest('rightlowerarm', 0, 0, 0);

    // Piernas: reposo extendido (Y hacia abajo en Mixamo)
    applyRest('leftupperleg', 0, 0, 0);
    applyRest('rightupperleg', 0, 0, 0);
    applyRest('leftlowerleg', 0, 0, 0);
    applyRest('rightlowerleg', 0, 0, 0);

    // Dedos: todos relajados
    relaxFingers('left');
    relaxFingers('right');

    // Actualiza matrices para que la malla se deforme en la pose
    group.updateMatrixWorld(true);

    // ---------- Diagnóstico ----------
    const skinned: THREE.SkinnedMesh[] = [];

    group.traverse((obj) => {

        if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
            skinned.push(obj as THREE.SkinnedMesh);
        }
    });

    const deformNames = new Set<string>();

    for (const mesh of skinned) {

        const skel = mesh.skeleton;

        if (!skel) {
            continue;
        }

        for (const b of skel.bones) {
            deformNames.add(normalizeFbxKey(b.name));
        }
    }

    const mappedDeform = [...byVrm.values()].filter((b) =>
        deformNames.size === 0 || deformNames.has(normalizeFbxKey(b.name))
    ).length;

    console.log(
        `[fbx] "${file}": ${byVrm.size} huesos mapeados ` +
        `(${mappedDeform} deforman malla, ${skinned.length} mallas), ` +
        `altura ${(size.y * group.scale.x).toFixed(2)}m` +
        (missing.length ? `, sin resolver: ${missing.join(', ')}` : '')
    );

    return {
        kind: 'fbx',
        scene: group,
        humanoid: {
            getNormalizedBoneNode(name: string): THREE.Object3D | null {
                return byVrm.get(String(name ?? '').toLowerCase()) ?? null;
            }
        },
        expressionManager: undefined,
        lookAt: undefined,
        meta: { metaVersion: 'fbx' },
        update: undefined,
        rest
    };
}
