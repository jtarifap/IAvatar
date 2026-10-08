import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Desarrollo en HTTPS (certificado autofirmado) para que el
// micrófono (SpeechRecognition) funcione en móvil y en PC por
// red local, donde el contexto no seguro lo bloquea.
//
// /api se redirige al backend para evitar contenido mixto:
// la página https habla con el mismo origen y vite lo
// reenvía a http://localhost:3001.
export default defineConfig({
    plugins: [basicSsl()],
    server: {
        host: true,
        https: true,
        proxy: {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true
            }
        }
    },
    preview: {
        host: true,
        https: true,
        proxy: {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true
            }
        }
    }
});
