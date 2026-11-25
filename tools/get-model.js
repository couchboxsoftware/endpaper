// Fetches the background-removal model into models/ if it isn't there (or isn't the right file).
// It's too big for git (GitHub refuses files over 100 MB), so it's fetched before building and
// shipped inside the installer. The address is pinned to one version of the model, and the file
// must match its fingerprint (SHA-256) or it's thrown away.
//
// The model: BiRefNet lite, half precision, by Peng Zheng et al., MIT licence.
// https://github.com/ZhengPeng7/BiRefNet  ·  ONNX copy: huggingface.co/onnx-community/BiRefNet_lite-ONNX
//
// Run: node tools/get-model.js   (npm run release and npm run dist run it for you)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODEL = {
  file: path.join(__dirname, '..', 'models', 'birefnet-lite-fp16.onnx'),
  url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model_fp16.onnx',
  sha256: 'd39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402',
  bytes: 114538221,
};

const hashOf = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

async function ensure({ quiet = false } = {}) {
  const say = (s) => !quiet && console.log(s);
  if (fs.existsSync(MODEL.file) && fs.statSync(MODEL.file).size === MODEL.bytes && (await hashOf(MODEL.file)) === MODEL.sha256) {
    say('Background-removal model is ready.');
    return MODEL.file;
  }
  fs.mkdirSync(path.dirname(MODEL.file), { recursive: true });
  say(`Fetching the background-removal model (${(MODEL.bytes / 1e6).toFixed(1)} MB)…`);
  const res = await fetch(MODEL.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Couldn't fetch the model: ${res.status} ${res.statusText}`);
  const part = MODEL.file + '.part';
  const out = fs.createWriteStream(part);
  const h = crypto.createHash('sha256');
  let got = 0, shown = 0;
  for await (const chunk of res.body) {
    h.update(chunk);
    out.write(chunk);
    got += chunk.length;
    if (!quiet && got - shown > 10e6) {
      shown = got;
      process.stdout.write(`  ${Math.round((got / MODEL.bytes) * 100)}%\r`);
    }
  }
  await new Promise((r) => out.end(r));
  const sum = h.digest('hex');
  if (sum !== MODEL.sha256 || got !== MODEL.bytes) {
    fs.rmSync(part, { force: true });
    throw new Error(`The model didn't match its fingerprint (got ${sum}, ${got} bytes), so it wasn't kept.`);
  }
  fs.renameSync(part, MODEL.file);
  say('Background-removal model fetched and checked.');
  return MODEL.file;
}

if (require.main === module) ensure().catch((e) => (console.error(e.message), process.exit(1)));
module.exports = { ensure, MODEL };
