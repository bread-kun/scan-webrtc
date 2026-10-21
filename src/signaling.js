import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';

const CHUNK = 700;
const MAX_PARTS = 96;
export function pack(description, id = crypto.randomUUID()) {
  const raw = JSON.stringify({ type: description.type, sdp: description.sdp });
  const bytes = deflateSync(strToU8(raw), { level: 9 });
  const encoded = btoa(String.fromCharCode(...bytes));
  const total = Math.ceil(encoded.length / CHUNK);
  if (total > MAX_PARTS) throw new Error('SDP exceeds the supported QR size.');
  return {
    rawBytes: strToU8(raw).length,
    compressedBytes: bytes.length,
    frames: Array.from(
      { length: total },
      (_, i) =>
        `WRTC1:${id}:${i}:${total}:${encoded.slice(i * CHUNK, (i + 1) * CHUNK)}`,
    ),
  };
}

export function createCollector() {
  let session;
  let parts = new Map();
  return (text) => {
    const match = /^WRTC1:([\w-]{1,64}):(\d+):(\d+):([A-Za-z0-9+/=]+)$/.exec(
      text.trim(),
    );
    if (!match) throw new Error('This is not a Handshake signaling QR code.');
    const [, id, indexText, totalText, data] = match;
    const index = Number(indexText),
      total = Number(totalText);
    if (!total || total > MAX_PARTS || index >= total || data.length > CHUNK)
      throw new Error('Invalid QR frame.');
    if (session && (session.id !== id || session.total !== total))
      throw new Error(
        'Different exchange detected. Reset before scanning another exchange.',
      );
    session = { id, total };
    parts.set(index, data);
    if (parts.size < total) return { received: parts.size, total };
    const encoded = Array.from({ length: total }, (_, i) => parts.get(i)).join(
      '',
    );
    const compressed = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    // A bounded output buffer prevents a scanned payload allocating arbitrary memory.
    const decoded = inflateSync(compressed, {
      out: new Uint8Array(128 * 1024),
    });
    const description = JSON.parse(strFromU8(decoded));
    if (
      !['offer', 'answer'].includes(description.type) ||
      typeof description.sdp !== 'string' ||
      !description.sdp.startsWith('v=0')
    )
      throw new Error('Invalid SDP description.');
    return { received: total, total, description };
  };
}
