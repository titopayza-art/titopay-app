// Decodes every matrix produced by qr_check.php --json with jsQR and checks exact byte equality.
// Usage: node php/tests/qr_check.js
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const jsQR = require(path.join(__dirname, '../../public/assets/jsQR.min.js'));
const decode = typeof jsQR === 'function' ? jsQR : jsQR.default;

const json = execFileSync('php', [path.join(__dirname, 'qr_check.php'), '--json'], { maxBuffer: 1 << 28 });
const cases = JSON.parse(json);
const SCALE = 6, QUIET = 4;
let pass = 0, fail = 0;
const versions = {};
for (const c of cases) {
  const n = c.matrix.length;
  const w = (n + 2 * QUIET) * SCALE;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (c.matrix[y][x] !== '1') continue;
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
      const i = (((y + QUIET) * SCALE + dy) * w + (x + QUIET) * SCALE + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  const expected = Buffer.from(c.data_b64, 'base64');
  const r = decode(px, w, w, { inversionAttempts: 'dontInvert' });
  const v = (n - 17) / 4;
  const ok = r && Buffer.from(r.binaryData).equals(expected) && r.version === v
    && (!isUtf8(expected) || r.data === expected.toString('utf8'));
  if (ok) { pass++; versions[v] = (versions[v] || 0) + 1; }
  else { fail++; console.log('FAIL', c.ecc, 'v' + v, JSON.stringify(expected.toString('utf8')).slice(0, 80), r ? JSON.stringify(r.data).slice(0, 80) : 'no decode'); }
}
function isUtf8(b) { try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; } }
console.log(`jsQR decode: ${pass} passed, ${fail} failed (versions covered: ${Object.keys(versions).sort((a, b) => a - b).join(',')})`);
process.exit(fail ? 1 : 0);
