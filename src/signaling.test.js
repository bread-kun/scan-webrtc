import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { pack, createCollector } from './signaling.js';

test('generated QR images can be decoded by jsQR and restored to SDP', () => {
  const description = {
    type: 'offer',
    sdp:
      'v=0\r\n' +
      Array.from({ length: 60 }, () => crypto.randomUUID()).join('\r\n'),
  };
  const collect = createCollector();
  let result;
  for (const frame of pack(description).frames) {
    const { modules } = QRCode.create(frame, { errorCorrectionLevel: 'M' });
    const scale = 5,
      margin = 4,
      size = (modules.size + margin * 2) * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        if (!modules.get(y, x)) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const offset =
              (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) *
              4;
            pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
          }
        }
      }
    }
    const decoded = jsQR(pixels, size, size);
    assert.equal(decoded?.data, frame);
    result = collect(decoded.data);
  }
  assert.deepEqual(result.description, description);
});

test('SDP round trips without losing ICE candidates or line endings', () => {
  const description = {
    type: 'offer',
    sdp: 'v=0\r\na=candidate:123 1 udp 123 192.168.1.2 12345 typ host\r\n',
  };
  const bundle = pack(description);
  const collect = createCollector();
  let result;
  for (const frame of bundle.frames) result = collect(frame);
  assert.deepEqual(result.description, description);
});
test('large payload supports out-of-order and duplicate frames', () => {
  const description = {
    type: 'answer',
    sdp:
      'v=0\r\n' +
      Array.from({ length: 200 }, () => crypto.randomUUID()).join('\r\n'),
  };
  const { frames } = pack(description);
  assert.ok(frames.length > 1);
  const collect = createCollector();
  collect(frames.at(-1));
  collect(frames.at(-1));
  let result;
  for (const frame of frames.toReversed()) result = collect(frame);
  assert.deepEqual(result.description, description);
});
test('rejects unrelated codes, oversized frames, and mixed exchanges', () => {
  assert.throws(() => createCollector()('https://example.com'));
  assert.throws(() => createCollector()('WRTC1:id:0:999:AAAA'));
  const collect = createCollector();
  collect('WRTC1:one:0:2:AAAA');
  assert.throws(() => collect('WRTC1:two:1:2:AAAA'));
});
