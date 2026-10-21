# Handshake — WebRTC QR lab

A React + Vite demo that exchanges WebRTC SDP through camera-scanned QR codes, then opens a reliable data channel for text messages. No signaling backend is needed. The surrounding workspace already has Git initialized; this app uses that repository.

## Run

Requires Node.js 22+ and pnpm 10.

```sh
pnpm install
pnpm dev
```

Open the localhost URL printed by Vite. For two physical devices, serve the production build from an HTTPS host that both devices can access. Plain HTTP on a LAN IP does **not** permit camera access in most browsers. Use a trusted HTTPS certificate; this project does not generate one.

```sh
pnpm build
pnpm preview
pnpm test
pnpm format
pnpm format:check
```

## Connect two browsers

1. On device A, select **Create offer** and wait for ICE gathering to finish.
2. On device B, select **Open scanner** and scan A's QR. For multiple frames, keep the camera aimed until all frames arrive.
3. B automatically creates an answer QR. On A, open the scanner and scan B's answer.
4. Once the channel opens, send messages in either direction.
5. Select **Reset session** on both devices to start a fresh exchange.

You can also expand the manual exchange section, copy all outgoing frame lines, and import them into the other browser. This is useful for two tabs or devices without cameras.

## Implementation

- `jsQR` decodes camera frames locally. Camera tracks stop when scanning stops, signaling is received, or the app unmounts.
- `fflate` uses DEFLATE level 9 to compress the full SDP, preserving ICE candidates and fingerprints. Base64 encodes the compressed bytes. No claim is made that DEFLATE always beats LZMA; it is small, fast, and adequate for this demo.
- Payloads split into 700-character chunks with version, exchange ID, index, and count. QR frames rotate every 1.6 seconds. The receiver tolerates duplicates and out-of-order frames and rejects mixed exchanges.
- Complete ICE gathering precedes QR generation because this demo does not trickle candidates through a server.
- Google public STUN helps discover addresses. There is no TURN relay configured, so some NAT/firewall combinations cannot connect. Try the same Wi-Fi network first.
- Camera frames and messages are not uploaded to an application server. STUN contacts an external service; Google Fonts supplies the optional UI fonts. SDP contains network metadata, so exchange it only with the intended peer.
- This is a data-channel test, not an audio/video call. Camera access is for scanning only.

Unit tests cover compressed SDP round trips, multi-frame collection, duplicate frames, and invalid exchanges. Real camera scanning and cross-network connectivity require a two-device check.
