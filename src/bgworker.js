/* Remove background: the helper process that runs the model (BiRefNet lite, renderer/photoedit.js
   asks for it through main.js). It runs on its own so its memory (several GB while working) goes
   back to Windows when it closes, and a crash here can't take Endpaper down with it.

   In: { id, rgba } — the photo squeezed to 1024 × 1024, as RGBA bytes.
   Out: { id, mask } — 1024 × 1024 bytes, 255 where the subject is, 0 for background; or { id, error }.
   The graphics card is used through DirectML when it can be, the processor otherwise. */
const ort = require('onnxruntime-node');

const N = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
let session = null;
let device = null;

async function open(modelPath) {
  if (session) return session;
  for (const ep of ['dml', 'cpu']) {
    try {
      session = await ort.InferenceSession.create(modelPath, { executionProviders: [ep], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
      device = ep;
      return session;
    } catch (e) {
      if (ep === 'cpu') throw e;
    }
  }
}

function toInput(rgba) {
  const x = new Float32Array(3 * N * N);
  const plane = N * N;
  for (let i = 0, p = 0; p < plane; i += 4, p++) {
    x[p] = (rgba[i] / 255 - MEAN[0]) / STD[0];
    x[plane + p] = (rgba[i + 1] / 255 - MEAN[1]) / STD[1];
    x[2 * plane + p] = (rgba[i + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', x, [1, 3, N, N]);
}

// The model gives a score per pixel; a sigmoid turns it into how sure it is (0 to 1).
function toMask(out) {
  const v = out.data;
  const m = new Uint8Array(N * N);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 4096; i++) (lo = Math.min(lo, v[i * 256])), (hi = Math.max(hi, v[i * 256]));
  const scores = lo < -0.01 || hi > 1.01; // raw scores, not already 0 to 1
  for (let i = 0; i < m.length; i++) {
    const p = scores ? 1 / (1 + Math.exp(-v[i])) : v[i];
    m[i] = p <= 0 ? 0 : p >= 1 ? 255 : Math.round(p * 255);
  }
  return m;
}

async function run(rgba, modelPath) {
  const s = await open(modelPath);
  const feeds = { [s.inputNames[0]]: toInput(rgba) };
  let r;
  try {
    r = await s.run(feeds);
  } catch (e) {
    if (device !== 'dml') throw e;
    // The graphics card couldn't do it: try again on the processor.
    await s.release().catch(() => {});
    session = null;
    device = null;
    session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    device = 'cpu';
    r = await session.run(feeds);
  }
  return toMask(r[session.outputNames[0]]);
}

process.parentPort.on('message', async (e) => {
  const { id, rgba, model } = e.data || {};
  try {
    const t0 = Date.now();
    const mask = await run(new Uint8Array(rgba), model);
    process.parentPort.postMessage({ id, mask, ms: Date.now() - t0, device });
  } catch (err) {
    process.parentPort.postMessage({ id, error: String((err && err.message) || err) });
  }
});
