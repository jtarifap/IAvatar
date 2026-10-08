// Prueba rápida: genera un WAV con la voz indicada.
const path = require('path');
const sherpa_onnx = require('sherpa-onnx-node');

const voiceDir = process.argv[2] || 'mls_10246-low';
const text = process.argv[3] || 'Hola, soy Paseta, tu colega virtual.';
const sid = Number(process.argv[4] || 0);
const outFile = process.argv[5] || `server/voices/prueba-${voiceDir}-sid${sid}.wav`;

const dir = path.join(__dirname, 'voices', voiceDir);
const files = require('fs').readdirSync(dir);
const onnx = files.find((f) => f.endsWith('.onnx') && !f.endsWith('.json'));

const tts = new sherpa_onnx.OfflineTts({
  model: {
    vits: {
      model: path.join(dir, onnx),
      tokens: path.join(dir, 'tokens.txt'),
      dataDir: path.join(dir, 'espeak-ng-data'),
      voice: 'es',
    },
    numThreads: 2,
    provider: 'cpu',
  },
  maxNumSentences: 2,
});

const t0 = Date.now();
const audio = tts.generate({
  text,
  generationConfig: new sherpa_onnx.GenerationConfig({ sid, speed: 1.0 }),
});
const ms = Date.now() - t0;

sherpa_onnx.writeWave(outFile, {
  samples: audio.samples,
  sampleRate: audio.sampleRate,
});

console.log(`OK ${outFile} (${audio.sampleRate} Hz, ${(audio.samples.length / audio.sampleRate).toFixed(2)}s audio, generado en ${(ms / 1000).toFixed(1)}s)`);
