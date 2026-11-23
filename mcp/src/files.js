// Reads an evidence file an agent wants to attach. Platforms accept common evidence types up
// to a size limit; the hunter sees every attached file before anything is filed.

import { realpathSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED = /\.(png|jpe?g|gif|webp|mp4|mov|webm|txt|log|md|json|har|xml|html?|pdf|csv|zip)$/i;

export class FileRefused extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_file';
  }
}

export function readEvidence(path) {
  let real;
  try {
    real = realpathSync(String(path));
  } catch {
    throw new FileRefused(`${path} does not exist.`);
  }
  const st = statSync(real);
  if (!st.isFile()) throw new FileRefused(`${path} is not a regular file.`);
  const name = basename(real);
  if (!ALLOWED.test(name)) throw new FileRefused(`${name} is not an allowed evidence type. Use images, video, text, logs, HAR, JSON, PDF, CSV or ZIP.`);
  if (st.size === 0 || st.size > MAX_FILE_BYTES) throw new FileRefused(`${name} is ${st.size} bytes; files must be 1 byte to 20 MB.`);
  const bytes = readFileSync(real);
  return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}
