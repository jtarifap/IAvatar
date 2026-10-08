import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// ============================================================
// ESCENA
// ============================================================

const scene = new THREE.Scene();

scene.background = new THREE.Color(0x20242a);

// ============================================================
// CÁMARA
// ============================================================

const camera = new THREE.PerspectiveCamera(
    30,
    window.innerWidth / window.innerHeight,
    0.1,
    100
);

camera.position.set(0, 1.4, 3);
camera.lookAt(0, 1.2, 0);

// ============================================================
// RENDERER
// ============================================================

const renderer = new THREE.WebGLRenderer({
    antialias: true
});

renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, 2)
);

renderer.setSize(
    window.innerWidth,
    window.innerHeight
);

document.body.appendChild(renderer.domElement);

// ============================================================
// ILUMINACIÓN
// ============================================================

const directionalLight = new THREE.DirectionalLight(
    0xffffff,
    3
);

directionalLight.position.set(1, 2, 2);

scene.add(directionalLight);

const ambientLight = new THREE.AmbientLight(
    0xffffff,
    1.5
);

scene.add(ambientLight);

// ============================================================
// CARGADOR VRM
// ============================================================

const loader = new GLTFLoader();

loader.register((parser) => {
    return new VRMLoaderPlugin(parser);
});

// ============================================================
// AVATAR
// ============================================================

let currentVrm: any = null;

// ============================================================
// VARIABLES DE ANIMACIÓN
// ============================================================

// Movimiento suave de respiración
let breathingTime = 0;

// Parpadeo
let blinkTimer = 0;
let blinkDuration = 0;

// Próximo parpadeo aleatorio
let nextBlink = 2 + Math.random() * 4;

// Movimiento de cabeza
let headTime = Math.random() * 10;

// ============================================================
// CARGAR AVATAR
// ============================================================

loader.load(
    '/models/AvatarSample_C.vrm',

    (gltf) => {

        console.log('Avatar cargado correctamente');

        const vrm = gltf.userData.vrm;

        currentVrm = vrm;

        // Optimización
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);

        // Añadir a la escena
        scene.add(vrm.scene);

        // Mirando hacia la cámara
        vrm.scene.rotation.y = Math.PI;

        // Posición
        vrm.scene.position.set(0, 0, 0);

        // Escala
        vrm.scene.scale.set(1, 1, 1);

        console.log('Avatar preparado para animación');
    },

    (progress) => {

        if (progress.total > 0) {

            const porcentaje =
                (progress.loaded / progress.total) * 100;

            console.log(
                `Cargando avatar: ${porcentaje.toFixed(0)}%`
            );
        }
    },

    (error) => {

        console.error(
            'Error cargando el avatar:',
            error
        );

        const mensaje = document.createElement('div');

        mensaje.textContent =
            'No se pudo cargar AvatarSample_C.vrm';

        mensaje.style.position = 'fixed';
        mensaje.style.top = '20px';
        mensaje.style.left = '20px';
        mensaje.style.padding = '15px';
        mensaje.style.background = '#a00000';
        mensaje.style.color = 'white';
        mensaje.style.fontFamily = 'Arial';

        document.body.appendChild(mensaje);
    }
);

// ============================================================
// ANIMACIÓN
// ============================================================

const clock = new THREE.Clock();

function animate() {

    requestAnimationFrame(animate);

    const delta = clock.getDelta();

    if (currentVrm) {

        currentVrm.update(delta);

        // ----------------------------------------------------
        // TIEMPO
        // ----------------------------------------------------

        breathingTime += delta;
        blinkTimer += delta;
        headTime += delta;

        // ----------------------------------------------------
        // RESPIRACIÓN
        // ----------------------------------------------------

        const breathing =
            Math.sin(breathingTime * 1.5) * 0.008;

        currentVrm.scene.position.y =
            breathing;

        // ----------------------------------------------------
        // MOVIMIENTO SUAVE DE CABEZA
        // ----------------------------------------------------

        const head =
            Math.sin(headTime * 0.5);

        const headSide =
            Math.sin(headTime * 0.35);

        if (currentVrm.humanoid) {

            const headBone =
                currentVrm.humanoid.getNormalizedBoneNode(
                    'head'
                );

            if (headBone) {

                // Movimiento arriba/abajo
                headBone.rotation.x =
                    head * 0.025;

                // Movimiento izquierda/derecha
                headBone.rotation.y =
                    headSide * 0.04;
            }
        }

        // ----------------------------------------------------
        // PARPADEO
        // ----------------------------------------------------

        if (blinkTimer >= nextBlink) {

            blinkTimer = 0;

            blinkDuration = 0;

            nextBlink =
                2 + Math.random() * 4;
        }

        // Durante el parpadeo
        if (blinkTimer < 0.18) {

            const blinkProgress =
                blinkTimer / 0.18;

            // Cerramos y abrimos progresivamente
            const blink =
                Math.sin(
                    blinkProgress * Math.PI
                );

            if (currentVrm.expressionManager) {

                currentVrm.expressionManager.setValue(
                    'blink',
                    blink
                );
            }
        }
        else {

            if (currentVrm.expressionManager) {

                currentVrm.expressionManager.setValue(
                    'blink',
                    0
                );
            }
        }
    }

    // --------------------------------------------------------
    // RENDER
    // --------------------------------------------------------

    renderer.render(
        scene,
        camera
    );
}

animate();

// ============================================================
// REDIMENSIONAR VENTANA
// ============================================================

window.addEventListener(
    'resize',
    () => {

        camera.aspect =
            window.innerWidth /
            window.innerHeight;

        camera.updateProjectionMatrix();

        renderer.setSize(
            window.innerWidth,
            window.innerHeight
        );
    }
);