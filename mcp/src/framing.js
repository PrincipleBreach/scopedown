import { StringDecoder } from 'node:string_decoder';

// Wire formats.
// Native messaging (browser <-> host): each message is a 32-bit length in native byte order
// (little-endian on every platform browsers ship on) followed by UTF-8 JSON.
// Socket (host <-> MCP server): one JSON object per line.

export const MAX_TO_BROWSER = 1024 * 1024; // Chrome rejects host messages over 1 MB.

export function encodeNative(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_TO_BROWSER) throw new Error(`Message to the browser is ${body.length} bytes; the limit is 1 MB.`);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Feeds chunks in, calls onMessage for every complete native message.
export function nativeDecoder(onMessage, onError = () => {}) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (buffer.length < 4 + size) return;
      const body = buffer.subarray(4, 4 + size);
      buffer = buffer.subarray(4 + size);
      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch (e) {
        onError(e);
      }
    }
  };
}

export function encodeLine(message) {
  return `${JSON.stringify(message)}\n`;
}

// Feeds chunks in, calls onMessage for every complete JSON line. A read can end inside a
// multi-byte character, so the decoder carries those bytes over to the next chunk.
export function lineDecoder(onMessage, onError = () => {}) {
  const utf8 = new StringDecoder('utf8');
  let pending = '';
  return (chunk) => {
    pending += typeof chunk === 'string' ? chunk : utf8.write(chunk);
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (e) {
        onError(e);
      }
    }
  };
}
