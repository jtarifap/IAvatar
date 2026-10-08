// ======================================================
// Contenidos de la Ayuda (edita aquí los textos)
// ======================================================

export interface HelpSection {
    id: string;
    title: string;
    lines: string[];
}

export interface ContactInfo {
    name: string;
    role: string;
    email: string;
    web: string;
    github: string;
    linkedin: string;
}

export const CONTACT: ContactInfo = {
    name: 'Jorge Tarifa',
    role: 'Consultor IT / Ingeniero de aplicaciones y soluciones IA',
    email: 'jtarifa@gmail.com',
    web: 'https://jtarifap.github.io',
    github: 'https://github.com/jtarifap',
    linkedin: 'https://www.linkedin.com/in/jorgetarifa'
};

export const HELP_SECTIONS: HelpSection[] = [
    {
        id: 'hablar',
        title: 'Hablar con Paseta',
        lines: [
            'Escribe en la barra inferior y pulsa Enviar o Enter.',
            'Pulsa el micrófono y habla: tu voz se convierte en texto.',
            'Los emoticonos no se leen: ponen la cara (ej. :) alegra, :( entristece).',
            'Órdenes directas: "pon cara triste", "sonríe" o "haz cara de enfadado".',
            'Si tarda pensando o quieres callarla, pulsa el botón rojo de parar.'
        ]
    },
    {
        id: 'camara',
        title: 'Gestos de cámara',
        lines: [
            'Arrastra para girar alrededor del avatar.',
            'Rueda o pellizco para acercar y alejar.',
            'Clic derecho (o dos dedos) para desplazar la vista.',
            'Doble clic en el avatar o botón lupa: acerca a la cara para ver la boca.',
            'Doble clic fuera o mismo botón: vuelve al cuerpo.'
        ]
    },
    {
        id: 'expresiones',
        title: 'Expresiones y avatares',
        lines: [
            'Botón +: abre las expresiones (Feliz, Triste, Enfadado...). Al elegir una se aplica y se cierra.',
            'Botón avatar: cambia entre los modelos de la carpeta public/models.',
            'Botón sol/luna: alterna tema claro y oscuro.',
            'Botón bocadillo: muestra u oculta la conversación.'
        ]
    },
    {
        id: 'vozia',
        title: 'Voz e IA',
        lines: [
            'Botón IA: cambia proveedor (Ollama local gratis o cloud), modelo, voz y locutor.',
            'Sin backend (npm run server) no hay respuestas: verás el aviso en el panel IA.',
            'Sin Ollama arrancado (ollama serve) el proveedor local no responde.',
            'Si la voz local falla, se usa automáticamente la del navegador.'
        ]
    },
    {
        id: 'privacidad',
        title: 'Privacidad',
        lines: [
            'La conversación se guarda solo en tu navegador (localStorage).',
            'La papelera del panel la borra por completo.',
            'Con Ollama y voz local nada sale de tu PC.',
            'Con proveedor cloud, tus mensajes van al servicio contratado.'
        ]
    },
    {
        id: 'acerca',
        title: 'Acerca de',
        lines: [
            'Paseta · v1.0 · 2026.',
            'Desarrollado por Jorge Tarifa — Consultor IT / Ingeniero de aplicaciones y soluciones IA.',
            'Asistente virtual con avatar 3D, IA local y voz propia offline: privada y gratuita.',
            'Stack: Three.js + three-vrm, Ollama, Piper/sherpa-onnx, modelo VRoid.',
            'Voces: Sharvard (CC-BY, dataset DataShare Edinburgh) y MLS.'
        ]
    },
    {
        id: 'contactar',
        title: 'Contactar',
        lines: []
    }
];
