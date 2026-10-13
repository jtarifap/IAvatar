import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { chat, getApiBase, getConfig, listOllamaModels, setApiBase, setConfig, type ChatMessage } from './ai/client.js';
import { backendVoiceActive, fetchTtsVoices, getVoiceLevel, playBackendVoice, stopBackendVoice, type TtsVoice } from './voice/tts.js';
import { HELP_SECTIONS, CONTACT } from './help/content.js';
import {
    fetchEffects,
    getCachedEffects,
    extractDanceCommand,
    type DanceEffect
} from './motion/effectsCatalog.js';
import {
    attachDanceVrm,
    cancelDance,
    playDance,
    updateDance,
    isDancing,
    currentDanceLabel,
    setDanceEndListener
} from './motion/dancePlayer.js';
import { isFbxFile, loadFbxRig } from './motion/avatarRig.js';
import { startIdleLoop, stopIdleLoop, updateIdleLoop } from './motion/idleLoop.js';

// ======================================================
// APP
// ======================================================

const app = document.getElementById('app')!;

// ======================================================
// THREE
// ======================================================

const scene = new THREE.Scene();

scene.background =
    new THREE.Color(0x111827);

// ------------------------------------------------------
// TEMA CLARO / OSCURO
// ------------------------------------------------------

const DARK_BG = 0x111827;
const LIGHT_BG = 0xe5e7eb;

let isDarkTheme = true;

const camera =
    new THREE.PerspectiveCamera(
        35,
        window.innerWidth / window.innerHeight,
        0.1,
        100
    );

camera.position.set(
    0,
    1.15,
    4.2
);

camera.lookAt(
    0,
    0.85,
    0
);

const renderer =
    new THREE.WebGLRenderer({
        antialias: true
    });

renderer.setPixelRatio(
    Math.min(
        window.devicePixelRatio,
        2
    )
);

renderer.setSize(
    window.innerWidth,
    window.innerHeight
);

app.appendChild(
    renderer.domElement
);

// ======================================================
// CLOCK (declarado pronto: lo usan controls y mouse)
// ======================================================

let elapsedTime =
    0;

// ======================================================
// CAMERA CONTROLS
// ======================================================
// Mouse: drag to rotate, wheel to zoom.
// Touch: drag to rotate and pinch to zoom.
const controls =
    new OrbitControls(
        camera,
        renderer.domElement
    );

controls.target.set(
    0,
    0.85,
    0
);

controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = true;
controls.panSpeed = 0.8;
controls.screenSpacePanning = true;
controls.minDistance = 0.7;
controls.maxDistance = 6.5;

// Allow looking slightly from above and below,
// while keeping the avatar comfortably framed.
controls.minPolarAngle = THREE.MathUtils.degToRad(55);
controls.maxPolarAngle = THREE.MathUtils.degToRad(115);

controls.update();

// ------------------------------------------------------
// BALANCEO LATERAL (estilo visor VRoid Hub, sin giros)
// ------------------------------------------------------
// El avatar mira al frente y bascula a un lado y al otro,
// sin dar nunca la vuelta completa.
let lastCameraInteraction = -10;
const SWAY_RESUME_DELAY = 4;
const SWAY_BASE_YAW = Math.PI;
const SWAY_AMPLITUDE = THREE.MathUtils.degToRad(28);
const SWAY_SPEED = 0.22;

controls.addEventListener(
    'start',
    () => {
        lastCameraInteraction = elapsedTime;
    }
);

controls.addEventListener(
    'end',
    () => {
        lastCameraInteraction = elapsedTime;
    }
);

// Cancela la transición de enfoque si el usuario
// toma la cámara a mitad de camino.
controls.addEventListener(
    'start',
    () => {
        camTransition = null;
    }
);

// ------------------------------------------------------
// ENFOQUE CARA / CUERPO (para ver la boca de cerca)
// ------------------------------------------------------
// Doble click en el avatar: acerca a la cara.
// Doble click fuera o mismo gesto: vuelve al cuerpo.
// El objetivo se limita para no perder al avatar.

const BODY_TARGET = new THREE.Vector3(0, 0.85, 0);
const FACE_DISTANCE = 1.1;
const BODY_DISTANCE = 4.0;

let faceFocused = false;
let faceFocusAppliedOnStart = false;

interface CamTransition {
    t: number;
    dur: number;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
}

let camTransition: CamTransition | null = null;

function clampCameraTarget() {

    controls.target.x = THREE.MathUtils.clamp(
        controls.target.x, -1, 1
    );
    controls.target.y = THREE.MathUtils.clamp(
        controls.target.y, 0.3, 1.7
    );
    controls.target.z = THREE.MathUtils.clamp(
        controls.target.z, -1, 1
    );
}

function flyTo(target: THREE.Vector3, distance: number) {

    const dir = camera.position
        .clone()
        .sub(controls.target);

    if (dir.lengthSq() < 1e-6) {
        dir.set(0, 0.2, 1);
    }

    dir.normalize();

    camTransition = {
        t: 0,
        dur: 0.8,
        fromTarget: controls.target.clone(),
        toTarget: target.clone(),
        fromPos: camera.position.clone(),
        toPos: target.clone().addScaledVector(dir, distance)
    };
}

function focusFace() {

    faceFocused = true;

    const headPos = new THREE.Vector3(0, 1.38, 0);

    if (headBone) {
        headBone.getWorldPosition(headPos);
    } else if (currentVrm) {
        headPos.setFromMatrixPosition(currentVrm.scene.matrixWorld);
        headPos.y += 1.38;
    }

    // Un poco por debajo de la cabeza para encuadrar la boca
    headPos.y -= 0.06;

    flyTo(headPos, FACE_DISTANCE);
    refreshFaceButton();
}

function focusBody() {

    faceFocused = false;

    flyTo(BODY_TARGET, BODY_DISTANCE);
    refreshFaceButton();
}

function toggleFaceFocus() {

    if (faceFocused) {
        focusBody();
    } else {
        focusFace();
    }
}

function updateCamTransition(delta: number) {

    if (!camTransition) {
        return;
    }

    camTransition.t += delta;

    const p = Math.min(
        1,
        camTransition.t / camTransition.dur
    );

    const eased =
        p * p * (3 - 2 * p);

    controls.target.lerpVectors(
        camTransition.fromTarget,
        camTransition.toTarget,
        eased
    );

    camera.position.lerpVectors(
        camTransition.fromPos,
        camTransition.toPos,
        eased
    );

    if (p >= 1) {
        camTransition = null;
    }
}

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

renderer.domElement.addEventListener(
    'dblclick',
    (event) => {

        pointerNdc.x =
            (event.clientX / window.innerWidth) * 2 - 1;

        pointerNdc.y =
            -((event.clientY / window.innerHeight) * 2 - 1);

        raycaster.setFromCamera(pointerNdc, camera);

        const hits = currentVrm
            ? raycaster.intersectObject(currentVrm.scene, true)
            : [];

        if (hits.length > 0) {
            focusFace();
        } else {
            focusBody();
        }
    }
);

// ------------------------------------------------------
// MOUSE FOLLOW (mirada estilo VRoid Hub)
// ------------------------------------------------------
// Guarda el puntero normalizado; updateHumanMotion lo mezcla
// con la mirada aleatoria durante unos segundos tras moverlo.
const mousePointer = {
    x: 0,
    y: 0,
    lastMove: -10
};

window.addEventListener(
    'pointermove',
    (event) => {
        mousePointer.x =
            (event.clientX / window.innerWidth) * 2 - 1;

        mousePointer.y =
            -((event.clientY / window.innerHeight) * 2 - 1);

        mousePointer.lastMove = elapsedTime;
    }
);

// ======================================================
// LIGHT
// ======================================================

const ambientLight =
    new THREE.AmbientLight(
        0xffffff,
        2
    );

scene.add(
    ambientLight
);

const directionalLight =
    new THREE.DirectionalLight(
        0xffffff,
        2
    );

directionalLight.position.set(
    1,
    2,
    3
);

scene.add(
    directionalLight
);

// ======================================================
// UI
// ======================================================

const interfaceContainer =
    document.createElement('div');

interfaceContainer.style.position =
    'absolute';

interfaceContainer.style.top = '0';
interfaceContainer.style.left = '0';

interfaceContainer.style.width =
    '100%';

interfaceContainer.style.height =
    '100%';

interfaceContainer.style.pointerEvents =
    'none';

app.appendChild(
    interfaceContainer
);

// ======================================================
// HEADER
// ======================================================

const header =
    document.createElement('div');

header.style.position =
    'absolute';

header.style.top = '20px';
header.style.left = '30px';

header.style.display = 'flex';
header.style.alignItems = 'center';
header.style.gap = '12px';

header.style.color =
    'white';

header.innerHTML = `
    <img
        id="paseta-logo"
        src="/images/paseta-icono.png"
        alt="Logo de Paseta"
        style="
            width:74px;
            height:74px;
            border-radius:18px;
            box-shadow:0 2px 10px rgba(0,0,0,0.35);
        "
    >

    <div>
        <div id="paseta-title" style="
            font-family:'Bangers', 'Arial Black', cursive;
            font-size:40px;
            letter-spacing:3px;
            line-height:1;
            background:linear-gradient(180deg, #ff5f8f 20%, #ff9a3d 90%);
            -webkit-background-clip:text;
            background-clip:text;
            color:transparent;
            filter:drop-shadow(2px 2px 0 rgba(17,24,39,0.9));
            transform:rotate(-2deg);
        ">
            Paseta
        </div>

        <div id="paseta-subtitle" style="
            font-family:'M PLUS Rounded 1c', Arial, sans-serif;
            font-weight:700;
            font-size:14px;
            opacity:0.85;
            margin-top:6px;
        ">
            La colega virtual que lo sabe casi todo! 😛
        </div>
    </div>
`;

interfaceContainer.appendChild(
    header
);

const headerLogo = header.querySelector(
    '#paseta-logo'
) as HTMLImageElement;

const headerTitle = header.querySelector(
    '#paseta-title'
) as HTMLDivElement;

const headerSubtitle = header.querySelector(
    '#paseta-subtitle'
) as HTMLDivElement;

// ======================================================
// STATUS
// ======================================================

const statusContainer =
    document.createElement('div');

statusContainer.style.position =
    'absolute';

statusContainer.style.top = '20px';
statusContainer.style.right = '124px';
statusContainer.style.padding = '6px 14px';
statusContainer.style.borderRadius = '20px';
statusContainer.style.background = 'rgba(128,128,128,0.25)';
statusContainer.style.backdropFilter = 'blur(10px)';
statusContainer.style.whiteSpace = 'nowrap';
statusContainer.style.zIndex = '20';

statusContainer.style.color =
    '#86efac';

statusContainer.style.fontSize =
    '15px';

statusContainer.innerHTML =
    '● Esperando';

interfaceContainer.appendChild(
    statusContainer
);

// ======================================================
// THEME TOGGLE (claro / oscuro, icono profesional)
// ======================================================

const SUN_ICON = `
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.8"/>
        <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;

const MOON_ICON = `
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>`;

const themeButton =
    document.createElement('button');

themeButton.type = 'button';
themeButton.title = 'Cambiar a modo claro';
themeButton.setAttribute('aria-label', 'Cambiar tema claro u oscuro');
themeButton.innerHTML = MOON_ICON;
themeButton.style.position = 'absolute';
themeButton.style.top = '16px';
themeButton.style.right = '26px';
themeButton.style.width = '40px';
themeButton.style.height = '40px';
themeButton.style.display = 'flex';
themeButton.style.alignItems = 'center';
themeButton.style.justifyContent = 'center';
themeButton.style.border = '1px solid rgba(255,255,255,0.22)';
themeButton.style.borderRadius = '50%';
themeButton.style.background = 'rgba(0,0,0,0.45)';
themeButton.style.backdropFilter = 'blur(10px)';
themeButton.style.color = 'white';
themeButton.style.cursor = 'pointer';
themeButton.style.pointerEvents = 'auto';
themeButton.style.zIndex = '20';

interfaceContainer.appendChild(
    themeButton
);

function setTheme(dark: boolean) {

    isDarkTheme = dark;

    (scene.background as THREE.Color).setHex(
        dark ? DARK_BG : LIGHT_BG
    );

    header.style.color = dark ? 'white' : '#111827';

    messagePanel.style.background = dark
        ? 'rgba(0,0,0,0.55)'
        : 'rgba(255,255,255,0.82)';

    messagePanel.style.color = dark ? 'white' : '#111827';

    messagePanel.style.border = dark
        ? 'none'
        : '1px solid rgba(0,0,0,0.08)';

    moodPanel.style.background = dark
        ? 'rgba(0,0,0,0.55)'
        : 'rgba(255,255,255,0.85)';

    moodPanel.style.border = dark
        ? 'none'
        : '1px solid rgba(0,0,0,0.08)';

    themeButton.innerHTML = dark ? MOON_ICON : SUN_ICON;
    themeButton.title = dark
        ? 'Cambiar a modo claro'
        : 'Cambiar a modo oscuro';
    themeButton.style.background = dark
        ? 'rgba(0,0,0,0.45)'
        : 'rgba(255,255,255,0.85)';
    themeButton.style.color = dark ? 'white' : '#111827';
    themeButton.style.border = dark
        ? '1px solid rgba(255,255,255,0.22)'
        : '1px solid rgba(0,0,0,0.12)';

    if (typeof avatarButton !== 'undefined') {

        avatarButton.style.background = dark
            ? 'rgba(0,0,0,0.45)'
            : 'rgba(255,255,255,0.85)';
        avatarButton.style.color = dark ? 'white' : '#111827';
        avatarButton.style.border = dark
            ? '1px solid rgba(255,255,255,0.22)'
            : '1px solid rgba(0,0,0,0.12)';
    }

    if (typeof avatarPanel !== 'undefined') {

        avatarPanel.style.background = dark
            ? 'rgba(0,0,0,0.55)'
            : 'rgba(255,255,255,0.85)';

        avatarPanel.style.border = dark
            ? 'none'
            : '1px solid rgba(0,0,0,0.08)';
    }

    if (typeof iaButton !== 'undefined') {

        iaButton.style.background = dark
            ? 'rgba(0,0,0,0.45)'
            : 'rgba(255,255,255,0.85)';
        iaButton.style.color = dark ? 'white' : '#111827';
        iaButton.style.border = dark
            ? '1px solid rgba(255,255,255,0.22)'
            : '1px solid rgba(0,0,0,0.12)';
    }

    if (typeof iaPanel !== 'undefined') {

        iaPanel.style.background = dark
            ? 'rgba(0,0,0,0.55)'
            : 'rgba(255,255,255,0.85)';

        iaPanel.style.color = dark ? 'white' : '#111827';

        iaPanel.style.border = dark
            ? 'none'
            : '1px solid rgba(0,0,0,0.08)';
    }

    if (typeof refreshFaceButton !== 'undefined') {
        refreshFaceButton();
    }

    if (typeof historyButton !== 'undefined') {

        historyButton.style.background = dark
            ? 'rgba(0,0,0,0.45)'
            : 'rgba(255,255,255,0.85)';
        historyButton.style.color = dark ? 'white' : '#111827';
        historyButton.style.border = dark
            ? '1px solid rgba(255,255,255,0.22)'
            : '1px solid rgba(0,0,0,0.12)';
    }

    if (typeof historyPanel !== 'undefined') {

        historyPanel.style.background = dark
            ? 'rgba(0,0,0,0.55)'
            : 'rgba(255,255,255,0.85)';

        historyPanel.style.color = dark ? 'white' : '#111827';

        historyPanel.style.border = dark
            ? 'none'
            : '1px solid rgba(0,0,0,0.08)';
    }

    if (typeof renderHistory !== 'undefined') {
        renderHistory();
    }

    if (typeof helpButton !== 'undefined') {

        helpButton.style.background = dark
            ? 'rgba(0,0,0,0.45)'
            : 'rgba(255,255,255,0.85)';
        helpButton.style.color = dark ? 'white' : '#111827';
        helpButton.style.border = dark
            ? '1px solid rgba(255,255,255,0.22)'
            : '1px solid rgba(0,0,0,0.12)';
    }

    if (typeof helpCard !== 'undefined') {

        helpCard.style.background = dark
            ? 'rgba(20,22,28,0.97)'
            : 'rgba(255,255,255,0.97)';

        helpCard.style.color = dark ? 'white' : '#111827';

        helpCard.style.border = dark
            ? 'none'
            : '1px solid rgba(0,0,0,0.1)';
    }

    if (typeof helpBody !== 'undefined') {

        for (const child of Array.from(helpBody.children)) {

            (child as HTMLElement).style.background = dark
                ? 'rgba(255,255,255,0.07)'
                : 'rgba(0,0,0,0.05)';
        }
    }

    if (typeof menuButton !== 'undefined') {

        menuButton.style.background = dark
            ? 'rgba(0,0,0,0.45)'
            : 'rgba(255,255,255,0.85)';
        menuButton.style.color = dark ? 'white' : '#111827';
        menuButton.style.border = dark
            ? '1px solid rgba(255,255,255,0.22)'
            : '1px solid rgba(0,0,0,0.12)';
    }

    if (typeof menuPanel !== 'undefined') {

        menuPanel.style.background = dark
            ? 'rgba(0,0,0,0.55)'
            : 'rgba(255,255,255,0.85)';

        menuPanel.style.border = dark
            ? 'none'
            : '1px solid rgba(0,0,0,0.08)';
    }

    refreshMoodButtons();
    refreshDanceUI();

    if (typeof refreshAvatarButtons !== 'undefined') {
        refreshAvatarButtons();
    }

    // Repinta el estado con sus colores de tema
    setStatus(currentStatus);
}

themeButton.addEventListener(
    'click',
    () => {
        setTheme(!isDarkTheme);
        textInput.focus();
    }
);

// ======================================================
// MESSAGE
// ======================================================

const messagePanel =
    document.createElement('div');

messagePanel.style.position =
    'absolute';

messagePanel.style.left =
    '50%';

messagePanel.style.bottom =
    '120px';

messagePanel.style.transform =
    'translateX(-50%)';

messagePanel.style.width =
    'min(700px, 80%)';

messagePanel.style.padding =
    '16px 20px';

messagePanel.style.borderRadius =
    '14px';

messagePanel.style.background =
    'rgba(0,0,0,0.55)';

messagePanel.style.backdropFilter =
    'blur(10px)';

messagePanel.style.color =
    'white';

messagePanel.style.fontSize =
    '17px';

messagePanel.style.textAlign =
    'center';

messagePanel.style.minHeight =
    '50px';

interfaceContainer.appendChild(
    messagePanel
);

// ======================================================
// CHAT COMPOSER
// ======================================================

const textInputContainer =
    document.createElement('div');

textInputContainer.style.position = 'absolute';
textInputContainer.style.left = '50%';
textInputContainer.style.bottom = '24px';
textInputContainer.style.transform = 'translateX(-50%)';
textInputContainer.style.width = 'min(760px, calc(100% - 32px))';
textInputContainer.style.height = '58px';
textInputContainer.style.display = 'flex';
textInputContainer.style.alignItems = 'center';
textInputContainer.style.boxSizing = 'border-box';
textInputContainer.style.padding = '7px 8px';
textInputContainer.style.gap = '6px';
textInputContainer.style.background = 'rgba(255,255,255,0.97)';
textInputContainer.style.border = '1px solid rgba(0,0,0,0.08)';
textInputContainer.style.borderRadius = '30px';
textInputContainer.style.boxShadow = '0 2px 12px rgba(0,0,0,0.10)';
textInputContainer.style.pointerEvents = 'auto';
textInputContainer.style.zIndex = '20';

interfaceContainer.appendChild(
    textInputContainer
);

// PLUS
const plusButton =
    document.createElement('button');

plusButton.type = 'button';
plusButton.innerHTML = '+';
plusButton.title = 'Más opciones';
plusButton.setAttribute('aria-label', 'Más opciones');
plusButton.style.width = '42px';
plusButton.style.height = '42px';
plusButton.style.flex = '0 0 42px';
plusButton.style.border = 'none';
plusButton.style.background = 'transparent';
plusButton.style.color = '#202123';
plusButton.style.fontSize = '31px';
plusButton.style.fontWeight = '300';
plusButton.style.lineHeight = '1';
plusButton.style.cursor = 'pointer';

textInputContainer.appendChild(
    plusButton
);

// INPUT
const textInput =
    document.createElement('input');

textInput.type = 'text';
textInput.placeholder = 'Pregunta lo que quieras';
textInput.autocomplete = 'off';
textInput.style.flex = '1 1 auto';
textInput.style.minWidth = '0';
textInput.style.height = '44px';
textInput.style.padding = '0 8px';
textInput.style.border = 'none';
textInput.style.outline = 'none';
textInput.style.background = 'transparent';
textInput.style.color = '#202123';
textInput.style.fontSize = '17px';
textInput.style.fontFamily = 'inherit';

textInputContainer.appendChild(
    textInput
);

// THINKING BUTTON (oculto por ahora: no hace nada y
// quita espacio al texto de entrada)
const thinkingButton =
    document.createElement('button');

thinkingButton.type = 'button';
thinkingButton.style.display = 'none';

thinkingButton.type = 'button';
thinkingButton.innerHTML = '🧠 <span style="font-size:16px;">Pensar</span>';
thinkingButton.title = 'Activar pensamiento';
thinkingButton.setAttribute('aria-label', 'Activar pensamiento');
thinkingButton.style.display = 'none';
// (resto de estilos intactos por si se reactiva)
thinkingButton.style.alignItems = 'center';
thinkingButton.style.gap = '5px';
thinkingButton.style.height = '42px';
thinkingButton.style.padding = '0 9px';
thinkingButton.style.border = 'none';
thinkingButton.style.borderRadius = '12px';
thinkingButton.style.background = 'transparent';
thinkingButton.style.color = '#6b7280';
thinkingButton.style.cursor = 'pointer';
thinkingButton.style.fontSize = '17px';
thinkingButton.style.whiteSpace = 'nowrap';

textInputContainer.appendChild(
    thinkingButton
);

let thinkingEnabled = false;

thinkingButton.addEventListener(
    'click',
    () => {
        thinkingEnabled = !thinkingEnabled;
        thinkingButton.style.background =
            thinkingEnabled
                ? '#eef2ff'
                : 'transparent';
        thinkingButton.style.color =
            thinkingEnabled
                ? '#4f46e5'
                : '#6b7280';
    }
);

// MICROPHONE
const microphoneButton =
    document.createElement('button');

microphoneButton.type = 'button';
microphoneButton.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 0 0-7 0v5a3.5 3.5 0 0 0 3.5 3.5Z" stroke="currentColor" stroke-width="1.8"/>
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
microphoneButton.title = 'Hablar';
microphoneButton.setAttribute('aria-label', 'Hablar');
microphoneButton.style.width = '42px';
microphoneButton.style.height = '42px';
microphoneButton.style.flex = '0 0 42px';
microphoneButton.style.display = 'flex';
microphoneButton.style.alignItems = 'center';
microphoneButton.style.justifyContent = 'center';
microphoneButton.style.border = 'none';
microphoneButton.style.borderRadius = '50%';
microphoneButton.style.background = 'transparent';
microphoneButton.style.color = '#202123';
microphoneButton.style.cursor = 'pointer';

textInputContainer.appendChild(
    microphoneButton
);

// SEND / VOICE-MODE BUTTON
const sendButton =
    document.createElement('button');

sendButton.type = 'button';
sendButton.innerHTML = `
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 12h13M13 6l6 6-6 6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
sendButton.title = 'Enviar';
sendButton.setAttribute('aria-label', 'Enviar');
sendButton.style.width = '42px';

const SEND_ICON = `
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 12h13M13 6l6 6-6 6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

const STOP_ICON = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2" fill="white"/>
    </svg>`;

function refreshSendButton() {

    const busy =
        currentStatus === 'thinking' || currentStatus === 'speaking';

    sendButton.innerHTML = busy ? STOP_ICON : SEND_ICON;
    sendButton.title = busy ? 'Parar' : 'Enviar';
    sendButton.setAttribute('aria-label', busy ? 'Parar' : 'Enviar');
    sendButton.style.background = busy ? '#ef4444' : '#3b82f6';
}
sendButton.style.height = '42px';
sendButton.style.flex = '0 0 42px';
sendButton.style.display = 'flex';
sendButton.style.alignItems = 'center';
sendButton.style.justifyContent = 'center';
sendButton.style.border = 'none';
sendButton.style.borderRadius = '50%';
sendButton.style.background = '#3b82f6';
sendButton.style.color = 'white';
sendButton.style.cursor = 'pointer';

textInputContainer.appendChild(
    sendButton
);

// ======================================================
// EXPRESSION PRESETS (estilo visor VRoid Hub)
// ======================================================

const MOODS = [
    { id: 'happy', label: 'Feliz' },
    { id: 'angry', label: 'Enfadado' },
    { id: 'sad', label: 'Triste' },
    { id: 'relaxed', label: 'Relajado' },
    { id: 'surprised', label: 'Sorprendido' },
    { id: 'neutral', label: 'Neutral' }
];

const MOOD_EXPRESSIONS = MOODS
    .map((m) => m.id)
    .filter((id) => id !== 'neutral');

let activeMood: string | null =
    'relaxed';

function clearExpressions() {

    if (!currentVrm?.expressionManager) {
        return;
    }

    for (const name of MOOD_EXPRESSIONS) {

        try {

            currentVrm.expressionManager.setValue(
                name,
                0
            );

        } catch {
            // Expresión no definida en este modelo: ignorar.
        }
    }
}

function applyMood(mood: string | null) {

    activeMood = mood;

    clearExpressions();

    if (
        !mood ||
        !currentVrm?.expressionManager
    ) {
        return;
    }

    try {

        currentVrm.expressionManager.setValue(
            mood,
            mood === 'relaxed' ? 0.35 : 0.8
        );

    } catch {
        // Expresión no definida en este modelo: ignorar.
    }
}

// ======================================================
// EMOTICONOS -> EXPRESIÓN (no se leen en voz alta)
// ======================================================
// :) :( :D... y emojis 😊😢😡 se convierten en la
// expresión del menú Más opciones y se quitan del texto
// que se envía a la IA y a la voz.

const EMOTICON_MOODS: { mood: string; tokens: string[] }[] = [
    { mood: 'angry', tokens: ['>:-(', '>:(', '😡', '😠', '🤬', '👎'] },
    { mood: 'happy', tokens: [':-)', ':)', ':-D', ':D', '=D', 'XD', 'xd', '😊', '😁', '😄', '😃', '😀', '😍', '❤️', '❤', '👍'] },
    { mood: 'sad', tokens: [":'-(", ":'(", ':-(', ':(', '😢', '😭', '😞', '🙁', '☹', '😔'] },
    { mood: 'surprised', tokens: [':-O', ':O', ':o', ':0', '😮', '😲', '😱'] },
    { mood: 'relaxed', tokens: ['😌', '😴', '💤'] },
    { mood: 'neutral', tokens: [':-|', ':|', ':-/', ':/', '😐', '😑'] }
];

interface EmoticonResult {
    mood: string | null;
    cleaned: string;
}

function extractEmoticons(text: string): EmoticonResult {

    const lower = text.toLowerCase();

    interface Hit {
        index: number;
        length: number;
        mood: string;
    }

    const hits: Hit[] = [];

    for (const { mood, tokens } of EMOTICON_MOODS) {

        for (const token of tokens) {

            const needle = token.toLowerCase();
            let from = 0;

            while (true) {

                const at = lower.indexOf(needle, from);

                if (at < 0) {
                    break;
                }

                hits.push({ index: at, length: needle.length, mood });

                from = at + needle.length;
            }
        }
    }

    if (!hits.length) {
        return { mood: null, cleaned: text };
    }

    // Ordena por posición; ante solapes (">:(" contiene ":(")
    // gana el token más largo que empieza antes.
    hits.sort(
        (a, b) => a.index - b.index || b.length - a.length
    );

    const kept: Hit[] = [];

    for (const hit of hits) {

        const overlaps = kept.some(
            (k) => hit.index < k.index + k.length
        );

        if (!overlaps) {
            kept.push(hit);
        }
    }

    // Quita los emoticonos del texto (de atrás a adelante
    // para no mover los índices).
    let cleaned = text;

    for (const hit of [...kept].reverse()) {

        cleaned =
            cleaned.slice(0, hit.index) +
            ' ' +
            cleaned.slice(hit.index + hit.length);
    }

    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Manda el último emoticono escrito
    const mood = kept[kept.length - 1].mood;

    return { mood, cleaned };
}

// ======================================================
// ÓRDENES DE EXPRESIÓN EN ESPAÑOL
// ======================================================
// "pon cara triste", "sonríe", "haz cara de enfadado"...
// Se aplican directamente sin pasar por la IA.

const EXPRESSION_COMMAND_MOODS: { mood: string; words: string[] }[] = [
    { mood: 'happy', words: ['feliz', 'contento', 'contenta', 'alegre', 'sonriente'] },
    { mood: 'sad', words: ['triste'] },
    { mood: 'angry', words: ['enfadado', 'enfadada', 'enfado', 'enojado', 'enojada', 'enojo', 'cabreado', 'cabreada'] },
    { mood: 'surprised', words: ['sorprendido', 'sorprendida', 'sorpresa', 'asombro', 'asombrado'] },
    { mood: 'relaxed', words: ['relajado', 'relajada', 'tranquilo', 'tranquila'] },
    { mood: 'neutral', words: ['neutra', 'neutro', 'normal', 'serio', 'seria'] }
];

const COMMAND_VERBS = /\b(pon|ponte|haz|hazme|muestra|muestrame|muéstrame|quiero|dame|cambia|cámbiate|cambiate|finge)\b/;

const MOOD_ACK: Record<string, string> = {
    happy: '¡Hecho, con una sonrisa!',
    sad: 'De acuerdo, pongo cara triste.',
    angry: 'Entendido, cara de enfado.',
    surprised: '¡Vaya, qué sorpresa!',
    relaxed: 'Relajado, como me pides.',
    neutral: 'De acuerdo, cara neutra.'
};

interface CommandResult {
    mood: string | null;
    cleaned: string;
    isPureCommand: boolean;
}

function extractExpressionCommand(text: string): CommandResult {

    const empty: CommandResult = { mood: null, cleaned: text, isPureCommand: false };

    const sentences = text
        .split(/(?<=[.!?;])\s+|\n+/)
        .map((s) => s.trim())
        .filter(Boolean);

    if (!sentences.length) {
        return empty;
    }

    let mood: string | null = null;
    const rest: string[] = [];

    for (const sentence of sentences) {

        const lower = ` ${sentence.toLowerCase()} `;

        let found: string | null = null;

        // "sonríe" solo ya es una orden
        if (/\bsonr[ií]e\b/.test(lower)) {
            found = 'happy';
        } else if (COMMAND_VERBS.test(lower)) {

            for (const { mood: m, words } of EXPRESSION_COMMAND_MOODS) {

                if (words.some((w) => lower.includes(w))) {
                    found = m;
                    break;
                }
            }
        }

        if (found) {
            mood = found;
        } else {
            rest.push(sentence);
        }
    }

    if (!mood) {
        return empty;
    }

    return {
        mood,
        cleaned: rest.join(' ').trim(),
        isPureCommand: rest.length === 0
    };
}

// Quita de la voz narraciones tipo *sonríe* que algunos
// modelos pequeños escriben, para que no se lean en alto.
function cleanSpeechText(text: string): string {

    return text
        .replace(/\*[^*]+\*/g, ' ')
        .replace(/_[^_]+_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const moodPanel =
    document.createElement('div');

moodPanel.style.position = 'absolute';
moodPanel.style.left = '30px';
moodPanel.style.bottom = '95px';
moodPanel.style.display = 'none';
moodPanel.style.flexDirection = 'column';
moodPanel.style.gap = '8px';
moodPanel.style.maxWidth = '320px';
moodPanel.style.minWidth = '260px';
moodPanel.style.padding = '10px';
moodPanel.style.borderRadius = '16px';
moodPanel.style.background = 'rgba(0,0,0,0.55)';
moodPanel.style.backdropFilter = 'blur(10px)';
moodPanel.style.pointerEvents = 'auto';
moodPanel.style.zIndex = '20';

function setMoodPanelVisible(visible: boolean) {
    moodPanel.style.display = visible ? 'flex' : 'none';
    plusButton.style.transform = visible ? 'rotate(45deg)' : 'none';
}

// ------------------------------------------------------
// PESTAÑAS DEL PANEL + (Expresiones / Bailes / ...)
// ------------------------------------------------------

type PlusTab = 'mood' | 'dance';

let plusTab: PlusTab = 'mood';

const tabBar =
    document.createElement('div');

tabBar.style.display = 'flex';
tabBar.style.gap = '6px';

moodPanel.appendChild(
    tabBar
);

function styleTabButton(
    button: HTMLButtonElement,
    selected: boolean
) {

    button.style.flex = '1 1 auto';
    button.style.padding = '7px 6px';
    button.style.borderRadius = '12px';
    button.style.fontSize = '13px';
    button.style.cursor = 'pointer';

    if (isDarkTheme) {

        button.style.background = selected
            ? 'rgba(255,255,255,0.9)'
            : 'transparent';
        button.style.color = selected
            ? '#111827'
            : 'white';
        button.style.border =
            '1px solid rgba(255,255,255,0.25)';

    } else {

        button.style.background = selected
            ? '#111827'
            : 'transparent';
        button.style.color = selected
            ? 'white'
            : '#111827';
        button.style.border =
            '1px solid rgba(0,0,0,0.18)';
    }
}

const tabMoodButton =
    document.createElement('button');

tabMoodButton.type = 'button';
tabMoodButton.textContent = '😊 Expresiones';
tabMoodButton.title = 'Expresiones de la cara';
tabMoodButton.setAttribute('aria-label', 'Pestaña expresiones');

tabMoodButton.addEventListener(
    'click',
    () => {
        setPlusTab('mood');
        textInput.focus();
    }
);

tabBar.appendChild(
    tabMoodButton
);

const tabDanceButton =
    document.createElement('button');

tabDanceButton.type = 'button';
tabDanceButton.textContent = '💃 Bailes';
tabDanceButton.title = 'Bailes (carpeta efects)';
tabDanceButton.setAttribute('aria-label', 'Pestaña bailes');

tabDanceButton.addEventListener(
    'click',
    () => {
        setPlusTab('dance');
        void refreshDanceList();
        textInput.focus();
    }
);

// PESTAÑA BAILES DESACTIVADA temporalmente (el baile no
// quedaba natural). Para reactivarla, descomentar estas
// tres líneas y el bloque 3) de sendQuestion.
// tabBar.appendChild(
//     tabDanceButton
// );

// Contenedor de expresiones (los botones de MOODS
// se crean más abajo dentro de este contenedor).
const moodGrid =
    document.createElement('div');

moodGrid.style.display = 'flex';
moodGrid.style.flexWrap = 'wrap';
moodGrid.style.gap = '6px';

moodPanel.appendChild(
    moodGrid
);

// ------------------------------------------------------
// PESTAÑA BAILES (lista viva de public/efects)
// ------------------------------------------------------

const dancePane =
    document.createElement('div');

dancePane.style.display = 'none';
dancePane.style.flexDirection = 'column';
dancePane.style.gap = '6px';

moodPanel.appendChild(
    dancePane
);

const danceStatus =
    document.createElement('div');

danceStatus.style.fontSize = '12px';
danceStatus.style.opacity = '0.75';
danceStatus.style.color = 'white';
danceStatus.textContent = 'Bailes de la carpeta efects.';

dancePane.appendChild(
    danceStatus
);

const danceList =
    document.createElement('div');

danceList.style.display = 'flex';
danceList.style.flexWrap = 'wrap';
danceList.style.gap = '6px';

dancePane.appendChild(
    danceList
);

const stopDanceButton =
    document.createElement('button');

stopDanceButton.type = 'button';
stopDanceButton.textContent = '⏹ Detener baile';
stopDanceButton.title = 'Detiene el baile y vuelve a la pose inicial';
stopDanceButton.setAttribute('aria-label', 'Detener baile');
stopDanceButton.style.display = 'none';
stopDanceButton.style.padding = '8px 12px';
stopDanceButton.style.borderRadius = '18px';
stopDanceButton.style.fontSize = '13px';
stopDanceButton.style.cursor = 'pointer';
stopDanceButton.style.border = '1px solid rgba(239,68,68,0.6)';
stopDanceButton.style.background = 'rgba(239,68,68,0.2)';
stopDanceButton.style.color = 'white';

stopDanceButton.addEventListener(
    'click',
    () => {
        cancelDance();
        refreshDanceUI();
        textInput.focus();
    }
);

dancePane.appendChild(
    stopDanceButton
);

const danceButtons: Record<string, HTMLButtonElement> = {};

function styleDanceButton(
    button: HTMLButtonElement,
    dancing: boolean
) {

    button.style.padding = '8px 12px';
    button.style.borderRadius = '18px';
    button.style.fontSize = '13px';
    button.style.cursor = dancing ? 'default' : 'pointer';
    button.style.opacity = dancing ? '0.45' : '1';

    if (isDarkTheme) {

        button.style.background = 'transparent';
        button.style.color = 'white';
        button.style.border =
            '1px solid rgba(255,255,255,0.25)';

    } else {

        button.style.background = 'transparent';
        button.style.color = '#111827';
        button.style.border =
            '1px solid rgba(0,0,0,0.18)';
    }
}

function setPlusTab(tab: PlusTab) {

    plusTab = tab;

    const showDance = tab === 'dance';

    moodGrid.style.display = showDance ? 'none' : 'flex';
    dancePane.style.display = showDance ? 'flex' : 'none';

    styleTabButton(tabMoodButton, !showDance);
    styleTabButton(tabDanceButton, showDance);
}

function refreshDanceUI() {

    const dancing = isDancing();

    stopDanceButton.style.display = dancing ? 'block' : 'none';

    danceStatus.textContent = dancing
        ? `💃 Bailando: ${currentDanceLabel()}…`
        : 'Bailes de la carpeta efects. Se reproducen una vez.';

    for (const btn of Object.values(danceButtons)) {
        styleDanceButton(btn, dancing);
    }

    styleTabButton(tabMoodButton, plusTab === 'mood');
    styleTabButton(tabDanceButton, plusTab === 'dance');
}

async function refreshDanceList() {

    danceStatus.textContent = 'Buscando bailes en efects…';
    danceStatus.style.color = 'white';

    const effects = await fetchEffects(true);

    danceList.innerHTML = '';

    for (const key of Object.keys(danceButtons)) {
        delete danceButtons[key];
    }

    if (!effects.length) {
        danceStatus.textContent =
            'No hay bailes en public/efects.';
        return;
    }

    for (const effect of effects) {

        const button =
            document.createElement('button');

        button.type = 'button';
        button.textContent = `💃 ${effect.label}`;
        button.title = `Bailar: ${effect.label} (una vez)`;
        button.setAttribute('aria-label', `Bailar ${effect.label}`);

        styleDanceButton(button, isDancing());

        button.addEventListener(
            'click',
            () => {
                void runDance(effect, button);
                textInput.focus();
            }
        );

        danceButtons[effect.id] = button;

        danceList.appendChild(
            button
        );
    }

    refreshDanceUI();
}

async function runDance(
    effect: DanceEffect,
    fromButton?: HTMLButtonElement
) {

    if (isDancing()) {
        return;
    }

    if (fromButton) {
        fromButton.textContent = '⏳ Cargando…';
    }

    messagePanel.textContent =
        `💃 Bailando: ${effect.label}…`;

    refreshDanceUI();

    try {

        await playDance(effect);

    } catch (err) {

        console.error(err);

        const detail = err instanceof Error
            ? err.message
            : 'No se pudo reproducir el baile.';

        messagePanel.textContent = detail;

    } finally {

        if (fromButton) {
            fromButton.textContent = `💃 ${effect.label}`;
        }

        refreshDanceUI();
    }
}

setDanceEndListener(() => {
    refreshDanceUI();
});

const moodButtons: Record<string, HTMLButtonElement> = {};

function refreshMoodButtons() {

    for (const [id, btn] of Object.entries(moodButtons)) {

        const selected =
            (activeMood ?? 'neutral') === id;

        if (isDarkTheme) {

            btn.style.background =
                selected
                    ? 'rgba(255,255,255,0.9)'
                    : 'transparent';
            btn.style.color =
                selected
                    ? '#111827'
                    : 'white';
            btn.style.border =
                '1px solid rgba(255,255,255,0.25)';

        } else {

            btn.style.background =
                selected
                    ? '#111827'
                    : 'transparent';
            btn.style.color =
                selected
                    ? 'white'
                    : '#111827';
            btn.style.border =
                '1px solid rgba(0,0,0,0.18)';
        }
    }
}

for (const mood of MOODS) {

    const button =
        document.createElement('button');

    button.type = 'button';
    button.textContent = mood.label;
    button.title = `Expresión: ${mood.label}`;
    button.setAttribute('aria-label', `Expresión ${mood.label}`);
    button.style.padding = '8px 12px';
    button.style.border = '1px solid rgba(255,255,255,0.25)';
    button.style.borderRadius = '18px';
    button.style.background = 'transparent';
    button.style.color = 'white';
    button.style.fontSize = '13px';
    button.style.cursor = 'pointer';

    button.addEventListener(
        'click',
        () => {

            // Los FBX no traen expresiones faciales
            if (!currentVrm?.expressionManager) {
                messagePanel.textContent =
                    'Este modelo no tiene expresiones faciales.';
                setMoodPanelVisible(false);
                textInput.focus();
                return;
            }

            applyMood(
                mood.id === 'neutral' ? null : mood.id
            );

            refreshMoodButtons();
            setMoodPanelVisible(false);
            textInput.focus();
        }
    );

    moodButtons[mood.id] = button;

    moodGrid.appendChild(
        button
    );
}

interfaceContainer.appendChild(
    moodPanel
);

refreshMoodButtons();
setPlusTab('mood');

// ======================================================
// STATUS
// ======================================================



type AvatarStatus =
    | 'waiting'
    | 'listening'
    | 'thinking'
    | 'speaking';

let currentStatus:
    AvatarStatus = 'waiting';

function setStatus(
    status: AvatarStatus
) {

    currentStatus =
        status;

    switch (status) {

        case 'waiting':

            statusContainer.innerHTML =
                '● Esperando';

            statusContainer.style.color =
                isDarkTheme ? '#86efac' : '#16a34a';

            break;

        case 'listening':

            statusContainer.innerHTML =
                '● Escuchando...';

            statusContainer.style.color =
                isDarkTheme ? '#60a5fa' : '#2563eb';

            break;

        case 'thinking':

            statusContainer.innerHTML =
                '● Pensando...';

            statusContainer.style.color =
                isDarkTheme ? '#facc15' : '#a16207';

            break;

        case 'speaking':

            statusContainer.innerHTML =
                '● Hablando...';

            statusContainer.style.color =
                isDarkTheme ? '#c084fc' : '#9333ea';

            break;
    }

    if (typeof refreshSendButton !== 'undefined') {
        refreshSendButton();
    }
}

// ======================================================
// SEND QUESTION
// ======================================================

// ======================================================
// IA: historial + pregunta real al backend + voz
// ======================================================

const chatHistory: ChatMessage[] = [];

let chatAbort: AbortController | null = null;

function stopTalking() {

    if (chatAbort) {
        chatAbort.abort();
        chatAbort = null;
    }

    if (voiceAbort) {
        voiceAbort.abort();
        voiceAbort = null;
    }

    stopBackendVoice();

    if (
        'speechSynthesis' in window &&
        (window.speechSynthesis.speaking ||
            window.speechSynthesis.pending)
    ) {
        window.speechSynthesis.cancel();
    }

    if (
        currentStatus === 'thinking' ||
        currentStatus === 'speaking'
    ) {
        messagePanel.textContent =
            'He dejado de pensar. ¿En qué te ayudo?';

        setStatus('waiting');
    }
}

type HistoryRole = 'user' | 'assistant' | 'system';

interface HistoryEntry {
    role: HistoryRole;
    content: string;
}

const HISTORY_KEY = 'akirai.history.v1';
const HISTORY_MAX = 100;

let displayHistory: HistoryEntry[] = [];

function saveHistory() {

    try {
        localStorage.setItem(
            HISTORY_KEY,
            JSON.stringify(displayHistory.slice(-HISTORY_MAX))
        );
    } catch {
        // Almacenamiento lleno o no disponible: seguir en memoria.
    }
}

function loadHistory() {

    try {

        const raw = localStorage.getItem(HISTORY_KEY);

        if (!raw) {
            return;
        }

        const parsed = JSON.parse(raw);

        if (!Array.isArray(parsed)) {
            return;
        }

        displayHistory = parsed
            .filter(
                (e: any) =>
                    e &&
                    (e.role === 'user' ||
                        e.role === 'assistant' ||
                        e.role === 'system') &&
                    typeof e.content === 'string'
            )
            .slice(-HISTORY_MAX);

    } catch {
        displayHistory = [];
    }
}

function clearHistory() {

    displayHistory = [];
    chatHistory.length = 0;

    try {
        localStorage.removeItem(HISTORY_KEY);
    } catch {
        // Ignorar.
    }

    renderHistory();
}

function pushDisplay(role: HistoryRole, content: string) {

    displayHistory.push({ role, content });

    while (displayHistory.length > HISTORY_MAX) {
        displayHistory.shift();
    }

    saveHistory();
    renderHistory();
}

function pushHistory(role: 'user' | 'assistant', content: string) {

    chatHistory.push({ role, content });

    while (chatHistory.length > 12) {
        chatHistory.shift();
    }

    pushDisplay(role, content);
}

function pushSystemEntry(content: string) {
    pushDisplay('system', content);
}

function moodLabel(id: string | null): string {

    if (!id) {
        return '';
    }

    const found = MOODS.find((m) => m.id === id);

    return found ? found.label : id;
}

let voiceAbort: AbortController | null = null;

function speakBrowserVoice(text: string) {

    if (!('speechSynthesis' in window)) {
        setStatus('waiting');
        return;
    }

    window.speechSynthesis.cancel();

    const utterance =
        new SpeechSynthesisUtterance(text);

    utterance.lang = 'es-ES';
    utterance.rate = 1;

    utterance.onend = () => {

        if (currentStatus === 'speaking') {
            setStatus('waiting');
        }
    };

    utterance.onerror = () => {

        if (currentStatus === 'speaking') {
            setStatus('waiting');
        }
    };

    window.speechSynthesis.speak(utterance);
}

async function speak(text: string) {

    // 1) Voz local del backend (Piper); si falla o se aborta,
    // se usa la del navegador como reserva.
    try {

        voiceAbort = new AbortController();

        await playBackendVoice(text, {
            signal: voiceAbort.signal
        });

        voiceAbort = null;

        if (currentStatus === 'speaking') {
            setStatus('waiting');
        }

        return;

    } catch (err) {

        voiceAbort = null;

        if (err instanceof DOMException && err.name === 'AbortError') {
            return;
        }

        console.warn('Voz local no disponible, usando voz del navegador.', err);
    }

    speakBrowserVoice(text);
}

async function sendQuestion() {

    // Si está pensando o hablando, el envío actúa como "parar".
    if (currentStatus === 'thinking') {
        stopTalking();
        return;
    }

    if (
        currentStatus === 'speaking' &&
        (backendVoiceActive() ||
            ('speechSynthesis' in window &&
                window.speechSynthesis.speaking))
    ) {
        stopTalking();
        return;
    }

    const pregunta =
        textInput.value.trim();

    if (!pregunta || currentStatus === 'thinking') {
        return;
    }

    console.log(
        'Pregunta:',
        pregunta
    );

    pushSentQuestion(pregunta);

    messagePanel.textContent =
        pregunta;

    textInput.value =
        '';

    // 1) Órdenes en español ("pon cara triste", "sonríe").
    const cmd = extractExpressionCommand(pregunta);

    if (cmd.mood) {
        applyMood(cmd.mood);
        refreshMoodButtons();
    }

    // 2) Emoticonos: no se envían ni se leen, ponen la cara.
    const found = extractEmoticons(cmd.cleaned);

    if (found.mood) {
        applyMood(found.mood);
        refreshMoodButtons();
    }

    // 3) Bailes DESACTIVADO temporalmente (no quedaba
    // natural). Para reactivar: descomentar el bloque de
    // abajo y la pestaña "Bailes" (tabDanceButton).
    /*
    const danceCmd = extractDanceCommand(
        found.cleaned,
        getCachedEffects()
    );

    if (danceCmd.effect) {
        void runDance(danceCmd.effect);
    }

    const textoLimpio = danceCmd.effect
        ? danceCmd.cleaned
        : found.cleaned;
    */
    const textoLimpio = found.cleaned;

    // Orden pura ("pon cara triste") o solo emoticonos:
    // reacciona con cara + voz breve propia, sin gastar IA.
    // (Antes también cubría órdenes de baile: desactivado.)
    if (!textoLimpio) {

        const mood = found.mood || cmd.mood;
        // NOTA bailes desactivados: aquí iba el acuse
        // "¡Marchando! Bailo ..." y el apunte al historial
        // "Baila: ..." (ver bloque 3 de más arriba).
        const ack = (cmd.mood && MOOD_ACK[cmd.mood])
            || null;

        pushDisplay('user', pregunta);

        if (mood) {
            pushSystemEntry(`Pone cara: ${moodLabel(mood)}`);
        }

        messagePanel.textContent =
            pregunta;

        setStatus(
            'speaking'
        );

        if (ack) {
            speak(ack);
        } else {

            setTimeout(
                () => {

                    if (currentStatus === 'speaking') {
                        setStatus('waiting');
                    }

                },
                2500
            );
        }

        return;
    }

    const textoParaIa = textoLimpio;

    setStatus(
        'thinking'
    );

    messagePanel.textContent =
        'Pensando...';

    try {

        chatAbort = new AbortController();

        const res = await chat(textoParaIa, [...chatHistory], {
            signal: chatAbort.signal
        });

        chatAbort = null;

        pushHistory('user', textoParaIa);
        pushHistory('assistant', res.respuesta);

        console.log(
            `Respuesta (${res.proveedor}/${res.modelo}):`,
            res.respuesta
        );

        // Si la IA responde con emoticonos, también ponen la cara
        // y se quitan antes de hablar para no leerlos.
        const reply = extractEmoticons(res.respuesta);

        if (reply.mood) {
            applyMood(reply.mood);
            refreshMoodButtons();
        }

        const textoParaVoz = cleanSpeechText(
            reply.cleaned || res.respuesta
        );

        messagePanel.textContent =
            res.respuesta;

        setStatus(
            'speaking'
        );

        if (textoParaVoz) {
            speak(textoParaVoz);
        } else {
            setStatus('waiting');
        }

    } catch (err) {

        chatAbort = null;

        // Parado por el usuario: no es un error.
        if (err instanceof DOMException && err.name === 'AbortError') {
            console.log('Pensamiento detenido por el usuario.');
            return;
        }

        console.error(err);

        const detail = err instanceof Error
            ? err.message
            : 'Error desconocido.';

        messagePanel.textContent =
            `No he podido responder: ${detail}`;

        setStatus(
            'waiting'
        );
    }
}

// ======================================================
// EVENTS
// ======================================================

plusButton.addEventListener(
    'click',
    () => {
        const visible =
            moodPanel.style.display !== 'flex';

        setMoodPanelVisible(visible);

        if (visible) {
            // (Bailes desactivados: aquí se releía la carpeta
            // de efects con refreshDanceList().)
        } else {
            textInput.focus();
        }
    }
);

sendButton.addEventListener(
    'click',
    sendQuestion
);

// ======================================================
// HISTORIAL DE PREGUNTAS (flechas ↑ ↓ en el input)
// ======================================================
// ↑ muestra la anterior enviada (y así hacia atrás),
// ↓ avanza hacia la más reciente y al final restaura
// lo que estabas escribiendo.

const sentQuestions: string[] = [];

let historyNav = -1;
let draftBackup = '';

function pushSentQuestion(pregunta: string) {

    if (
        !pregunta ||
        sentQuestions[sentQuestions.length - 1] === pregunta
    ) {
        historyNav = -1;
        return;
    }

    sentQuestions.push(pregunta);

    if (sentQuestions.length > 50) {
        sentQuestions.shift();
    }

    historyNav = -1;
}

function navigateSentQuestions(direction: -1 | 1) {

    if (!sentQuestions.length) {
        return;
    }

    if (historyNav === -1) {
        draftBackup = textInput.value;
    }

    historyNav += direction;

    if (historyNav < 0) {
        historyNav = 0;
    }

    if (historyNav >= sentQuestions.length) {
        historyNav = -1;
        textInput.value = draftBackup;
    } else {
        textInput.value =
            sentQuestions[sentQuestions.length - 1 - historyNav];
    }

    // Cursor al final para seguir editando
    textInput.setSelectionRange(
        textInput.value.length,
        textInput.value.length
    );
}

textInput.addEventListener(
    'keydown',
    (event) => {

        if (
            event.key ===
            'Enter'
        ) {

            sendQuestion();

        } else if (event.key === 'ArrowUp') {

            event.preventDefault();
            navigateSentQuestions(1);

        } else if (event.key === 'ArrowDown') {

            event.preventDefault();
            navigateSentQuestions(-1);

        } else {

            // Al teclear de nuevo se sale del historial
            historyNav = -1;

        }

    }
);

// ======================================================
// SPEECH
// ======================================================

const SpeechRecognition =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition;

let recognition: any =
    null;

// Escucha larga + auto-envío tras 1,5 s de silencio.
// Segundo clic en el micro = cancelar (no envía).
let listening = false;
let finalTranscript = '';
let silenceTimer: number | null = null;
let manualCancel = false;
const SILENCE_MS = 1500;

function clearSilenceTimer() {

    if (silenceTimer !== null) {
        window.clearTimeout(silenceTimer);
        silenceTimer = null;
    }
}

function restartSilenceTimer() {

    clearSilenceTimer();

    silenceTimer = window.setTimeout(
        () => {
            silenceTimer = null;

            try {
                recognition?.stop();
            } catch {
                // Ya parado: onend se encargará.
            }
        },
        SILENCE_MS
    );
}

if (SpeechRecognition) {

    recognition =
        new SpeechRecognition();

    recognition.lang =
        'es-ES';

    recognition.continuous =
        true;

    recognition.interimResults =
        true;

    recognition.onstart =
        () => {

            listening = true;
            manualCancel = false;
            finalTranscript = '';
            clearSilenceTimer();

            setStatus(
                'listening'
            );

            messagePanel.innerHTML =
                'Te escucho...';

            microphoneButton.style.color =
                '#ef4444';
            microphoneButton.title = 'Cancelar dictado';
            microphoneButton.setAttribute('aria-label', 'Cancelar dictado');
        };

    recognition.onresult =
        (event: any) => {

            let interim =
                '';

            for (
                let i = event.resultIndex;
                i < event.results.length;
                i++
            ) {

                const result = event.results[i];
                const texto: string = result[0].transcript;

                if (result.isFinal) {
                    finalTranscript += texto + ' ';
                } else {
                    interim += texto;
                }
            }

            const completo =
                (finalTranscript + interim).trim();

            textInput.value =
                completo;

            messagePanel.innerHTML =
                completo || 'Te escucho...';

            // Mientras llega voz, alarga la escucha;
            // cuando callas 1,5 s, el timer para y auto-envía.
            restartSilenceTimer();
        };

    recognition.onerror =
        (event: any) => {

            console.error(
                event.error
            );

            // 'aborted' es el stop() normal (silencio o
            // cancelación): no machacar el texto en onend.
            if (event.error === 'aborted') {
                return;
            }

            clearSilenceTimer();
            listening = false;

            messagePanel.innerHTML =
                event.error === 'not-allowed' ||
                event.error === 'service-not-allowed'
                    ? 'Permite el micrófono en el navegador para dictar.'
                    : 'No he podido entenderte.';

            setStatus(
                'waiting'
            );
        };

    recognition.onend =
        () => {

            microphoneButton.style.color =
                '#202123';
            microphoneButton.title = 'Hablar';
            microphoneButton.setAttribute('aria-label', 'Hablar');

            clearSilenceTimer();

            const wasListening = listening;
            listening = false;

            // Chrome puede cortar la sesión larga solo
            // (~60 s): reanuda sin perder lo dictado.
            if (
                wasListening &&
                !manualCancel &&
                !finalTranscript.trim() &&
                !textInput.value.trim()
            ) {

                try {
                    recognition.start();
                    return;
                } catch {
                    // Si no se puede reanudar, cae a waiting.
                }
            }

            // Cancelado con 2º clic: no envía nada.
            if (manualCancel) {
                manualCancel = false;
                finalTranscript = '';
                setStatus('waiting');
                return;
            }

            const texto =
                (finalTranscript || textInput.value || '').trim();

            finalTranscript = '';

            if (!texto) {
                setStatus('waiting');
                return;
            }

            textInput.value = texto;

            // Auto-enter: equivale a pulsar Enviar.
            sendQuestion();
        };
}

// ======================================================
// MICROPHONE
// ======================================================

microphoneButton.addEventListener(
    'click',
    () => {

        if (!recognition) {

            messagePanel.innerHTML =
                'Tu navegador no soporta reconocimiento de voz.';

            return;
        }

        // Si ya escucha, el 2º clic cancela (no envía).
        if (listening) {
            manualCancel = true;
            clearSilenceTimer();

            try {
                recognition.stop();
            } catch {
                manualCancel = false;
                listening = false;
                setStatus('waiting');
            }

            return;
        }

        textInput.value = '';
        finalTranscript = '';

        try {

            recognition.start();

        } catch {

            console.log(
                'Reconocimiento ya iniciado'
            );
        }
    }
);

// ======================================================
// VRM
// ======================================================

const loader =
    new GLTFLoader();

loader.register(
    (parser) => {

        return new VRMLoaderPlugin(
            parser
        );

    }
);

let currentVrm: any =
    null;

// ======================================================
// BONES
// ======================================================

let headBone:
    THREE.Object3D | null =
    null;

let spineBone:
    THREE.Object3D | null =
    null;

let leftUpperArm:
    THREE.Object3D | null =
    null;

let rightUpperArm:
    THREE.Object3D | null =
    null;

let leftLowerArm:
    THREE.Object3D | null =
    null;

let rightLowerArm:
    THREE.Object3D | null =
    null;

let leftHand:
    THREE.Object3D | null =
    null;

let rightHand:
    THREE.Object3D | null =
    null;

let jawBone:
    THREE.Object3D | null =
    null;

let jawOpen = 0;

// ======================================================
// FINGER BONES
// ======================================================

const leftFingerBones:
    THREE.Object3D[] = [];

const rightFingerBones:
    THREE.Object3D[] = [];

// ------------------------------------------------------
// DEDOS: flexión individual por dedo (como mano humana)
// ------------------------------------------------------
// 15 huesos por mano = 5 dedos x 3 falanges.
// Índice de dedo = floor(i / 3), articulación = i % 3.
// La distal flexiona ~1.3x la proximal al cerrar el puño.

const fingerCurlL: number[] = new Array(15).fill(0);
const fingerCurlGoalL: number[] = new Array(15).fill(0);
const fingerCurlR: number[] = new Array(15).fill(0);
const fingerCurlGoalR: number[] = new Array(15).fill(0);
const fingerSpreadL: number[] = new Array(15).fill(0);
const fingerSpreadGoalL: number[] = new Array(15).fill(0);
const fingerSpreadR: number[] = new Array(15).fill(0);
const fingerSpreadGoalR: number[] = new Array(15).fill(0);

let fingerTimer = 0;
let fingerHold = 2.5;
let fingerBehavior: 'relax' | 'stretch' | 'softFist' | 'tap' = 'relax';
let fingerBehaviorTimer = 0;
let fingerBehaviorHold = 9;
let tapPhase = 0;

function fingerJointWeight(joint: number): number {
    return joint === 0 ? 1 : joint === 1 ? 1.15 : 1.35;
}

function newFingerGoals() {

    const isThumb = (finger: number) => finger === 0;

    const setGoals = (
        curlGoal: number[],
        spreadGoal: number[]
    ) => {

        for (let f = 0; f < 5; f++) {

            let baseCurl: number;
            let baseSpread: number;

            if (fingerBehavior === 'stretch') {
                baseCurl = randomRange(-2, 1);
                baseSpread = randomRange(2, 5);
            } else if (fingerBehavior === 'softFist') {
                baseCurl = isThumb(f)
                    ? randomRange(4, 8)
                    : randomRange(14, 22);
                baseSpread = randomRange(-1, 1);
            } else if (fingerBehavior === 'tap') {
                // Índice y corazón tamborilean, resto relajado
                baseCurl = (f === 1 || f === 2)
                    ? randomRange(2, 14)
                    : randomRange(3, 9);
                baseSpread = randomRange(-1, 2);
            } else {
                baseCurl = isThumb(f)
                    ? randomRange(1, 6)
                    : randomRange(2, 10);
                baseSpread = randomRange(-1.5, 1.5);
            }

            for (let j = 0; j < 3; j++) {
                const i = f * 3 + j;
                curlGoal[i] = THREE.MathUtils.degToRad(
                    baseCurl * fingerJointWeight(j) + randomRange(-1.5, 1.5)
                );
                spreadGoal[i] = THREE.MathUtils.degToRad(
                    (isThumb(f) ? baseSpread * 1.6 : baseSpread * 0.6) +
                    randomRange(-0.8, 0.8)
                );
            }
        }
    };

    setGoals(fingerCurlGoalL, fingerSpreadGoalL);
    setGoals(fingerCurlGoalR, fingerSpreadGoalR);
}

// ======================================================
// ARM REST POSE
// ======================================================

/*
 * El modelo tiene:
 *
 * Brazo izquierdo: hombro -> codo -> mano = X negativo
 * Brazo derecho:   hombro -> codo -> mano = X positivo
 *
 * Para llevarlos hacia abajo:
 *
 * Izquierdo = +85 grados
 * Derecho   = -85 grados
 */

let leftArmRestAngle =
    THREE.MathUtils.degToRad(85);

let rightArmRestAngle =
    THREE.MathUtils.degToRad(-85);

let leftElbowRestAngle =
    THREE.MathUtils.degToRad(3);

let rightElbowRestAngle =
    THREE.MathUtils.degToRad(-3);

// El rig Mixamo ya cuelga los brazos: con FBX el reposo
// es 0; con VRM se mantienen los valores de arriba.
function setRestAnglesForKind(kind: 'vrm' | 'fbx') {

    if (kind === 'fbx') {
        leftArmRestAngle = 0;
        rightArmRestAngle = 0;
        leftElbowRestAngle = 0;
        rightElbowRestAngle = 0;
    } else {
        leftArmRestAngle = THREE.MathUtils.degToRad(85);
        rightArmRestAngle = THREE.MathUtils.degToRad(-85);
        leftElbowRestAngle = THREE.MathUtils.degToRad(3);
        rightElbowRestAngle = THREE.MathUtils.degToRad(-3);
    }
}

// ======================================================
// LOAD AVATAR (con cambio en caliente)
// ======================================================

// Para añadir un avatar nuevo basta con copiar el .vrm o
// .fbx a public/models: al arrancar (y al abrir el
// desplegable) se pide GET /api/avatars al backend, que
// escanea la carpeta y devuelve los encontrados.
interface AvatarEntry {
    file: string;
    label: string;
    kind: 'vrm' | 'fbx';
}

function kindOfAvatarFile(file: string): 'vrm' | 'fbx' {
    return isFbxFile(file) ? 'fbx' : 'vrm';
}

const FALLBACK_AVATARS: AvatarEntry[] = [
    { file: 'AvatarSample_A.vrm', label: 'Avatar A', kind: 'vrm' },
    { file: 'AvatarSample_C.vrm', label: 'Avatar C', kind: 'vrm' },
    { file: 'Arissa.fbx', label: 'Arissa (FBX)', kind: 'fbx' }
];

// Avatar por defecto al arrancar (si está en la lista).
const DEFAULT_AVATAR_FILE = 'AvatarSample_A.vrm';

// Idle en bucle por avatar (ficheros de public/anims).
// Vacío a propósito: los avatares usan el idle procedural
// como los VRM. Para asignar uno, p. ej.:
// { 'Arissa.fbx': 'Breathing Idle.fbx' }
const AVATAR_IDLE_CLIPS: Record<string, string> = {};

async function fetchAvailableAnims(): Promise<string[]> {

    try {

        const res = await fetch(
            `${getApiBase()}/api/anims`
        );

        if (res.ok) {

            const data = await res.json();
            const list = Array.isArray(data) ? data : data.anims;

            if (Array.isArray(list)) {

                return list
                    .map((a: any) => a?.file)
                    .filter((f: any) => typeof f === 'string');
            }
        }

    } catch {
        // Backend apagado: sin validación de anims.
    }

    return [];
}

let AVATARS: AvatarEntry[] = [...FALLBACK_AVATARS];

async function fetchAvailableAvatars(): Promise<AvatarEntry[] | null> {

    // 1) Backend: escaneo real de public/models y dist/models.
    try {

        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 4000);

        const res = await fetch(
            `${getApiBase()}/api/avatars`,
            { signal: controller.signal }
        );

        window.clearTimeout(timer);

        if (res.ok) {

            const data = await res.json();
            const list = Array.isArray(data) ? data : data.avatars;

            if (Array.isArray(list)) {

                const cleaned = list
                    .filter((a: any) =>
                        a &&
                        typeof a.file === 'string' &&
                        /\.(vrm|fbx)$/i.test(a.file)
                    )
                    .map((a: any) => ({
                        file: a.file,
                        label: typeof a.label === 'string' && a.label.trim()
                            ? a.label
                            : a.file.replace(/\.(vrm|fbx)$/i, ''),
                        kind: kindOfAvatarFile(a.file)
                    }));

                if (cleaned.length) {
                    return cleaned;
                }
            }
        }

    } catch {
        // Backend apagado o sin ruta: probar manifiesto estático.
    }

    // 2) Manifiesto estático opcional public/models/avatars.json
    // (por si se sirve sin backend). 404 = se ignora.
    try {

        const res = await fetch('/models/avatars.json');

        if (res.ok) {

            const data = await res.json();
            const list = Array.isArray(data) ? data : data.avatars;

            if (Array.isArray(list) && list.length) {

                const cleaned = list
                    .filter((a: any) =>
                        a &&
                        typeof a.file === 'string' &&
                        /\.(vrm|fbx)$/i.test(a.file)
                    )
                    .map((a: any) => ({
                        file: a.file,
                        label: typeof a.label === 'string' && a.label.trim()
                            ? a.label
                            : a.file.replace(/\.(vrm|fbx)$/i, ''),
                        kind: kindOfAvatarFile(a.file)
                    }));

                if (cleaned.length) {
                    return cleaned;
                }
            }
        }

    } catch {
        // Sin manifiesto: usar reserva.
    }

    return null;
}

async function refreshAvatarList(): Promise<boolean> {

    const found = await fetchAvailableAvatars();

    if (!found) {
        return false;
    }

    AVATARS = found;
    buildAvatarButtons();
    refreshAvatarButtons();

    return true;
}

let currentAvatarFile = AVATARS[0].file;
let avatarLoadToken = 0;

function disposeAvatar() {

    // Corta el baile y el idle en curso (su escena se elimina).
    cancelDance();
    stopIdleLoop(true);

    if (!currentVrm) {
        return;
    }

    scene.remove(
        currentVrm.scene
    );

    currentVrm.scene.traverse((obj: any) => {

        const mesh = obj as THREE.Mesh;

        if (mesh.isMesh) {

            mesh.geometry?.dispose?.();

            const materials = Array.isArray(mesh.material)
                ? mesh.material
                : [mesh.material];

            for (const mat of materials) {

                const m = mat as any;

                for (const key of Object.keys(m)) {
                    m[key]?.isTexture && m[key].dispose?.();
                }

                mat?.dispose?.();
            }
        }
    });

    currentVrm = null;
    headBone = null;
    spineBone = null;
    leftUpperArm = null;
    rightUpperArm = null;
    leftLowerArm = null;
    rightLowerArm = null;
    leftHand = null;
    rightHand = null;
    jawBone = null;
    jawOpen = 0;
    leftFingerBones.length = 0;
    rightFingerBones.length = 0;

    for (const key of Object.keys(hb)) {
        delete hb[key];
    }

    hbReady = false;
}

function loadAvatar(file: string) {

    const token = ++avatarLoadToken;

    currentAvatarFile = file;

    disposeAvatar();
    refreshAvatarButtons();

    messagePanel.textContent =
        `Cargando ${file}...`;

    setStatus('waiting');

    setRestAnglesForKind(isFbxFile(file) ? 'fbx' : 'vrm');

    // Rama FBX (Mixamo): fachada compatible con el código
    // VRM (la pose de reposo del FBX ya es válida).
    if (isFbxFile(file)) {

        loadFbxRig(file).then(
            (rig) => {

                if (token !== avatarLoadToken) {
                    return;
                }

                currentVrm =
                    rig as any;

                rig.scene.rotation.y =
                    Math.PI;

                scene.add(
                    rig.scene
                );

                setupAvatarRigged(false, token);
            },

            (error) => {

                if (token !== avatarLoadToken) {
                    return;
                }

                console.error(
                    'Error cargando avatar:',
                    error
                );

                messagePanel.textContent =
                    `No se pudo cargar ${file}.`;
            }
        );

        return;
    }

    loader.load(
        `/models/${file}`,

    (gltf) => {

        // Si el usuario pidió otro avatar mientras cargaba,
        // se ignora esta respuesta obsoleta.
        if (token !== avatarLoadToken) {
            return;
        }

        const vrm =
            gltf.userData.vrm;

        currentVrm =
            vrm;

        VRMUtils.removeUnnecessaryVertices(
            vrm.scene
        );

        VRMUtils.combineSkeletons(
            vrm.scene
        );

        vrm.scene.rotation.y =
            Math.PI;

        vrm.scene.position.set(
            0,
            0,
            0
        );

        vrm.scene.scale.set(
            1,
            1,
            1
        );

        scene.add(
            vrm.scene
        );

        setupAvatarRigged(true, token);
    },

    undefined,

    (error) => {

        if (token !== avatarLoadToken) {
            return;
        }

        console.error(
            'Error cargando avatar:',
            error
        );

        messagePanel.textContent =
            `No se pudo cargar ${file}.`;
    }
    );
}

// ------------------------------------------------------
// Puesta en marcha común tras cargar el modelo (VRM o
// fachada FBX): cablea huesos/dedos, aplica reposo de
// brazos (solo VRM: el Mixamo ya cuelga), expresión,
// enfoque inicial e idle por defecto. Usa currentVrm,
// ya asignado por loadAvatar.
// ------------------------------------------------------

function setupAvatarRigged(applyRestPose: boolean, token: number) {

    const vrm: any = currentVrm;

    if (!vrm) {
        return;
    }

    // ------------------------------------------
    // BONES
    // ------------------------------------------

    headBone =
        vrm.humanoid.getNormalizedBoneNode(
            'head'
        );

    spineBone =
        vrm.humanoid.getNormalizedBoneNode(
            'spine'
        );

    leftUpperArm =
        vrm.humanoid.getNormalizedBoneNode(
            'leftUpperArm'
        );

    rightUpperArm =
        vrm.humanoid.getNormalizedBoneNode(
            'rightUpperArm'
        );

    leftLowerArm =
        vrm.humanoid.getNormalizedBoneNode(
            'leftLowerArm'
        );

    rightLowerArm =
        vrm.humanoid.getNormalizedBoneNode(
            'rightLowerArm'
        );

    leftHand =
        vrm.humanoid.getNormalizedBoneNode(
            'leftHand'
        );

    rightHand =
        vrm.humanoid.getNormalizedBoneNode(
            'rightHand'
        );

    jawBone =
        vrm.humanoid.getNormalizedBoneNode(
            'jaw'
        );

    // ------------------------------------------
    // FINGERS
    // ------------------------------------------

    const fingerNames = [

        'thumbProximal',
        'thumbIntermediate',
        'thumbDistal',

        'indexProximal',
        'indexIntermediate',
        'indexDistal',

        'middleProximal',
        'middleIntermediate',
        'middleDistal',

        'ringProximal',
        'ringIntermediate',
        'ringDistal',

        'littleProximal',
        'littleIntermediate',
        'littleDistal'

    ];

    for (
        const fingerName of fingerNames
    ) {

        const leftFinger =
            vrm.humanoid.getNormalizedBoneNode(
                `left${capitalize(fingerName)}`
            );

        const rightFinger =
            vrm.humanoid.getNormalizedBoneNode(
                `right${capitalize(fingerName)}`
            );

        if (leftFinger) {
            leftFingerBones.push(
                leftFinger
            );
        }

        if (rightFinger) {
            rightFingerBones.push(
                rightFinger
            );
        }
    }

    console.log(
        'Dedos izquierdos:',
        leftFingerBones.length
    );

    console.log(
        'Dedos derechos:',
        rightFingerBones.length
    );

    // ------------------------------------------
    // ARM REST POSE (solo VRM)
    // ------------------------------------------

    if (applyRestPose) {

        if (leftUpperArm) {

            leftUpperArm.rotation.set(
                0,
                0,
                leftArmRestAngle
            );
        }

        if (rightUpperArm) {

            rightUpperArm.rotation.set(
                0,
                0,
                rightArmRestAngle
            );
        }

        if (leftLowerArm) {

            leftLowerArm.rotation.set(
                0,
                0,
                leftElbowRestAngle
            );
        }

        if (rightLowerArm) {

            rightLowerArm.rotation.set(
                0,
                0,
                rightElbowRestAngle
            );
        }

        if (leftHand) {

            leftHand.rotation.set(
                0,
                0,
                0
            );
        }

        if (rightHand) {

            rightHand.rotation.set(
                0,
                0,
                0
            );
        }

        console.log(
            'Avatar cargado - pose de brazos aplicada'
        );
    }

    applyMood(activeMood);
    attachDanceVrm(vrm);

    // Enfoque de cara activo por defecto al arrancar
    if (!faceFocusAppliedOnStart) {
        faceFocusAppliedOnStart = true;
        focusFace();
    }

    void ensureAvatarIdle(token);
}

async function ensureAvatarIdle(token: number) {

    const file = currentAvatarFile;
    const idleFile = AVATAR_IDLE_CLIPS[file];

    if (!idleFile || !currentVrm?.scene) {
        stopIdleLoop(true);
        return;
    }

    try {

        const anims = await fetchAvailableAnims();

        if (token !== avatarLoadToken || currentAvatarFile !== file) {
            return;
        }

        if (anims.length && !anims.includes(idleFile)) {
            console.warn(
                `[idle] "${idleFile}" no está en public/anims.`
            );
            stopIdleLoop(true);
            return;
        }

        await startIdleLoop(
            currentVrm,
            idleFile,
            idleFile.replace(/\.fbx$/i, '')
        );

        if (token !== avatarLoadToken || currentAvatarFile !== file) {
            stopIdleLoop(true);
        }

    } catch (err) {
        console.error('[idle] No se pudo arrancar:', err);
        if (token === avatarLoadToken) {
            stopIdleLoop(true);
        }
    }
}

// ======================================================
// AVATAR SWITCHER (botón junto al tema)
// ======================================================

const AVATAR_ICON = `
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="8" r="3.6" stroke="currentColor" stroke-width="1.8"/>
        <path d="M4.5 20c1.4-3.4 4.2-5 7.5-5s6.1 1.6 7.5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;

const avatarButton =
    document.createElement('button');

avatarButton.type = 'button';
avatarButton.title = 'Cambiar avatar';
avatarButton.setAttribute('aria-label', 'Cambiar avatar');
avatarButton.innerHTML = AVATAR_ICON;
avatarButton.style.position = 'absolute';
avatarButton.style.top = '16px';
avatarButton.style.right = '74px';
avatarButton.style.width = '40px';
avatarButton.style.height = '40px';
avatarButton.style.display = 'flex';
avatarButton.style.alignItems = 'center';
avatarButton.style.justifyContent = 'center';
avatarButton.style.border = '1px solid rgba(255,255,255,0.22)';
avatarButton.style.borderRadius = '50%';
avatarButton.style.background = 'rgba(0,0,0,0.45)';
avatarButton.style.backdropFilter = 'blur(10px)';
avatarButton.style.color = 'white';
avatarButton.style.cursor = 'pointer';
avatarButton.style.pointerEvents = 'auto';
avatarButton.style.zIndex = '20';

interfaceContainer.appendChild(
    avatarButton
);

const avatarPanel =
    document.createElement('div');

avatarPanel.style.position = 'absolute';
avatarPanel.style.top = '64px';
avatarPanel.style.right = '26px';
avatarPanel.style.display = 'none';
avatarPanel.style.flexDirection = 'column';
avatarPanel.style.gap = '4px';
avatarPanel.style.minWidth = '180px';
avatarPanel.style.padding = '8px';
avatarPanel.style.borderRadius = '14px';
avatarPanel.style.background = 'rgba(0,0,0,0.55)';
avatarPanel.style.backdropFilter = 'blur(10px)';
avatarPanel.style.pointerEvents = 'auto';
avatarPanel.style.zIndex = '20';

const avatarButtons: Record<string, HTMLButtonElement> = {};

function refreshAvatarButtons() {

    for (const [file, btn] of Object.entries(avatarButtons)) {

        const selected = file === currentAvatarFile;

        if (isDarkTheme) {
            btn.style.background = selected
                ? 'rgba(255,255,255,0.9)'
                : 'transparent';
            btn.style.color = selected ? '#111827' : 'white';
        } else {
            btn.style.background = selected
                ? '#111827'
                : 'transparent';
            btn.style.color = selected ? 'white' : '#111827';
        }
    }
}

function setAvatarPanelVisible(visible: boolean) {
    avatarPanel.style.display = visible ? 'flex' : 'none';
}

function buildAvatarButtons() {

    avatarPanel.innerHTML = '';

    for (const key of Object.keys(avatarButtons)) {
        delete avatarButtons[key];
    }

    if (!AVATARS.some((a) => a.file === currentAvatarFile) && AVATARS.length) {
        currentAvatarFile = AVATARS[0].file;
    }

    for (const avatar of AVATARS) {

        const button =
            document.createElement('button');

        button.type = 'button';
        button.textContent = avatar.label;
        button.title = avatar.file;
        button.setAttribute('aria-label', `Usar ${avatar.label}`);
        button.style.padding = '9px 12px';
        button.style.border = 'none';
        button.style.borderRadius = '10px';
        button.style.background = 'transparent';
        button.style.color = 'white';
        button.style.fontSize = '13px';
        button.style.textAlign = 'left';
        button.style.cursor = 'pointer';

        button.addEventListener(
            'click',
            () => {

                setAvatarPanelVisible(false);

                if (avatar.file !== currentAvatarFile) {
                    loadAvatar(avatar.file);
                }

                textInput.focus();
            }
        );

        avatarButtons[avatar.file] = button;

        avatarPanel.appendChild(
            button
        );
    }
}

buildAvatarButtons();

interfaceContainer.appendChild(
    avatarPanel
);

refreshAvatarButtons();

avatarButton.addEventListener(
    'click',
    () => {
        const opening = avatarPanel.style.display !== 'flex';

        setAvatarPanelVisible(opening);

        // Al abrir, re-escanea por si se añadió un avatar nuevo.
        if (opening) {
            refreshAvatarList();
        }
    }
);

// ======================================================
// IA SWITCHER (cloud <-> Ollama, cambio de modelo)
// ======================================================

const IA_ICON = `
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <rect x="7.5" y="7.5" width="9" height="9" rx="2.5" stroke="currentColor" stroke-width="1.8"/>
        <circle cx="12" cy="12" r="1.4" fill="currentColor"/>
    </svg>`;

const iaButton =
    document.createElement('button');

iaButton.type = 'button';
iaButton.title = 'Configurar IA (modelo)';
iaButton.setAttribute('aria-label', 'Configurar modelo de IA');
iaButton.innerHTML = IA_ICON;
iaButton.style.position = 'absolute';
iaButton.style.top = '16px';
iaButton.style.right = '122px';
iaButton.style.width = '40px';
iaButton.style.height = '40px';
iaButton.style.display = 'flex';
iaButton.style.alignItems = 'center';
iaButton.style.justifyContent = 'center';
iaButton.style.border = '1px solid rgba(255,255,255,0.22)';
iaButton.style.borderRadius = '50%';
iaButton.style.background = 'rgba(0,0,0,0.45)';
iaButton.style.backdropFilter = 'blur(10px)';
iaButton.style.color = 'white';
iaButton.style.cursor = 'pointer';
iaButton.style.pointerEvents = 'auto';
iaButton.style.zIndex = '20';

interfaceContainer.appendChild(
    iaButton
);

const iaPanel =
    document.createElement('div');

iaPanel.style.position = 'absolute';
iaPanel.style.top = '64px';
iaPanel.style.right = '26px';
iaPanel.style.display = 'none';
iaPanel.style.flexDirection = 'column';
iaPanel.style.gap = '8px';
iaPanel.style.width = '250px';
iaPanel.style.padding = '12px';
iaPanel.style.borderRadius = '14px';
iaPanel.style.background = 'rgba(0,0,0,0.55)';
iaPanel.style.backdropFilter = 'blur(10px)';
iaPanel.style.color = 'white';
iaPanel.style.fontSize = '13px';
iaPanel.style.pointerEvents = 'auto';
iaPanel.style.zIndex = '20';

iaPanel.innerHTML = `
    <div style="font-weight:bold; font-size:13px;">IA y voz</div>
    <label style="display:flex; flex-direction:column; gap:4px;">
        Proveedor
        <select id="ia-provider" style="padding:7px; border-radius:8px; border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.1); color:inherit;">
            <option value="ollama">Ollama (local, gratis)</option>
            <option value="openai">Cloud (OpenAI compatible)</option>
        </select>
    </label>
    <label style="display:flex; flex-direction:column; gap:4px;">
        Modelo
        <select id="ia-model" style="padding:7px; border-radius:8px; border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.1); color:inherit;">
        </select>
    </label>
    <label style="display:flex; flex-direction:column; gap:4px;">
        Backend
        <input id="ia-backend" style="padding:7px; border-radius:8px; border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.1); color:inherit;" />
    </label>
    <label style="display:flex; flex-direction:column; gap:4px;">
        Voz
        <select id="ia-voice" style="padding:7px; border-radius:8px; border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.1); color:inherit;">
        </select>
    </label>
    <label style="display:flex; flex-direction:column; gap:4px;">
        Locutor
        <select id="ia-speaker" style="padding:7px; border-radius:8px; border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.1); color:inherit;">
            <option value="0">Locutor 1</option>
        </select>
    </label>
    <button id="ia-save" type="button" style="padding:8px; border:none; border-radius:10px; background:#3b82f6; color:white; font-size:13px; cursor:pointer;">Guardar</button>
    <div id="ia-status" style="font-size:12px; opacity:0.85;"></div>
`;

interfaceContainer.appendChild(
    iaPanel
);

const iaProviderSelect = iaPanel.querySelector(
    '#ia-provider'
) as HTMLSelectElement;

const iaModelSelect = iaPanel.querySelector(
    '#ia-model'
) as HTMLSelectElement;

const iaBackendInput = iaPanel.querySelector(
    '#ia-backend'
) as HTMLInputElement;

const iaSaveButton = iaPanel.querySelector(
    '#ia-save'
) as HTMLButtonElement;

const iaStatus = iaPanel.querySelector(
    '#ia-status'
) as HTMLDivElement;

const iaVoiceSelect = iaPanel.querySelector(
    '#ia-voice'
) as HTMLSelectElement;

const iaSpeakerSelect = iaPanel.querySelector(
    '#ia-speaker'
) as HTMLSelectElement;

let iaVoiceSpeakers: Record<string, number> = {};

function refreshIaSpeakers(active: number) {

    const count = iaVoiceSpeakers[iaVoiceSelect.value] || 1;

    iaSpeakerSelect.innerHTML = '';

    for (let i = 0; i < count; i++) {

        const option =
            document.createElement('option');

        option.value = String(i);
        option.textContent = `Locutor ${i + 1}`;

        iaSpeakerSelect.appendChild(option);
    }

    iaSpeakerSelect.value = String(
        Math.min(active, count - 1)
    );
}

// Modelos cloud habituales (el backend acepta cualquiera).
const CLOUD_MODELS = [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-4.1',
    'o4-mini'
];

function fillIaModels(models: string[], current: string) {

    iaModelSelect.innerHTML = '';

    const list = models.includes(current)
        ? models
        : [current, ...models];

    for (const name of list) {

        const option =
            document.createElement('option');

        option.value = name;
        option.textContent = name;

        iaModelSelect.appendChild(option);
    }

    iaModelSelect.value = current;
}

async function refreshIaModels(provider: string, current: string) {

    if (provider === 'openai') {
        fillIaModels(CLOUD_MODELS, current);
        return;
    }

    try {

        const models = await listOllamaModels();

        fillIaModels(
            models.length ? models : [current],
            current
        );

    } catch {
        fillIaModels([current], current);
    }
}

async function refreshIaPanel() {

    iaBackendInput.value = getApiBase();

    try {

        const cfg = await getConfig();

        iaProviderSelect.value = cfg.provider;

        iaStatus.textContent =
            `Activo: ${cfg.provider} / ${cfg.model} / ${cfg.ttsVoice} locutor ${cfg.ttsSpeaker + 1}` +
            (cfg.provider === 'openai' && !cfg.openaiKeyPresent
                ? ' (sin clave en el backend)'
                : '');

        await refreshIaModels(cfg.provider, cfg.model);
        await refreshIaVoices(cfg.ttsVoice, cfg.ttsSpeaker);

    } catch {

        iaStatus.textContent =
            'Backend no disponible. Arranca con "npm run server".';
    }
}

iaProviderSelect.addEventListener(
    'change',
    async () => {

        const current = iaModelSelect.value || '';

        iaStatus.textContent = 'Cargando modelos...';

        await refreshIaModels(iaProviderSelect.value, current);

        iaStatus.textContent = '';
    }
);

async function refreshIaVoices(active: string, speaker: number) {

    iaVoiceSelect.innerHTML = '';
    iaVoiceSpeakers = {};

    try {

        const { voices, active: serverActive } = await fetchTtsVoices();

        for (const voice of voices) {

            const option =
                document.createElement('option');

            option.value = voice.id;
            option.textContent = voice.label;

            iaVoiceSelect.appendChild(option);

            iaVoiceSpeakers[voice.id] = voice.speakers || 1;
        }

        iaVoiceSelect.value = active || serverActive;

        refreshIaSpeakers(speaker || 0);

    } catch {

        const option =
            document.createElement('option');

        option.value = '';
        option.textContent = '(sin voces locales: voz del navegador)';

        iaVoiceSelect.appendChild(option);
    }
}

iaVoiceSelect.addEventListener(
    'change',
    () => {
        refreshIaSpeakers(
            Number(iaSpeakerSelect.value) || 0
        );
    }
);

iaSaveButton.addEventListener(
    'click',
    async () => {

        iaStatus.textContent = 'Guardando...';

        try {

            setApiBase(
                iaBackendInput.value.trim() || 'http://localhost:3001'
            );

            const cfg = await setConfig({
                provider: iaProviderSelect.value,
                model: iaModelSelect.value.trim(),
                voice: iaVoiceSelect.value || undefined,
                speaker: Number(iaSpeakerSelect.value) || 0
            });

            iaStatus.textContent =
                `Activo: ${cfg.provider} / ${cfg.model} / ${cfg.ttsVoice} locutor ${cfg.ttsSpeaker + 1}`;

        } catch (err) {

            iaStatus.textContent =
                err instanceof Error ? err.message : 'Error al guardar.';
        }
    }
);

iaButton.addEventListener(
    'click',
    () => {

        const visible =
            iaPanel.style.display !== 'flex';

        iaPanel.style.display = visible ? 'flex' : 'none';

        if (visible) {
            refreshIaPanel();
        }
    }
);

// ======================================================
// FACE FOCUS BUTTON (acercar la cara / ver la boca)
// ======================================================

const FACE_ICON = `
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8"/>
        <path d="M15.8 15.8 20.5 20.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="9" cy="10" r="0.9" fill="currentColor"/>
        <circle cx="13" cy="10" r="0.9" fill="currentColor"/>
        <path d="M9.5 13.2c1.5 1 3.5 1 5 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;

const faceButton =
    document.createElement('button');

faceButton.type = 'button';
faceButton.title = 'Acercar a la cara';
faceButton.setAttribute('aria-label', 'Acercar a la cara');
faceButton.innerHTML = FACE_ICON;
faceButton.style.position = 'absolute';
faceButton.style.top = '16px';
faceButton.style.right = '74px';
faceButton.style.width = '40px';
faceButton.style.height = '40px';
faceButton.style.display = 'flex';
faceButton.style.alignItems = 'center';
faceButton.style.justifyContent = 'center';
faceButton.style.border = '1px solid rgba(255,255,255,0.22)';
faceButton.style.borderRadius = '50%';
faceButton.style.background = 'rgba(0,0,0,0.45)';
faceButton.style.backdropFilter = 'blur(10px)';
faceButton.style.color = 'white';
faceButton.style.cursor = 'pointer';
faceButton.style.pointerEvents = 'auto';
faceButton.style.zIndex = '20';

interfaceContainer.appendChild(
    faceButton
);

function refreshFaceButton() {

    faceButton.title = faceFocused
        ? 'Volver al cuerpo'
        : 'Acercar a la cara';

    // Siempre a juego con el tema, como el botón ⋮
    faceButton.style.background = isDarkTheme
        ? 'rgba(0,0,0,0.45)'
        : 'rgba(255,255,255,0.85)';

    faceButton.style.color = isDarkTheme ? 'white' : '#111827';

    faceButton.style.border = isDarkTheme
        ? '1px solid rgba(255,255,255,0.22)'
        : '1px solid rgba(0,0,0,0.12)';
}

faceButton.addEventListener(
    'click',
    () => {
        toggleFaceFocus();
        textInput.focus();
    }
);

// ======================================================
// HISTORY PANEL (ver / ocultar / borrar, localStorage)
// ======================================================

const HISTORY_ICON = `
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <circle cx="9" cy="12" r="1" fill="currentColor"/>
        <circle cx="12.5" cy="12" r="1" fill="currentColor"/>
        <circle cx="16" cy="12" r="1" fill="currentColor"/>
    </svg>`;

const TRASH_ICON = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

const historyButton =
    document.createElement('button');

historyButton.type = 'button';
historyButton.title = 'Ver conversación';
historyButton.setAttribute('aria-label', 'Ver u ocultar la conversación');
historyButton.innerHTML = HISTORY_ICON;
historyButton.style.position = 'absolute';
historyButton.style.top = '16px';
historyButton.style.right = '170px';
historyButton.style.width = '40px';
historyButton.style.height = '40px';
historyButton.style.display = 'flex';
historyButton.style.alignItems = 'center';
historyButton.style.justifyContent = 'center';
historyButton.style.border = '1px solid rgba(255,255,255,0.22)';
historyButton.style.borderRadius = '50%';
historyButton.style.background = 'rgba(0,0,0,0.45)';
historyButton.style.backdropFilter = 'blur(10px)';
historyButton.style.color = 'white';
historyButton.style.cursor = 'pointer';
historyButton.style.pointerEvents = 'auto';
historyButton.style.zIndex = '20';

interfaceContainer.appendChild(
    historyButton
);

// ======================================================
// HELP (botón ? + modal con acordeón)
// ======================================================

const HELP_ICON = `
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9.2 9a2.8 2.8 0 1 1 4.1 2.5c-1 .5-1.3 1-1.3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="12" cy="17" r="1.1" fill="currentColor"/>
    </svg>`;

const helpButton =
    document.createElement('button');

helpButton.type = 'button';
helpButton.title = 'Ayuda';
helpButton.setAttribute('aria-label', 'Abrir la ayuda');
helpButton.innerHTML = HELP_ICON;
helpButton.style.position = 'absolute';
helpButton.style.top = '16px';
helpButton.style.right = '218px';
helpButton.style.width = '40px';
helpButton.style.height = '40px';
helpButton.style.display = 'flex';
helpButton.style.alignItems = 'center';
helpButton.style.justifyContent = 'center';
helpButton.style.border = '1px solid rgba(255,255,255,0.22)';
helpButton.style.borderRadius = '50%';
helpButton.style.background = 'rgba(0,0,0,0.45)';
helpButton.style.backdropFilter = 'blur(10px)';
helpButton.style.color = 'white';
helpButton.style.cursor = 'pointer';
helpButton.style.pointerEvents = 'auto';
helpButton.style.zIndex = '20';

interfaceContainer.appendChild(
    helpButton
);

const helpOverlay =
    document.createElement('div');

helpOverlay.id = 'paseta-help-overlay';
helpOverlay.style.position = 'absolute';
helpOverlay.style.top = '0';
helpOverlay.style.left = '0';
helpOverlay.style.width = '100%';
helpOverlay.style.height = '100%';
helpOverlay.style.display = 'none';
helpOverlay.style.overflowY = 'auto';
helpOverlay.style.overscrollBehavior = 'contain';
helpOverlay.style.padding = '6vh 0 8vh';
helpOverlay.style.background = 'rgba(0,0,0,0.5)';
helpOverlay.style.pointerEvents = 'auto';
helpOverlay.style.zIndex = '30';
helpOverlay.style.touchAction = 'pan-y';
helpOverlay.classList.add('paseta-scroll');

const helpCard =
    document.createElement('div');

helpCard.id = 'paseta-help-card';
helpCard.style.width = 'min(560px, calc(100% - 40px))';
helpCard.style.margin = '0 auto';
helpCard.style.display = 'flex';
helpCard.style.flexDirection = 'column';
helpCard.style.borderRadius = '18px';
helpCard.style.background = 'rgba(20,22,28,0.97)';
helpCard.style.color = 'white';
helpCard.style.overflow = 'hidden';

const helpHeader =
    document.createElement('div');

helpHeader.style.display = 'flex';
helpHeader.style.alignItems = 'center';
helpHeader.style.justifyContent = 'space-between';
helpHeader.style.padding = '14px 16px';
helpHeader.style.fontSize = '16px';
helpHeader.style.fontWeight = 'bold';

const helpTitle =
    document.createElement('span');

helpTitle.textContent = 'Ayuda';

helpHeader.appendChild(helpTitle);

const helpClose =
    document.createElement('button');

helpClose.type = 'button';
helpClose.title = 'Cerrar ayuda';
helpClose.setAttribute('aria-label', 'Cerrar ayuda');
helpClose.textContent = '✕';
helpClose.style.width = '32px';
helpClose.style.height = '32px';
helpClose.style.border = 'none';
helpClose.style.borderRadius = '50%';
helpClose.style.background = 'transparent';
helpClose.style.color = 'inherit';
helpClose.style.fontSize = '15px';
helpClose.style.cursor = 'pointer';

helpHeader.appendChild(helpClose);
helpCard.appendChild(helpHeader);

const helpBody =
    document.createElement('div');

helpBody.id = 'paseta-help-body';
helpBody.style.display = 'flex';
helpBody.style.flexDirection = 'column';
helpBody.style.gap = '8px';
helpBody.style.padding = '0 16px 16px';

const helpItems: { content: HTMLDivElement; chevron: HTMLSpanElement }[] = [];

// ------------------------------------------------------
// TARJETA DE CONTACTO (apartado Contactar de la Ayuda)
// ------------------------------------------------------

const GITHUB_ICON = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
    </svg>`;

const LINKEDIN_ICON = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2.5" y="2.5" width="19" height="19" rx="4" stroke="currentColor" stroke-width="1.8"/>
        <text x="12" y="16.5" text-anchor="middle" font-size="9" font-weight="bold" font-family="Arial, sans-serif" fill="currentColor">in</text>
    </svg>`;

const WEB_ICON = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/>
        <path d="M3.5 12h17M12 3.5c-5.5 5.5-5.5 11.5 0 17M12 3.5c5.5 5.5 5.5 11.5 0 17" stroke="currentColor" stroke-width="1.4"/>
    </svg>`;

function buildContactCard(): HTMLDivElement {

    const card =
        document.createElement('div');

    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '8px';
    card.style.marginTop = '4px';

    const who =
        document.createElement('div');

    who.style.fontWeight = 'bold';
    who.style.fontSize = '14px';
    who.textContent = CONTACT.name;

    const role =
        document.createElement('div');

    role.style.opacity = '0.75';
    role.style.fontSize = '12px';
    role.textContent = CONTACT.role;

    card.appendChild(who);
    card.appendChild(role);

    const row = (
        icon: string,
        label: string,
        value: string,
        href: string | null,
        onClick: ((el: HTMLElement) => void) | null
    ): HTMLElement => {

        const el = href
            ? document.createElement('a')
            : document.createElement('button');

        if (el instanceof HTMLAnchorElement && href) {
            el.href = href;
            el.target = '_blank';
            el.rel = 'noopener';
        }

        if (el instanceof HTMLButtonElement) {
            el.type = 'button';
        }

        el.title = `${label}: ${value}`;
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.gap = '10px';
        el.style.padding = '9px 11px';
        el.style.borderRadius = '11px';
        el.style.border = '1px solid rgba(128,128,128,0.35)';
        el.style.background = 'transparent';
        el.style.color = 'inherit';
        el.style.fontSize = '13px';
        el.style.textDecoration = 'none';
        el.style.cursor = 'pointer';
        el.style.textAlign = 'left';
        el.style.width = '100%';
        el.style.fontFamily = 'inherit';
        el.style.whiteSpace = 'nowrap';
        el.style.overflow = 'hidden';

        const iconSpan =
            document.createElement('span');

        iconSpan.innerHTML = icon;
        iconSpan.style.display = 'flex';
        iconSpan.style.flex = '0 0 auto';

        const textSpan =
            document.createElement('span');

        textSpan.style.overflow = 'hidden';
        textSpan.style.textOverflow = 'ellipsis';
        textSpan.textContent = value;

        el.appendChild(iconSpan);
        el.appendChild(textSpan);

        if (onClick) {
            el.addEventListener('click', () => onClick(textSpan));
        }

        return el;
    };

    card.appendChild(
        row(GITHUB_ICON, 'GitHub', 'github.com/jtarifap', CONTACT.github, null)
    );

    card.appendChild(
        row(LINKEDIN_ICON, 'LinkedIn', 'Jorge Tarifa', CONTACT.linkedin, null)
    );

    card.appendChild(
        row(WEB_ICON, 'Web', 'jtarifap.github.io', CONTACT.web, null)
    );

    return card;
}

for (const section of HELP_SECTIONS) {

    const item =
        document.createElement('div');

    item.style.borderRadius = '12px';
    item.style.overflow = 'hidden';
    item.style.background = 'rgba(255,255,255,0.07)';

    const head =
        document.createElement('button');

    head.type = 'button';
    head.dataset.section = section.id;
    head.textContent = section.title;
    head.style.width = '100%';
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.justifyContent = 'space-between';
    head.style.padding = '11px 13px';
    head.style.border = 'none';
    head.style.background = 'transparent';
    head.style.color = 'inherit';
    head.style.fontSize = '14px';
    head.style.fontWeight = 'bold';
    head.style.textAlign = 'left';
    head.style.cursor = 'pointer';

    const chevron =
        document.createElement('span');

    chevron.textContent = section.id === 'hablar' ? '▾' : '▸';
    chevron.style.opacity = '0.7';

    head.appendChild(chevron);

    const content =
        document.createElement('div');

    content.style.display = section.id === 'hablar' ? 'block' : 'none';
    content.style.padding = '0 13px 12px';
    content.style.fontSize = '13px';
    content.style.lineHeight = '1.55';
    content.style.maxHeight = '30vh';
    content.style.overflowY = 'auto';
    content.style.overscrollBehavior = 'contain';
    content.style.touchAction = 'pan-y';
    content.classList.add('paseta-scroll');

    for (const line of section.lines) {

        const p =
            document.createElement('div');

        p.textContent = `• ${line}`;
        p.style.marginTop = '4px';

        content.appendChild(p);
    }

    if (section.id === 'contactar') {
        content.appendChild(buildContactCard());
    }

    head.addEventListener(
        'click',
        () => {

            const willOpen = content.style.display !== 'block';

            // Acordeón exclusivo: solo un apartado abierto
            for (const item of helpItems) {
                item.content.style.display = 'none';
                item.chevron.textContent = '▸';
            }

            if (willOpen) {
                content.style.display = 'block';
                chevron.textContent = '▾';

                // Lleva el apartado a la vista dentro del modal
                requestAnimationFrame(() => {
                    item.scrollIntoView({
                        block: 'nearest',
                        behavior: 'smooth'
                    });
                });
            }
        }
    );

    helpItems.push({ content, chevron });

    item.appendChild(head);
    item.appendChild(content);
    helpBody.appendChild(item);
}

helpCard.appendChild(helpBody);
helpOverlay.appendChild(helpCard);

interfaceContainer.appendChild(
    helpOverlay
);
function setHelpVisible(visible: boolean) {

    helpOverlay.style.display = visible ? 'block' : 'none';

    if (visible) {
        helpOverlay.scrollTop = 0;
    }
}

helpButton.addEventListener(
    'click',
    () => {
        setHelpVisible(
            helpOverlay.style.display !== 'block'
        );
    }
);

helpClose.addEventListener(
    'click',
    () => {
        setHelpVisible(false);
    }
);

helpOverlay.addEventListener(
    'pointerdown',
    (event) => {
        if (event.target === helpOverlay) {
            setHelpVisible(false);
        }
    }
);

document.addEventListener(
    'keydown',
    (event) => {
        if (event.key === 'Escape') {
            setHelpVisible(false);
        }
    }
);

const historyPanel =
    document.createElement('div');

historyPanel.style.position = 'absolute';
historyPanel.style.left = '26px';
historyPanel.style.top = '110px';
historyPanel.style.bottom = '180px';
historyPanel.style.width = 'min(320px, calc(100% - 52px))';
historyPanel.style.display = 'none';
historyPanel.style.flexDirection = 'column';
historyPanel.style.borderRadius = '16px';
historyPanel.style.background = 'rgba(0,0,0,0.55)';
historyPanel.style.color = 'white';
historyPanel.style.backdropFilter = 'blur(10px)';
historyPanel.style.overflow = 'hidden';
historyPanel.style.pointerEvents = 'auto';
historyPanel.style.zIndex = '20';

const historyHeader =
    document.createElement('div');

historyHeader.style.display = 'flex';
historyHeader.style.alignItems = 'center';
historyHeader.style.justifyContent = 'space-between';
historyHeader.style.padding = '10px 12px';
historyHeader.style.fontSize = '13px';
historyHeader.style.fontWeight = 'bold';

const historyTitle =
    document.createElement('span');

historyTitle.textContent = 'Conversación';

historyHeader.appendChild(historyTitle);

const historyDelete =
    document.createElement('button');

historyDelete.type = 'button';
historyDelete.title = 'Borrar conversación';
historyDelete.setAttribute('aria-label', 'Borrar conversación');
historyDelete.innerHTML = TRASH_ICON;
historyDelete.style.display = 'flex';
historyDelete.style.alignItems = 'center';
historyDelete.style.justifyContent = 'center';
historyDelete.style.width = '30px';
historyDelete.style.height = '30px';
historyDelete.style.border = 'none';
historyDelete.style.borderRadius = '50%';
historyDelete.style.background = 'transparent';
historyDelete.style.color = 'inherit';
historyDelete.style.cursor = 'pointer';

historyHeader.appendChild(historyDelete);
historyPanel.appendChild(historyHeader);

const historyMessages =
    document.createElement('div');

historyMessages.style.flex = '1';
historyMessages.style.display = 'flex';
historyMessages.style.flexDirection = 'column';
historyMessages.style.gap = '8px';
historyMessages.style.padding = '4px 12px 12px';
historyMessages.style.overflowY = 'auto';
historyMessages.classList.add('paseta-scroll');

historyPanel.appendChild(historyMessages);

interfaceContainer.appendChild(
    historyPanel
);

function historyBubble(entry: HistoryEntry) {

    const bubble =
        document.createElement('div');

    bubble.style.maxWidth = '88%';
    bubble.style.padding = '8px 11px';
    bubble.style.borderRadius = '13px';
    bubble.style.fontSize = '13px';
    bubble.style.lineHeight = '1.4';
    bubble.style.wordBreak = 'break-word';
    bubble.textContent = entry.content;

    if (entry.role === 'user') {

        bubble.style.alignSelf = 'flex-end';
        bubble.style.background = '#3b82f6';
        bubble.style.color = 'white';

    } else if (entry.role === 'assistant') {

        bubble.style.alignSelf = 'flex-start';
        bubble.style.background = isDarkTheme
            ? 'rgba(255,255,255,0.12)'
            : 'rgba(0,0,0,0.07)';
        bubble.style.color = isDarkTheme ? 'white' : '#111827';

    } else {

        bubble.style.alignSelf = 'center';
        bubble.style.background = 'transparent';
        bubble.style.color = isDarkTheme
            ? 'rgba(255,255,255,0.65)'
            : 'rgba(0,0,0,0.55)';
        bubble.style.fontStyle = 'italic';
        bubble.style.fontSize = '12px';
    }

    return bubble;
}

function renderHistory() {

    if (typeof historyMessages === 'undefined') {
        return;
    }

    historyMessages.innerHTML = '';

    if (!displayHistory.length) {

        const empty =
            document.createElement('div');

        empty.style.alignSelf = 'center';
        empty.style.fontSize = '12px';
        empty.style.opacity = '0.6';
        empty.style.marginTop = '12px';
        empty.textContent = 'Aún no hay mensajes.';

        historyMessages.appendChild(empty);

        return;
    }

    for (const entry of displayHistory) {
        historyMessages.appendChild(
            historyBubble(entry)
        );
    }

    historyMessages.scrollTop =
        historyMessages.scrollHeight;
}

function setHistoryPanelVisible(visible: boolean) {

    historyPanel.style.display = visible ? 'flex' : 'none';

    historyButton.title = visible
        ? 'Ocultar conversación'
        : 'Ver conversación';

    if (visible) {
        renderHistory();
    }
}

historyButton.addEventListener(
    'click',
    () => {
        setHistoryPanelVisible(
            historyPanel.style.display !== 'flex'
        );
    }
);

historyDelete.addEventListener(
    'click',
    () => {

        if (!displayHistory.length) {
            return;
        }

        if (confirm('¿Borrar toda la conversación?')) {
            clearHistory();
            messagePanel.textContent = '';
        }
    }
);

loadHistory();
renderHistory();

// ======================================================
// MENU ⋮ (botones superiores en vertical)
// ======================================================

const MENU_ICON = `
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="5" r="1.6" fill="currentColor"/>
        <circle cx="12" cy="12" r="1.6" fill="currentColor"/>
        <circle cx="12" cy="19" r="1.6" fill="currentColor"/>
    </svg>`;

const menuButton =
    document.createElement('button');

menuButton.type = 'button';
menuButton.title = 'Opciones';
menuButton.setAttribute('aria-label', 'Abrir opciones');
menuButton.innerHTML = MENU_ICON;
menuButton.style.position = 'absolute';
menuButton.style.top = '16px';
menuButton.style.right = '26px';
menuButton.style.width = '40px';
menuButton.style.height = '40px';
menuButton.style.display = 'flex';
menuButton.style.alignItems = 'center';
menuButton.style.justifyContent = 'center';
menuButton.style.border = '1px solid rgba(255,255,255,0.22)';
menuButton.style.borderRadius = '50%';
menuButton.style.background = 'rgba(0,0,0,0.45)';
menuButton.style.backdropFilter = 'blur(10px)';
menuButton.style.color = 'white';
menuButton.style.cursor = 'pointer';
menuButton.style.pointerEvents = 'auto';
menuButton.style.zIndex = '20';

interfaceContainer.appendChild(
    menuButton
);

const menuPanel =
    document.createElement('div');

menuPanel.style.position = 'absolute';
menuPanel.style.top = '64px';
menuPanel.style.right = '26px';
menuPanel.style.display = 'none';
menuPanel.style.flexDirection = 'column';
menuPanel.style.gap = '8px';
menuPanel.style.padding = '8px';
menuPanel.style.borderRadius = '18px';
menuPanel.style.background = 'rgba(0,0,0,0.55)';
menuPanel.style.backdropFilter = 'blur(10px)';
menuPanel.style.pointerEvents = 'auto';
menuPanel.style.zIndex = '20';

interfaceContainer.appendChild(
    menuPanel
);

// Los botones sueltos pasan al menú vertical
for (const btn of [themeButton, avatarButton, iaButton, historyButton, helpButton]) {
    btn.style.position = 'static';
    btn.style.top = '';
    btn.style.right = '';
    menuPanel.appendChild(btn);
}

function setMenuVisible(visible: boolean) {
    menuPanel.style.display = visible ? 'flex' : 'none';
}

menuButton.addEventListener(
    'click',
    () => {
        setMenuVisible(
            menuPanel.style.display !== 'flex'
        );
    }
);

// Al elegir una opción el menú se cierra solo
menuPanel.addEventListener(
    'click',
    () => {
        setMenuVisible(false);
    }
);

// ======================================================
// CIERRE DE PANELES AL PULSAR FUERA
// ======================================================

document.addEventListener(
    'pointerdown',
    (event) => {

        const target = event.target as HTMLElement;

        const outside = (panel: HTMLElement, button: HTMLElement) =>
            panel.style.display === 'flex' &&
            !panel.contains(target) &&
            !button.contains(target);

        if (typeof iaPanel !== 'undefined' && typeof iaButton !== 'undefined') {

            if (outside(iaPanel, iaButton)) {
                iaPanel.style.display = 'none';
            }
        }

        if (
            typeof avatarPanel !== 'undefined' &&
            typeof avatarButton !== 'undefined'
        ) {

            if (outside(avatarPanel, avatarButton)) {
                setAvatarPanelVisible(false);
            }
        }

        if (
            typeof moodPanel !== 'undefined' &&
            typeof plusButton !== 'undefined'
        ) {

            if (outside(moodPanel, plusButton)) {
                setMoodPanelVisible(false);
            }
        }

        if (
            typeof historyPanel !== 'undefined' &&
            typeof historyButton !== 'undefined'
        ) {

            if (outside(historyPanel, historyButton)) {
                setHistoryPanelVisible(false);
            }
        }

        if (menuPanel.style.display === 'flex' &&
            !menuPanel.contains(target) &&
            !menuButton.contains(target)
        ) {
            setMenuVisible(false);
        }
    }
);

// Carga inicial (tras declarar toda la UI):
// primero revisa si hay avatares nuevos, elige el avatar
// por defecto si está, y luego carga.
refreshAvatarList()
    .catch(() => false)
    .finally(() => {
        if (AVATARS.some((a) => a.file === DEFAULT_AVATAR_FILE)) {
            currentAvatarFile = DEFAULT_AVATAR_FILE;
        }
        refreshAvatarButtons();
        loadAvatar(currentAvatarFile);
    });

// ======================================================
// PWA: registra el service worker solo en producción
// (en dev molestaría al recargar con HMR).
// ======================================================

if ('serviceWorker' in navigator && import.meta.env.PROD) {

    window.addEventListener(
        'load',
        () => {

            navigator.serviceWorker
                .register('/sw.js')
                .catch((err) => {
                    console.error(
                        '[PWA] No se pudo registrar el service worker:',
                        err
                    );
                });
        }
    );
}

// ======================================================
// CAPITALIZE
// ======================================================

function capitalize(
    value: string
): string {

    return value.charAt(0).toUpperCase() +
        value.slice(1);
}

// ======================================================
// CLOCK
// ======================================================

const clock =
    new THREE.Clock();

// ======================================================
// BLINK
// ======================================================

let blinkTimer =
    0;

let nextBlink =
    2 + Math.random() * 4;

let blinkDuration =
    0;

let isBlinking =
    false;

// ======================================================
// ANIMATION
// ======================================================

// ------------------------------------------------------
// MOVIMIENTO AUTÓNOMO
// ------------------------------------------------------
// En lugar de repetir siempre el mismo movimiento,
// el avatar va generando objetivos aleatorios y se acerca
// a ellos suavemente. Esto hace que el movimiento parezca
// más natural y menos mecánico.

type IdleTargets = {
    headX: number;
    headY: number;
    headZ: number;

    spineX: number;
    spineZ: number;

    leftArmZ: number;
    rightArmZ: number;

    leftArmX: number;
    rightArmX: number;

    leftElbowZ: number;
    rightElbowZ: number;

    leftElbowX: number;
    rightElbowX: number;

    leftHandX: number;
    leftHandY: number;
    leftHandZ: number;

    rightHandX: number;
    rightHandY: number;
    rightHandZ: number;
};

function randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

function createIdleTargets(): IdleTargets {
    return {
        headX: THREE.MathUtils.degToRad(randomRange(-2.0, 2.0)),
        headY: THREE.MathUtils.degToRad(randomRange(-4.0, 4.0)),
        headZ: THREE.MathUtils.degToRad(randomRange(-1.0, 1.0)),

        spineX: THREE.MathUtils.degToRad(randomRange(-1.2, 1.2)),
        spineZ: THREE.MathUtils.degToRad(randomRange(-1.6, 1.6)),

        // Rango amplio pero sesgado hacia FUERA del torso:
        // brazo izq. (reposo +85): hacia fuera = delta negativa.
        // brazo dcho. (reposo -85): hacia fuera = delta positiva.
        // Así el azar casi nunca empuja el brazo contra el cuerpo.
        leftArmZ: THREE.MathUtils.degToRad(randomRange(-9, 2)),
        rightArmZ: THREE.MathUtils.degToRad(randomRange(-2, 9)),

        leftArmX: THREE.MathUtils.degToRad(randomRange(-5, 5)),
        rightArmX: THREE.MathUtils.degToRad(randomRange(-5, 5)),

        leftElbowZ: THREE.MathUtils.degToRad(randomRange(-6, 2)),
        rightElbowZ: THREE.MathUtils.degToRad(randomRange(-2, 6)),

        leftElbowX: THREE.MathUtils.degToRad(randomRange(-4, 4)),
        rightElbowX: THREE.MathUtils.degToRad(randomRange(-4, 4)),

        leftHandX: THREE.MathUtils.degToRad(randomRange(-10, 10)),
        leftHandY: THREE.MathUtils.degToRad(randomRange(-8, 8)),
        leftHandZ: THREE.MathUtils.degToRad(randomRange(-8, 8)),

        rightHandX: THREE.MathUtils.degToRad(randomRange(-10, 10)),
        rightHandY: THREE.MathUtils.degToRad(randomRange(-8, 8)),
        rightHandZ: THREE.MathUtils.degToRad(randomRange(-8, 8))
    };
}

let idleCurrent: IdleTargets = createIdleTargets();
let idleTarget: IdleTargets = createIdleTargets();

let idleTargetTimer = 0;
let idleTargetDuration = randomRange(1.8, 3.5);

function updateIdleTargets(delta: number) {

    idleTargetTimer += delta;

    if (idleTargetTimer < idleTargetDuration) {
        return;
    }

    idleTargetTimer = 0;

    idleTargetDuration = randomRange(1.8, 3.5);

    idleTarget = createIdleTargets();
}

function smoothValue(
    current: number,
    target: number,
    delta: number,
    speed: number
): number {

    const factor =
        1 - Math.exp(-speed * delta);

    return THREE.MathUtils.lerp(
        current,
        target,
        factor
    );
}

function updateIdleAnimation(
    delta: number
) {

    if (!currentVrm) {
        return;
    }

    updateIdleTargets(delta);

    // --------------------------------------------------
    // Intensidad según estado
    // --------------------------------------------------

    let movementIntensity = 1;

    if (currentStatus === 'listening') {
        movementIntensity = 0.75;
    }
    else if (currentStatus === 'thinking') {
        movementIntensity = 1.0;
    }
    else if (currentStatus === 'speaking') {
        movementIntensity = 1.6;
    }

    // --------------------------------------------------
    // Interpolación de objetivos
    // --------------------------------------------------

    idleCurrent.headX = smoothValue(
        idleCurrent.headX,
        idleTarget.headX,
        delta,
        1.4
    );

    idleCurrent.headY = smoothValue(
        idleCurrent.headY,
        idleTarget.headY,
        delta,
        1.2
    );

    idleCurrent.headZ = smoothValue(
        idleCurrent.headZ,
        idleTarget.headZ,
        delta,
        1.3
    );

    idleCurrent.spineX = smoothValue(
        idleCurrent.spineX,
        idleTarget.spineX,
        delta,
        1.1
    );

    idleCurrent.spineZ = smoothValue(
        idleCurrent.spineZ,
        idleTarget.spineZ,
        delta,
        1.1
    );

    idleCurrent.leftArmZ = smoothValue(
        idleCurrent.leftArmZ,
        idleTarget.leftArmZ,
        delta,
        1.0
    );

    idleCurrent.rightArmZ = smoothValue(
        idleCurrent.rightArmZ,
        idleTarget.rightArmZ,
        delta,
        1.0
    );

    idleCurrent.leftArmX = smoothValue(
        idleCurrent.leftArmX,
        idleTarget.leftArmX,
        delta,
        1.0
    );

    idleCurrent.rightArmX = smoothValue(
        idleCurrent.rightArmX,
        idleTarget.rightArmX,
        delta,
        1.0
    );

    idleCurrent.leftElbowZ = smoothValue(
        idleCurrent.leftElbowZ,
        idleTarget.leftElbowZ,
        delta,
        1.3
    );

    idleCurrent.rightElbowZ = smoothValue(
        idleCurrent.rightElbowZ,
        idleTarget.rightElbowZ,
        delta,
        1.3
    );

    idleCurrent.leftElbowX = smoothValue(
        idleCurrent.leftElbowX,
        idleTarget.leftElbowX,
        delta,
        1.2
    );

    idleCurrent.rightElbowX = smoothValue(
        idleCurrent.rightElbowX,
        idleTarget.rightElbowX,
        delta,
        1.2
    );

    idleCurrent.leftHandX = smoothValue(
        idleCurrent.leftHandX,
        idleTarget.leftHandX,
        delta,
        1.8
    );

    idleCurrent.leftHandY = smoothValue(
        idleCurrent.leftHandY,
        idleTarget.leftHandY,
        delta,
        1.8
    );

    idleCurrent.leftHandZ = smoothValue(
        idleCurrent.leftHandZ,
        idleTarget.leftHandZ,
        delta,
        1.8
    );

    idleCurrent.rightHandX = smoothValue(
        idleCurrent.rightHandX,
        idleTarget.rightHandX,
        delta,
        1.8
    );

    idleCurrent.rightHandY = smoothValue(
        idleCurrent.rightHandY,
        idleTarget.rightHandY,
        delta,
        1.8
    );

    idleCurrent.rightHandZ = smoothValue(
        idleCurrent.rightHandZ,
        idleTarget.rightHandZ,
        delta,
        1.8
    );

    // --------------------------------------------------
    // Respiración
    // --------------------------------------------------

    const breathing =
        Math.sin(elapsedTime * 1.25) * 0.006;

    currentVrm.scene.position.y = breathing;

    // --------------------------------------------------
    // Pequeño balanceo natural
    // --------------------------------------------------

    const bodySway =
        Math.sin(elapsedTime * 0.55) * 0.004;

    currentVrm.scene.rotation.z =
        bodySway;

    // --------------------------------------------------
    // CABEZA
    // --------------------------------------------------

    if (headBone) {

        headBone.rotation.x =
            idleCurrent.headX *
            movementIntensity;

        headBone.rotation.y =
            idleCurrent.headY *
            movementIntensity;

        headBone.rotation.z =
            idleCurrent.headZ *
            movementIntensity;
    }

    // --------------------------------------------------
    // COLUMNA
    // --------------------------------------------------

    if (spineBone) {

        spineBone.rotation.x =
            idleCurrent.spineX *
            movementIntensity;

        spineBone.rotation.z =
            idleCurrent.spineZ *
            movementIntensity;
    }

    // --------------------------------------------------
    // BRAZOS
    //
    // Conservamos la posición de brazos ABAJO y sumamos:
    // objetivo aleatorio + balanceo continuo (estilo Hub).
    // --------------------------------------------------

    const armSwingL =
        Math.sin(elapsedTime * 0.9) * D(3.2) +
        Math.sin(elapsedTime * 0.53 + 1.3) * D(1.6);

    const armSwingR =
        Math.sin(elapsedTime * 0.9 + 0.6) * D(3.2) +
        Math.sin(elapsedTime * 0.53 + 2.1) * D(1.6);

    if (leftUpperArm) {

        leftUpperArm.rotation.z =
            leftArmRestAngle +
            idleCurrent.leftArmZ *
            movementIntensity +
            armSwingL * 0.5 * movementIntensity;

        leftUpperArm.rotation.x =
            idleCurrent.leftArmX *
            movementIntensity +
            armSwingL * movementIntensity;
    }

    if (rightUpperArm) {

        rightUpperArm.rotation.z =
            rightArmRestAngle +
            idleCurrent.rightArmZ *
            movementIntensity +
            armSwingR * 0.5 * movementIntensity;

        rightUpperArm.rotation.x =
            idleCurrent.rightArmX *
            movementIntensity +
            armSwingR * movementIntensity;
    }

    // --------------------------------------------------
    // CODOS
    // --------------------------------------------------

    const elbowSwingL =
        Math.sin(elapsedTime * 1.1 + 0.4) * D(2.5);

    const elbowSwingR =
        Math.sin(elapsedTime * 1.1 + 1.5) * D(2.5);

    // Flexión base: el humano nunca lleva el codo totalmente
    // estirado; varía con la respiración.
    const elbowBendBase =
        D(6) + Math.sin(elapsedTime * 0.45) * D(2.5);

    const shoulderRollL =
        Math.sin(elapsedTime * 0.62 + 0.9) * D(4);

    const shoulderRollR =
        Math.sin(elapsedTime * 0.62 + 2.2) * D(4);

    if (leftUpperArm) {
        leftUpperArm.rotation.y =
            shoulderRollL * movementIntensity;
    }

    if (rightUpperArm) {
        rightUpperArm.rotation.y =
            shoulderRollR * movementIntensity;
    }

    if (leftLowerArm) {

        leftLowerArm.rotation.z =
            leftElbowRestAngle +
            idleCurrent.leftElbowZ *
            movementIntensity +
            elbowSwingL * 0.6 * movementIntensity;

        leftLowerArm.rotation.x =
            idleCurrent.leftElbowX *
            movementIntensity +
            elbowSwingL * movementIntensity +
            elbowBendBase * movementIntensity;

        // Pronación/supinación suave del antebrazo
        leftLowerArm.rotation.y =
            Math.sin(elapsedTime * 0.5 + 0.3) * D(6) *
            movementIntensity;
    }

    if (rightLowerArm) {

        rightLowerArm.rotation.z =
            rightElbowRestAngle +
            idleCurrent.rightElbowZ *
            movementIntensity +
            elbowSwingR * 0.6 * movementIntensity;

        rightLowerArm.rotation.x =
            idleCurrent.rightElbowX *
            movementIntensity +
            elbowSwingR * movementIntensity +
            elbowBendBase * movementIntensity;

        rightLowerArm.rotation.y =
            Math.sin(elapsedTime * 0.5 + 1.8) * D(6) *
            movementIntensity;
    }

    // --------------------------------------------------
    // MANOS (muñeca con micromovimiento en 8, humano)
    // --------------------------------------------------

    const wristLx =
        Math.sin(elapsedTime * 0.7) * D(3) +
        Math.sin(elapsedTime * 1.3 + 0.8) * D(1.5);

    const wristLz =
        Math.cos(elapsedTime * 0.55) * D(3) +
        Math.sin(elapsedTime * 1.1 + 2.0) * D(1.5);

    const wristRx =
        Math.sin(elapsedTime * 0.7 + 1.1) * D(3) +
        Math.sin(elapsedTime * 1.3 + 2.4) * D(1.5);

    const wristRz =
        Math.cos(elapsedTime * 0.55 + 0.9) * D(3) +
        Math.sin(elapsedTime * 1.1 + 0.5) * D(1.5);

    if (leftHand) {

        leftHand.rotation.x =
            (idleCurrent.leftHandX + wristLx) *
            movementIntensity;

        leftHand.rotation.y =
            idleCurrent.leftHandY *
            movementIntensity +
            Math.sin(elapsedTime * 0.62 + 0.4) * D(2.5) *
            movementIntensity;

        leftHand.rotation.z =
            (idleCurrent.leftHandZ + wristLz) *
            movementIntensity;
    }

    if (rightHand) {

        rightHand.rotation.x =
            (idleCurrent.rightHandX + wristRx) *
            movementIntensity;

        rightHand.rotation.y =
            idleCurrent.rightHandY *
            movementIntensity +
            Math.sin(elapsedTime * 0.62 + 1.6) * D(2.5) *
            movementIntensity;

        rightHand.rotation.z =
            (idleCurrent.rightHandZ + wristRz) *
            movementIntensity;
    }

    // --------------------------------------------------
    // DEDOS (flexión por dedo + comportamiento humano)
    // --------------------------------------------------

    fingerTimer += delta;
    fingerBehaviorTimer += delta;

    if (fingerBehaviorTimer >= fingerBehaviorHold) {
        fingerBehaviorTimer = 0;
        fingerBehaviorHold = randomRange(7, 14);
        const r = Math.random();
        fingerBehavior =
            r < 0.5 ? 'relax'
            : r < 0.68 ? 'stretch'
            : r < 0.84 ? 'softFist'
            : 'tap';
        fingerTimer = fingerHold; // fuerza objetivos nuevos ya
    }

    if (fingerTimer >= fingerHold) {
        fingerTimer = 0;
        fingerHold = randomRange(1.6, 3.2);
        newFingerGoals();
    }

    tapPhase += delta * (fingerBehavior === 'tap' ? 6 : 1.5);

    const updateFingers = (
        bones: THREE.Object3D[],
        curl: number[],
        curlGoal: number[],
        spread: number[],
        spreadGoal: number[],
        speed: number,
        phaseBase: number
    ) => {

        for (let i = 0; i < bones.length; i++) {

            curl[i] = smoothValue(
                curl[i],
                curlGoal[i],
                delta,
                3.2
            );

            spread[i] = smoothValue(
                spread[i],
                spreadGoal[i],
                delta,
                3.2
            );

            const finger = Math.floor(i / 3);
            const micro =
                Math.sin(
                    elapsedTime * speed +
                    phaseBase +
                    finger * 0.9 +
                    (i % 3) * 0.35
                ) * D(1.6);

            // El tamborileo mueve sobre todo índice/corazón
            const tap =
                (fingerBehavior === 'tap' && (finger === 1 || finger === 2))
                    ? Math.max(0, Math.sin(tapPhase + finger * 1.4)) * D(7)
                    : 0;

            // Clamp: flexión suave, nunca puño que atraviese la palma
            bones[i].rotation.x = THREE.MathUtils.clamp(
                (curl[i] + micro + tap) * movementIntensity,
                D(-5),
                D(30)
            );

            bones[i].rotation.z = THREE.MathUtils.clamp(
                spread[i] * movementIntensity,
                D(-8),
                D(8)
            );
        }
    };

    updateFingers(
        leftFingerBones,
        fingerCurlL,
        fingerCurlGoalL,
        fingerSpreadL,
        fingerSpreadGoalL,
        0.9,
        0
    );

    updateFingers(
        rightFingerBones,
        fingerCurlR,
        fingerCurlGoalR,
        fingerSpreadR,
        fingerSpreadGoalR,
        0.85,
        1.7
    );
}

// ------------------------------------------------------
// BLINK
// ------------------------------------------------------

function updateBlink(delta: number) {

    if (!currentVrm) {
        return;
    }

    blinkTimer += delta;

    if (!isBlinking) {

        if (blinkTimer >= nextBlink) {

            isBlinking = true;
            blinkDuration = 0;
        }

    } else {

        blinkDuration += delta;

        const blinkTime = 0.16;

        let blink = 0;

        if (blinkDuration < blinkTime / 2) {

            blink =
                blinkDuration /
                (blinkTime / 2);

        } else {

            blink =
                1 -
                (
                    blinkDuration -
                    blinkTime / 2
                ) /
                (blinkTime / 2);
        }

        blink =
            THREE.MathUtils.clamp(
                blink,
                0,
                1
            );

        if (currentVrm.expressionManager) {

            currentVrm.expressionManager.setValue(
                'blink',
                blink
            );
        }

        if (blinkDuration >= blinkTime) {

            isBlinking = false;

            blinkTimer = 0;

            nextBlink =
                2 +
                Math.random() * 4;
        }
    }
}

// ------------------------------------------------------
// MOVIMIENTO HUMANO (capa extra por encima del idle)
// ------------------------------------------------------
// Añade: mirada (ojos + cabeza) que sigue a la cámara con
// miradas laterales, cambio de peso entre piernas,
// respiración, asentir al escuchar, ladear la cabeza al
// pensar y gestos de brazos al hablar.
//
// Si el modelo mira hacia el lado contrario al esperado
// (cabeza/brazos al revés), fuerza aquí el eje: -1 o 1.
const FORCE_FORWARD_Z: -1 | 1 | null = null;

type Gesture = { t: number; dur: number; arm: 'L' | 'R' | 'B'; amp: number };

const D = THREE.MathUtils.degToRad;
const clampN = THREE.MathUtils.clamp;

const hb: Record<string, THREE.Object3D | null> = {};
let hbReady = false;
let fz = -1; // hacia dónde mira el modelo en su espacio local (VRM0 = -1, VRM1 = +1)

const gazeTarget = new THREE.Object3D();
scene.add(gazeTarget);

const gaze = { goalX: 0, goalY: 0, eyeX: 0, eyeY: 0, headX: 0, headY: 0, timer: 0, hold: 2 };
const _p = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _h = new THREE.Vector3();

let lastStatusSeen: AvatarStatus = 'waiting';
let thinkBlend = 0;
let shiftTimer = 0, shiftHold = 6, shiftGoal = 0, shift = 0;
let nodTimer = 3, nodT = -1;
let gesture: Gesture | null = null;
let nextGesture = 1, gL = 0, gR = 0;

function initHumanMotion() {
    for (const n of ['hips', 'chest', 'neck', 'leftUpperLeg', 'rightUpperLeg']) {
        hb[n] = currentVrm.humanoid.getNormalizedBoneNode(n);
    }
    fz = FORCE_FORWARD_Z ?? (currentVrm.meta?.metaVersion === '0' ? -1 : 1);
    if (currentVrm.lookAt) {
        currentVrm.lookAt.target = gazeTarget;
    }
    hbReady = true;
}

function updateHumanMotion(delta: number, light = false) {

    if (!currentVrm) {
        return;
    }

    if (!hbReady) {
        initHumanMotion();
    }

    const t = elapsedTime;
    const lookUp = (a: number) => -fz * a; // ángulo positivo = mirar arriba

    // ---------------- MIRADA ----------------
    if (currentStatus !== lastStatusSeen) {
        lastStatusSeen = currentStatus;
        gaze.timer = gaze.hold;
    }

    gaze.timer += delta;

    if (gaze.timer >= gaze.hold) {
        gaze.timer = 0;

        const pAway = { waiting: 0.3, listening: 0.08, thinking: 0.9, speaking: 0.35 }[currentStatus];

        if (Math.random() < pAway) {
            gaze.goalX = randomRange(-1.6, 1.6);
            gaze.goalY = currentStatus === 'thinking' ? randomRange(0.4, 1.1) : randomRange(-0.7, 0.5);
            gaze.hold = currentStatus === 'thinking' ? randomRange(1.5, 3) : randomRange(0.7, 1.8);
        } else {
            gaze.goalX = randomRange(-0.15, 0.15);
            gaze.goalY = randomRange(-0.1, 0.1);
            gaze.hold = randomRange(2, 5);
        }
    }

    // Los ojos se mueven rápido (sacádicos); la cabeza los sigue más despacio
    // Si el ratón se movió hace poco, tira de la mirada (estilo Hub).
    const mouseActive =
        (t - mousePointer.lastMove < 3) ? 1 : 0;

    const mouseGoalX = mousePointer.x * 0.8;
    const mouseGoalY = mousePointer.y * 0.5;

    const mixedGoalX =
        gaze.goalX * (1 - 0.65 * mouseActive) +
        mouseGoalX * (0.65 * mouseActive);

    const mixedGoalY =
        gaze.goalY * (1 - 0.65 * mouseActive) +
        mouseGoalY * (0.65 * mouseActive);

    gaze.eyeX = smoothValue(gaze.eyeX, mixedGoalX, delta, 14);
    gaze.eyeY = smoothValue(gaze.eyeY, mixedGoalY, delta, 14);
    gaze.headX = smoothValue(gaze.headX, mixedGoalX, delta, 2.5);
    gaze.headY = smoothValue(gaze.headY, mixedGoalY, delta, 2.5);

    _r.setFromMatrixColumn(camera.matrixWorld, 0);
    _u.setFromMatrixColumn(camera.matrixWorld, 1);

    gazeTarget.position.copy(camera.position)
        .addScaledVector(_r, gaze.eyeX)
        .addScaledVector(_u, gaze.eyeY);

    let yaw = 0;
    let pitch = 0;

    if (headBone) {
        _p.copy(camera.position)
            .addScaledVector(_r, gaze.headX)
            .addScaledVector(_u, gaze.headY);

        headBone.getWorldPosition(_h);
        currentVrm.scene.worldToLocal(_p);
        currentVrm.scene.worldToLocal(_h);
        _p.sub(_h).normalize();

        yaw = clampN(Math.atan2(fz * _p.x, fz * _p.z), -D(40), D(40));
        pitch = clampN(-fz * Math.asin(clampN(_p.y, -1, 1)), -D(18), D(18));
    }

    // ---------------- ASENTIR / PENSAR ----------------
    if (currentStatus === 'listening') {
        nodTimer -= delta;
        if (nodTimer <= 0 && nodT < 0) {
            nodT = 0;
            nodTimer = randomRange(2.5, 5);
        }
    }

    let nod = 0;

    if (nodT >= 0) {
        nodT += delta;
        const p = nodT / 0.7;
        if (p >= 1) { nodT = -1; } else { nod = Math.sin(Math.PI * p); }
    }

    thinkBlend = smoothValue(thinkBlend, currentStatus === 'thinking' ? 1 : 0, delta, 2);

    // ---------------- CAMBIO DE PESO ----------------
    // (pausado en modo ligero: con un idle en bucle las
    // piernas las manda el clip, no el procedural)
    let tilt = 0;

    if (!light) {

        shiftTimer += delta;

        if (shiftTimer >= shiftHold) {
            shiftTimer = 0;
            shiftHold = randomRange(6, 12);
            shiftGoal = (Math.random() < 0.5 ? -1 : 1) * randomRange(0.5, 1);
        }

        shift = smoothValue(shift, shiftGoal, delta, 0.7);
        tilt = shift * D(2.2);

        if (hb.hips) { hb.hips.rotation.z = tilt; }
        // Las piernas contrarrotan para que los pies no se muevan
        if (hb.leftUpperLeg) { hb.leftUpperLeg.rotation.z = -tilt; }
        if (hb.rightUpperLeg) { hb.rightUpperLeg.rotation.z = -tilt; }
    }

    // ---------------- GESTOS AL HABLAR ----------------
    if (currentStatus === 'speaking') {
        nextGesture -= delta;

        if (!gesture && nextGesture <= 0) {
            gesture = {
                t: 0,
                dur: randomRange(1.1, 2.0),
                arm: (['L', 'R', 'B'] as const)[Math.floor(Math.random() * 3)],
                amp: randomRange(0.6, 1)
            };
            nextGesture = randomRange(0.4, 1.6);
        }
    }

    let env = 0;
    let armL = 0;
    let armR = 0;

    if (gesture) {
        gesture.t += delta;
        const p = gesture.t / gesture.dur;

        if (p >= 1) {
            gesture = null;
        } else {
            env = Math.pow(Math.sin(Math.PI * p), 2) * gesture.amp * (0.85 + 0.15 * Math.sin(t * 8));
            if (gesture.arm !== 'R') { armL = env; }
            if (gesture.arm !== 'L') { armR = env; }
        }
    }

    gL = smoothValue(gL, armL, delta, 8);
    gR = smoothValue(gR, armR, delta, 8);

    const swing = -fz; // + = hacia delante

    if (leftUpperArm) {
        leftUpperArm.rotation.x += swing * D(38) * gL;
        leftUpperArm.rotation.z -= D(8) * gL;
    }

    if (rightUpperArm) {
        rightUpperArm.rotation.x += swing * D(38) * gR;
        rightUpperArm.rotation.z += D(8) * gR;
    }

    if (leftLowerArm) { leftLowerArm.rotation.y += fz * D(55) * gL; }
    if (rightLowerArm) { rightLowerArm.rotation.y += -fz * D(55) * gR; }

    // ---------------- APLICAR A CABEZA / CUELLO / TRONCO ----------------
    const emphasis = Math.max(gL, gR);

    if (headBone) {
        headBone.rotation.y += yaw * 0.45;
        headBone.rotation.x += pitch * 0.4 + lookUp(-D(7) * nod - D(3) * emphasis);
        headBone.rotation.z += D(4) * thinkBlend - tilt * 0.4;
    }

    if (hb.neck) {
        hb.neck.rotation.y = yaw * 0.25;
        hb.neck.rotation.x = pitch * 0.25;
    }

    if (spineBone) {
        spineBone.rotation.y = yaw * 0.1;
        spineBone.rotation.z += -tilt * 0.8;
    }

    // Respiración (~15 respiraciones/min)
    if (hb.chest) {
        hb.chest.rotation.x = Math.sin(t * 1.6) * D(1.1);
    }
}

// ------------------------------------------------------
// LÍMITES ANTI-PENETRACIÓN (brazos/manostorso)
// ------------------------------------------------------
// Se aplican DESPUÉS de idle + gestos, antes de vrm.update.
// El brazo izq. reposa en +85° (hacia fuera = bajar Z),
// el dcho. en -85° (hacia fuera = subir Z).

function clampAngle(
    value: number,
    minDeg: number,
    maxDeg: number
): number {

    const min = THREE.MathUtils.degToRad(minDeg);
    const max = THREE.MathUtils.degToRad(maxDeg);

    return Math.min(max, Math.max(min, value));
}

function constrainArms() {

    if (leftUpperArm) {
        leftUpperArm.rotation.z = THREE.MathUtils.clamp(
            leftUpperArm.rotation.z,
            leftArmRestAngle + THREE.MathUtils.degToRad(-11),
            leftArmRestAngle + THREE.MathUtils.degToRad(3)
        );
        leftUpperArm.rotation.x = clampAngle(
            leftUpperArm.rotation.x, -12, 45
        );
        leftUpperArm.rotation.y = clampAngle(
            leftUpperArm.rotation.y, -12, 12
        );
    }

    if (rightUpperArm) {
        rightUpperArm.rotation.z = THREE.MathUtils.clamp(
            rightUpperArm.rotation.z,
            rightArmRestAngle + THREE.MathUtils.degToRad(-3),
            rightArmRestAngle + THREE.MathUtils.degToRad(11)
        );
        rightUpperArm.rotation.x = clampAngle(
            rightUpperArm.rotation.x, -12, 45
        );
        rightUpperArm.rotation.y = clampAngle(
            rightUpperArm.rotation.y, -12, 12
        );
    }

    if (leftLowerArm) {
        leftLowerArm.rotation.z = THREE.MathUtils.clamp(
            leftLowerArm.rotation.z,
            leftElbowRestAngle + THREE.MathUtils.degToRad(-8),
            leftElbowRestAngle + THREE.MathUtils.degToRad(6)
        );
        leftLowerArm.rotation.x = clampAngle(
            leftLowerArm.rotation.x, -5, 40
        );
        leftLowerArm.rotation.y = clampAngle(
            THREE.MathUtils.radToDeg(leftLowerArm.rotation.y), -70, 70
        ) * Math.PI / 180;
    }

    if (rightLowerArm) {
        rightLowerArm.rotation.z = THREE.MathUtils.clamp(
            rightLowerArm.rotation.z,
            rightElbowRestAngle + THREE.MathUtils.degToRad(-6),
            rightElbowRestAngle + THREE.MathUtils.degToRad(8)
        );
        rightLowerArm.rotation.x = clampAngle(
            rightLowerArm.rotation.x, -5, 40
        );
        rightLowerArm.rotation.y = clampAngle(
            THREE.MathUtils.radToDeg(rightLowerArm.rotation.y), -70, 70
        ) * Math.PI / 180;
    }

    for (const hand of [leftHand, rightHand]) {
        if (!hand) continue;
        hand.rotation.x = clampAngle(
            THREE.MathUtils.radToDeg(hand.rotation.x), -18, 18
        ) * Math.PI / 180;
        hand.rotation.y = clampAngle(
            THREE.MathUtils.radToDeg(hand.rotation.y), -18, 18
        ) * Math.PI / 180;
        hand.rotation.z = clampAngle(
            THREE.MathUtils.radToDeg(hand.rotation.z), -18, 18
        ) * Math.PI / 180;
    }
}

// ------------------------------------------------------
// MANDÍBULA (mueve la boca mientras habla por voz)
// ------------------------------------------------------
// Oscilación por sílabas; cuando llegue TTS cloud con
// visemas se alimentará desde los timestamps exactos.

function updateJaw(delta: number) {

    if (!currentVrm) {
        return;
    }

    const backendLevel = getVoiceLevel();

    const talkingBrowser =
        currentStatus === 'speaking' &&
        !backendVoiceActive() &&
        backendLevel <= 0 &&
        'speechSynthesis' in window &&
        window.speechSynthesis.speaking;

    // Con voz local la boca sigue al volumen real; con la del
    // navegador se mantiene la oscilación por sílabas.
    const target = backendVoiceActive() || backendLevel > 0
        ? Math.min(1, backendLevel * 1.35 + (backendLevel > 0.02 ? 0.1 : 0))
        : talkingBrowser
            ? 0.45 + 0.35 * Math.sin(elapsedTime * 11) +
              0.2 * Math.sin(elapsedTime * 23 + 1)
            : 0;

    const talking = backendVoiceActive() || talkingBrowser;

    jawOpen = smoothValue(
        jawOpen,
        Math.max(0, target),
        delta,
        talking ? 18 : 8
    );

    if (jawBone) {
        jawBone.rotation.x = jawOpen * D(14);
    }

    if (currentVrm.expressionManager) {

        try {
            currentVrm.expressionManager.setValue('aa', jawOpen * 0.9);
        } catch {
            // El modelo no trae visema 'aa': solo hueso.
        }
    }
}

// ------------------------------------------------------
// ANIMATION LOOP
// ------------------------------------------------------

function animate() {

    requestAnimationFrame(
        animate
    );

    const rawDelta =
        clock.getDelta();

    const delta =
        Math.min(rawDelta, 0.05);

    elapsedTime += delta;

    // El baile FBX manda sobre los huesos: mientras está
    // activo se pausa el idle procedural (que si no
    // pelearía con el clip) y al terminar se retoma solo.
    // Lo mismo con un idle en bucle (respiración): el clip
    // mueve el cuerpo y el procedural queda en ligero.
    const dancing = updateDance(delta) > 0;
    const looping = updateIdleLoop(delta) > 0;
    const proceduralBody = !dancing && !looping;

    if (currentVrm) {

        if (proceduralBody) {

            updateIdleAnimation(
                delta
            );

            updateHumanMotion(
                delta,
                false
            );

            constrainArms();

        } else if (looping) {

            updateHumanMotion(
                delta,
                true
            );
        }

        updateBlink(
            delta
        );

        updateJaw(
            delta
        );

        // Balanceo lateral: gira a un lado y vuelve antes
        // de dar la vuelta. Solo en espera y sin
        // interacción reciente con la cámara. Al hablar,
        // pensar o escuchar vuelve al frente para que se
        // le vea la cara. Durante el baile se congela.
        if (!dancing) {

            if (
                currentStatus === 'waiting' &&
                (elapsedTime - lastCameraInteraction) > SWAY_RESUME_DELAY
            ) {
            const swayTarget =
                SWAY_BASE_YAW +
                Math.sin(elapsedTime * SWAY_SPEED) * SWAY_AMPLITUDE;

            currentVrm.scene.rotation.y = smoothValue(
                currentVrm.scene.rotation.y,
                swayTarget,
                delta,
                2
            );
        } else if (currentStatus !== 'waiting') {
            currentVrm.scene.rotation.y = smoothValue(
                currentVrm.scene.rotation.y,
                SWAY_BASE_YAW,
                delta,
                2
            );
        }
        }

        // Solo los VRM traen update() propio (expresiones,
        // mirada, springbones); la fachada FBX no lo tiene.
        if (typeof currentVrm.update === 'function') {

            currentVrm.update(
                delta
            );
        }
    }

    updateCamTransition(delta);

    clampCameraTarget();

    controls.update();

    renderer.render(
        scene,
        camera
    );
}

animate();

// RESIZE
// ======================================================

// ======================================================
// RESPONSIVE (móvil en vertical)
// ======================================================
// En pantallas estrechas el estado baja debajo de los
// botones y la cabecera se compacta para no solaparse.

function applyResponsiveLayout() {

    const narrow = window.innerWidth < 680;

    statusContainer.style.top = narrow ? '22px' : '20px';
    statusContainer.style.fontSize = narrow ? '12px' : '15px';

    // En móvil la cabecera se compacta y sin subtítulo para
    // no chocar con los botones ni con el estado.
    header.style.left = narrow ? '16px' : '30px';
    header.style.gap = narrow ? '8px' : '12px';

    headerTitle.style.fontSize = narrow ? '24px' : '40px';
    headerLogo.style.width = narrow ? '40px' : '74px';
    headerLogo.style.height = narrow ? '40px' : '74px';
    headerSubtitle.style.display = narrow ? 'none' : 'block';

    historyPanel.style.top = narrow ? '140px' : '110px';
}

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

        applyResponsiveLayout();
    }
);

applyResponsiveLayout();