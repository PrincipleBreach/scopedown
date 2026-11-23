// Evidence files attached to drafts. Bytes live in IndexedDB (survives service worker restarts
// and is not limited like storage.local); drafts keep only the metadata.

import { RunnerError } from './runner.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 10;
export const CHUNK_BYTES = 512 * 1024; // raw bytes per bridge message; base64 stays under 1 MB
const ALLOWED = /\.(png|jpe?g|gif|webp|mp4|mov|webm|txt|log|md|json|har|xml|html?|pdf|csv|zip)$/i;
const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', txt: 'text/plain', log: 'text/plain',
  md: 'text/markdown', json: 'application/json', har: 'application/json', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', pdf: 'application/pdf', csv: 'text/csv', zip: 'application/zip',
};

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('scopedown', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('files', mode);
    const out = fn(t.objectStore('files'));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export const saveFile = (file) => tx('readwrite', (s) => s.put(file));
export const loadFile = (id) => tx('readonly', (s) => s.get(id));
export const deleteFile = (id) => tx('readwrite', (s) => s.delete(id));

export function checkName(name) {
  const clean = String(name || '').split(/[\\/]/).pop().replace(/[^\w.@+-]+/g, '_').slice(0, 120);
  if (!clean || !ALLOWED.test(clean)) {
    throw new RunnerError('bad_file', `${name} is not an allowed evidence type. Use images, video, text, logs, HAR, JSON, PDF, CSV or ZIP.`);
  }
  return clean;
}

export function typeFor(name) {
  return TYPES[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Uploads in progress, by id. Chunks stay in memory: if the worker restarts mid-upload the
// MCP server sends the file again.
const uploads = new Map();

export function beginUpload({ draftId, name, size, sha }) {
  const clean = checkName(name);
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) throw new RunnerError('bad_file', `Files must be 1 byte to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  if (!/^[a-f0-9]{64}$/.test(String(sha))) throw new RunnerError('bad_request', 'sha256 must be the file\'s hex SHA-256.');
  const id = `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  uploads.set(id, { draftId, name: clean, size, sha, parts: [], received: 0, at: Date.now() });
  for (const [k, u] of uploads) if (Date.now() - u.at > 10 * 60_000) uploads.delete(k);
  return { upload_id: id, chunk_bytes: CHUNK_BYTES };
}

export function addChunk({ uploadId, index, data }) {
  const u = uploads.get(uploadId);
  if (!u) throw new RunnerError('upload_expired', 'Upload not found or expired. Send the file again.');
  if (index !== u.parts.length) throw new RunnerError('bad_request', `Expected chunk ${u.parts.length}, got ${index}.`);
  const bytes = fromBase64(String(data));
  if (bytes.length > CHUNK_BYTES || u.received + bytes.length > u.size) throw new RunnerError('bad_request', 'Chunk is larger than announced.');
  u.parts.push(bytes);
  u.received += bytes.length;
  u.at = Date.now();
  return { received: u.received };
}

// Verifies the whole file and stores it. Returns the stored file's metadata.
export async function finishUpload({ uploadId, by }) {
  const u = uploads.get(uploadId);
  if (!u) throw new RunnerError('upload_expired', 'Upload not found or expired. Send the file again.');
  uploads.delete(uploadId);
  const bytes = new Uint8Array(u.received);
  let at = 0;
  for (const p of u.parts) { bytes.set(p, at); at += p.length; }
  if (bytes.length !== u.size) throw new RunnerError('bad_file', `Received ${bytes.length} of ${u.size} bytes.`);
  if ((await sha256(bytes)) !== u.sha) throw new RunnerError('bad_file', 'The file arrived damaged (SHA-256 mismatch). Send it again.');
  const meta = { id: `f_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, name: u.name, type: typeFor(u.name), size: u.size, sha256: u.sha, added_by: by, added_at: new Date().toISOString() };
  await saveFile({ ...meta, draftId: u.draftId, bytes });
  return { meta, draftId: u.draftId };
}
