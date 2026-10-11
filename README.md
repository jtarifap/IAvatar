# Paseta 🗣️

La colega virtual que lo sabe casi todo: avatar 3D expresivo con el que hablas por **texto o por voz**, con IA local (gratis) o cloud, y voz propia offline. Instalable como app (PWA) en PC y Android.
<p align="center">
  <img width="48%" alt="Paseta avatar" src="https://github.com/user-attachments/assets/f82bf9f0-6401-47dc-8306-0701ebef5789" />
  <img width="48%" alt="Paseta chat" src="https://github.com/user-attachments/assets/e9654838-29fb-49c5-9c55-b1138e2f35a1" />
</p>



<p align="center">
  <img width="48%" alt="Paseta avatar" src="https://github.com/user-attachments/assets/3462b2c5-76f8-47ab-bf4b-d080dc74672a" />
  <img width="48%" alt="Paseta chat" src="https://github.com/user-attachments/assets/e9654838-29fb-49c5-9c55-b1138e2f35a1" />
</p>

![stack](https://img.shields.io/badge/three.js-VRM-blue) ![pwa](https://img.shields.io/badge/PWA-instalable-green) ![ia](https://img.shields.io/badge/IA-Ollama_%2F_OpenAI-orange)

---

## ✨ Qué hace

- **Avatar 3D (.vrm)** que te mira, parpadea, gesticula, mueve la boca al hablar y cambia de expresión (feliz, triste, enfadado…).
- **Chat con IA**: Ollama en local (gratis, privado) o cualquier API compatible OpenAI (OpenAI, OpenRouter, LM Studio…), con historial de conversación.
- **Voz en los dos sentidos**: dictado por micrófono 🎙️ (manos libres: al callar 1,5 s envía solo) y respuesta hablada con voz local offline (Piper) o la del navegador.
- **Multi-avatar**: copia un `.vrm` a `public/models` y aparece solo en el desplegable, sin tocar código.
- **Emoticonos y órdenes** (`:)`, `pon cara triste`, `sonríe`) que cambian la expresión sin gastar IA.
- **PWA instalable**: icono propio, pantalla completa y funcionamiento parcial offline.
- Temas claro/oscuro, zoom a la cara con doble clic, panel de configuración de IA y voces.

---

## 🧰 Requisitos

| Qué | Para qué | Instalación |
|---|---|---|
| **Node.js 18+** | frontend + backend | https://nodejs.org |
| **Ollama** | IA local gratis (recomendado) | https://ollama.com |
| **Chrome o Edge** | micrófono y PWA (mejor soporte) | — |
| Micrófono | dictado por voz | — |

Comprueba versiones:

```bash
node --version
npm --version
ollama --version
```

---

## 🚀 Instalación paso a paso

### 1. Clona el repositorio e instala dependencias

```bash
git clone <TU-REPO-EN-GITHUB>
cd IAvatar
npm install
```

### 2. Prepara Ollama (IA local)

```bash
# Terminal 1: arranca Ollama (o abre la app de Ollama)
ollama serve

# Terminal 2: descarga un modelo ligero (elige uno)
ollama pull gemma2:2b
# Alternativas: ollama pull qwen2.5:0.5b | ollama pull llama3.2:1b
```

> Al arrancar, el backend detecta tus modelos y elige solo el más ligero disponible (`gemma3:2b > *:2b > :1b > :0.5b`). Puedes cambiarlo después desde el panel ⚙️ de la app.

### 3. Configura el backend (opcional)

```bash
# Windows (PowerShell)
Copy-Item server\.env.example server\.env
# Linux/macOS
cp server/.env.example server/.env
```

Edita `server/.env` solo si necesitas cambiar algo:

- `PROVIDER=ollama` (o `openai` para cloud) + `OPENAI_API_KEY=...`
- `TTS_VOICE=sharvard-medium` (voces instaladas en `server/voices`)
- `SYSTEM_PROMPT` / `AVATAR_NAME` para la personalidad

### 4. Arranca el backend

```bash
# Terminal 3
npm run server
# → [IA] Backend listo en http://localhost:3001
```

### 5. Arranca el frontend

```bash
# Terminal 4
npm run dev
# → Local: https://localhost:5173/
```

Abre esa URL y **acepta el certificado autofirmado** (Avanzado → continuar). El HTTPS local es necesario para que el micrófono funcione.

---

## 🎮 Uso

1. Pulsa el **micrófono** 🎙️ y habla: puedes explayarte, y **al callar 1,5 s se envía solo**. Segundo clic = cancelar dictado.
2. O escribe y pulsa **Enviar** (o Enter).
3. Paseta **piensa** (● amarillo), **responde y habla** (● morado).
4. Botones de la barra superior: **avatar** 👤 (cambiar de personaje), **IA** ⚙️ (proveedor, modelo, backend, voz), **tema** 🌙☀️, **historial** 🕘.
5. **Doble clic** en el avatar = zoom a la cara; fuera de él = volver al cuerpo.
6. Prueba `pon cara triste`, `sonríe` o escribe `:)`.

---

## 👤 Añadir avatares nuevos

1. Consigue un modelo `.vrm` (p. ej. créalo gratis con [VRoid Studio](https://vroid.com/studio) o descárgalo de [VRoid Hub](https://hub.vroid.com/)).
2. Cópialo a `public/models/`.
3. Listo: al recargar (y al abrir el desplegable 👤) aparece solo con su nombre.

> Los `.vrm` **no se suben a GitHub** (72 MB): cada instalación pone los suyos. El desplegable se alimenta de `GET /api/avatars`, que escanea la carpeta. **El backend (`npm run server`) debe estar en marcha** con el código actual para que liste los nuevos.

## 🔊 Voces (TTS local)

Las voces **tampoco se suben a GitHub** (245 MB). Para tener voz propia offline:

1. Descarga una voz española de [Piper](https://github.com/rhasspy/piper) (p. ej. `es_ES-sharvard-medium` o `es_ES-mls_10246-low`) desde sus [releases](https://github.com/rhasspy/piper/releases): necesitas el `.onnx` y su `.onnx.json`.
2. Descomprímelos en `server/voices/<id>/` (p. ej. `server/voices/sharvard-medium/`), junto a su `MODEL_CARD`, `tokens.txt`, etc.
3. Elige la voz en `server/.env` (`TTS_VOICE=<id>`) o desde el panel ⚙️ de la app, que lista las instaladas (`GET /api/tts/voices`).

> Sin voces instaladas, la app habla con la voz del navegador (síntesis del sistema).

---

## 📲 Instalar como app (PWA)

La app ya incluye manifiesto (`public/manifest.webmanifest`), iconos (`public/icons/`) y *service worker* (`public/sw.js`, con caché offline; los `.vrm` de 20–30 MB se cachean bajo demanda, no en la instalación).

```bash
npm run build     # genera dist/
npm run preview   # sirve dist/ en https://localhost:4173
```

- **En PC (Chrome/Edge)**: icono de instalar en la barra de direcciones, o menú ⋮ → *Instalar*.
- **En Android**: abre la URL en Chrome → ⋮ → *Instalar app*.
- Compruébalo en DevTools → *Application* → *Manifest / Service Workers*.
- Para forzar actualización de la caché tras cambios, sube `CACHE_VERSION` en `public/sw.js`.

> La instalación exige **HTTPS con certificado válido** (o `localhost`). Para el móvil desde tu portátil, ver siguiente punto.

---

## 🌍 Exponerla en internet (túnel Cloudflare, gratis)

Sirve tu portátil al mundo con URL pública https (válida para instalar la PWA en Android):

```bash
# 1. Instala cloudflared (o descárgalo de
# https://github.com/cloudflare/cloudflared/releases)
winget install --id Cloudflare.cloudflared

# 2. Con backend + preview en marcha:
npm run server
npx vite preview --port 4173 --strictPort

# 3. Abre el túnel (otra terminal)
cloudflared tunnel --url https://localhost:4173 --no-tls-verify
# → https://algo-aleatorio.trycloudflare.com
```

Gracias al proxy `/api` de `vite.config.ts`, **un solo túnel** da acceso a la web y al backend (chat, avatares y voces).

**Límites**: el portátil debe estar encendido con todo en marcha; la URL es aleatoria y cambia al reiniciar el túnel. Para una dirección fija (`paseta.tudominio.com`) necesitas dominio propio (~10–15 €/año) + cuenta gratuita de Cloudflare con túnel nombrado.

---

## 🗂️ Estructura del proyecto

```
IAvatar/
├── index.html              # manifiesto PWA, metadatos, punto de entrada
├── vite.config.ts          # HTTPS local + proxy /api → backend
├── src/
│   ├── main.ts             # app 3D, chat, voz, micrófono, PWA
│   └── ai/client.ts        # cliente del backend (mismo origen en https)
├── public/
│   ├── models/             # avatares .vrm (detección automática)
│   ├── icons/              # iconos PWA 192/512 + apple-touch
│   ├── manifest.webmanifest
│   └── sw.js               # service worker
├── server/
│   ├── chat-server.mjs     # backend: chat + TTS + lista de avatares
│   ├── .env.example        # plantilla de configuración (copiar a .env)
│   ├── tts.mjs             # síntesis de voz local (Piper)
│   └── voices/             # voces instaladas
└── dist/                   # build de producción (no se sube a git)
```

### API del backend (`http://localhost:3001`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | estado + modelo activo |
| GET/PUT | `/api/config` | leer/cambiar proveedor y modelo |
| GET | `/api/avatars` | `.vrm` detectados en `public/models` |
| GET | `/api/tts/voices` | voces instaladas |
| POST | `/api/tts` `{texto}` | sintetiza voz (WAV) |
| POST | `/api/chat` `{mensaje, historial?}` | pregunta a la IA |
| GET | `/api/ollama/models` | modelos locales de Ollama |

---

## ❓ Problemas frecuentes

| Síntoma | Solución |
|---|---|
| `No puedo conectar con el backend` | Arranca `npm run server` (puerto 3001 libre) |
| El micro no escucha / sin permiso | Usa Chrome/Edge por HTTPS y permite el micrófono en el candado de la URL |
| El dictado se corta pronto | Comprueba que usas el código actual (`continuous=true` + auto-envío a 1,5 s) |
| Avatar nuevo no aparece | Backend en marcha con el código actual + recarga la página |
| `Ollama devolvió…` / no conecta | `ollama serve` en marcha y modelo descargado (`ollama list`) |
| Puerto ocupado (3001/4173/5173) | Cierra la otra instancia o cambia el puerto |
| La PWA no ofrece instalarse | Debe servirse por HTTPS válido (túnel o hosting), no por http |

---

## 📜 Licencia y créditos

Proyecto personal. Avatar de ejemplo de [VRoid Hub](https://hub.vroid.com/) (licencia de cada modelo), 3D con [three.js](https://threejs.org/) + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm), IA con [Ollama](https://ollama.com/), voz local con [Piper](https://github.com/rhasspy/piper) vía `sherpa-onnx`.
