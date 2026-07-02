// Derives the pinned Chrome extension ID from the extension manifest's `key` (the single source of
// truth), so the installer and test never carry a duplicated ID that could drift. The algorithm:
// SHA-256 the DER SubjectPublicKeyInfo (which the base64 `key` already is), take the first 16
// bytes, and map each hex nibble 0-f to a-p.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(__dirname, '..', 'chrome-extension', 'manifest.json');

export function extensionId() {
  const key = JSON.parse(readFileSync(MANIFEST, 'utf8')).key;
  const der = Buffer.from(key, 'base64');
  const hash = crypto.createHash('sha256').update(der).digest();
  return [...hash.subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
    .split('')
    .map((h) => String.fromCharCode('a'.charCodeAt(0) + parseInt(h, 16)))
    .join('');
}

// `node ext-id.mjs` prints the id (handy for manual installs / debugging).
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(extensionId());
}
