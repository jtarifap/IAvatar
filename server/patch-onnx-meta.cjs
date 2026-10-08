// Añade el metadato sample_rate que sherpa-onnx exige a los
// modelos Piper descargados en crudo desde HuggingFace.
// Uso: node server/patch-onnx-meta.cjs <voz> <sample_rate>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const voiceDir = process.argv[2];
const sampleRate = String(process.argv[3] || '16000');

if (!voiceDir) {
  console.error('Uso: patch-onnx-meta.cjs <carpeta-voz> <sample_rate>');
  process.exit(1);
}

const dir = path.join(__dirname, 'voices', voiceDir);
const onnxFile = fs.readdirSync(dir).find((f) => f.endsWith('.onnx') && !f.endsWith('.json'));
const full = path.join(dir, onnxFile);

const backup = `${full}.orig`;
if (!fs.existsSync(backup)) {
  fs.copyFileSync(full, backup);
  console.log('Copia original en', path.basename(backup));
}

const script = `
import json, onnx
p = r'''${full}'''
m = onnx.load(p)
props = {e.key: e.value for e in m.metadata_props}
with open(p + '.json', encoding='utf-8') as f:
    cfg = json.load(f)
lang = 'es'
wanted = {'sample_rate': '${sampleRate}', 'n_speakers': '1', 'language': lang, 'comment': 'piper', 'voice': 'es'}
for k, v in wanted.items():
    if k not in props:
        e = m.metadata_props.add()
        e.key = k
        e.value = v
        print(f'metadato {k}={v} añadido')
    elif props[k] != v:
        for e in m.metadata_props:
            if e.key == k:
                e.value = v
        print(f'metadato {k} actualizado a {v}')
    else:
        print(f'ya tenía {k}={props[k]}')
onnx.save(m, p)
`;

try {
  const out = execFileSync('python', ['-c', script], { encoding: 'utf8' });
  console.log(out.trim());
} catch (err) {
  console.error('Fallo al parchear:', err.message);
  process.exit(1);
}
