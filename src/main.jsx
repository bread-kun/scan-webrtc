import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { pack, createCollector } from './signaling';
import './style.css';

function App() {
  const [status, setStatus] = useState('Ready to connect');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bundle, setBundle] = useState(null);
  const [frame, setFrame] = useState(0);
  const [qr, setQr] = useState('');
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');
  const [manual, setManual] = useState('');
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);
  const peer = useRef(null),
    channel = useRef(null),
    video = useRef(null);
  const collector = useRef(createCollector()),
    processing = useRef(false),
    generation = useRef(0);

  useEffect(() => {
    if (!bundle) {
      setQr('');
      return;
    }
    let active = true;
    QRCode.toDataURL(bundle.frames[frame], {
      width: 560,
      margin: 4,
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (active) setQr(url);
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [bundle, frame]);
  useEffect(() => {
    if (!bundle || bundle.frames.length < 2) return;
    const timer = setInterval(
      () => setFrame((i) => (i + 1) % bundle.frames.length),
      1600,
    );
    return () => clearInterval(timer);
  }, [bundle]);
  useEffect(
    () => () => {
      generation.current++;
      peer.current?.close();
    },
    [],
  );

  useEffect(() => {
    if (!scanning) return;
    let disposed = false,
      stream,
      timer;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error(
            'Camera requires HTTPS or localhost and a supported browser.',
          );
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
          },
          audio: false,
        });
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.current.srcObject = stream;
        await video.current.play();
        timer = setInterval(() => {
          const el = video.current;
          if (!el || el.readyState < 2 || processing.current) return;
          canvas.width = el.videoWidth;
          canvas.height = el.videoHeight;
          ctx.drawImage(el, 0, 0);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(pixels.data, pixels.width, pixels.height, {
            inversionAttempts: 'dontInvert',
          });
          if (code) void receive(code.data);
        }, 200);
      } catch (e) {
        if (!disposed) {
          setError(e.message);
          setScanning(false);
        }
      }
    }
    void start();
    return () => {
      disposed = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [scanning]);

  function bindChannel(dc) {
    channel.current = dc;
    dc.onopen = () => {
      setConnected(true);
      setStatus('Connected · peer to peer');
      setScanning(false);
    };
    dc.onclose = () => {
      setConnected(false);
      setStatus('Data channel closed');
    };
    dc.onerror = () => setError('Data channel error. Reset and try again.');
    dc.onmessage = (event) =>
      setMessages((all) => [
        ...all.slice(-99),
        { from: 'Peer', text: String(event.data) },
      ]);
  }
  function makePeer() {
    if (!window.RTCPeerConnection)
      throw new Error('WebRTC is not supported in this browser.');
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    peer.current = pc;
    pc.ondatachannel = (event) => bindChannel(event.channel);
    pc.onconnectionstatechange = () => {
      setStatus(`Connection: ${pc.connectionState}`);
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState))
        setConnected(false);
      if (pc.connectionState === 'failed')
        setError(
          'Connection failed. Try the same Wi-Fi network; some networks require a TURN relay.',
        );
    };
    return pc;
  }
  async function share(pc, description, token) {
    await pc.setLocalDescription(description);
    await new Promise((resolve, reject) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const finish = (err) => {
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', check);
        err ? reject(err) : resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      const timeout = setTimeout(
        () =>
          finish(new Error('ICE gathering timed out. Reset and try again.')),
        20000,
      );
      pc.addEventListener('icegatheringstatechange', check);
    });
    if (token !== generation.current) return;
    setBundle(pack(pc.localDescription));
    setFrame(0);
    setStatus(
      pc.localDescription.type === 'offer'
        ? 'Offer ready · let your peer scan'
        : 'Answer ready · let the initiator scan',
    );
  }
  async function createOffer() {
    setBusy(true);
    setError('');
    const token = generation.current;
    try {
      const pc = makePeer();
      bindChannel(pc.createDataChannel('handshake'));
      setStatus('Gathering connection details…');
      await share(pc, await pc.createOffer(), token);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function receive(text) {
    if (processing.current) return;
    processing.current = true;
    try {
      const result = collector.current(text);
      setProgress(`${result.received} / ${result.total} frames received`);
      if (!result.description) return;
      setScanning(false);
      setBusy(true);
      setError('');
      const token = generation.current;
      if (result.description.type === 'offer') {
        if (peer.current)
          throw new Error(
            'An exchange is already active. Reset to join another peer.',
          );
        const pc = makePeer();
        await pc.setRemoteDescription(result.description);
        setStatus('Preparing answer…');
        await share(pc, await pc.createAnswer(), token);
      } else {
        const pc = peer.current;
        if (!pc || pc.signalingState !== 'have-local-offer')
          throw new Error('Create an offer before scanning an answer.');
        await pc.setRemoteDescription(result.description);
        setStatus('Connecting to peer…');
      }
      collector.current = createCollector();
      setManual('');
    } catch (e) {
      setError(e.message);
    } finally {
      processing.current = false;
      setBusy(false);
    }
  }
  function reset() {
    generation.current++;
    setScanning(false);
    if (channel.current) {
      channel.current.onclose = null;
      channel.current.close();
    }
    if (peer.current) {
      peer.current.onconnectionstatechange = null;
      peer.current.close();
    }
    peer.current = null;
    channel.current = null;
    collector.current = createCollector();
    setBundle(null);
    setFrame(0);
    setConnected(false);
    setMessages([]);
    setProgress('');
    setManual('');
    setError('');
    setStatus('Ready to connect');
  }
  function send(event) {
    event.preventDefault();
    if (!message.trim()) return;
    try {
      if (channel.current?.readyState !== 'open')
        throw new Error('The data channel is not open.');
      channel.current.send(message);
      setMessages((all) => [...all.slice(-99), { from: 'You', text: message }]);
      setMessage('');
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <main>
      <header>
        <a className="brand" href=".">
          <span className="mark">⌁</span> handshake
          <span className="lab">WEBRTC LAB</span>
        </a>
        <span className="badge">SERVERLESS SIGNALING</span>
      </header>
      <section className="intro">
        <p className="eyebrow">TWO SCREENS. ONE CONNECTION.</p>
        <h1>
          A connection starts
          <br />
          with a <em>scan.</em>
        </h1>
        <p>
          Exchange QR codes, connect your browsers, and send a message directly.
          No signaling server needed.
        </p>
      </section>
      <div className="steps">
        <span>
          <b>01</b> Create an offer
        </span>
        <span>
          <b>02</b> Peer scans & answers
        </span>
        <span>
          <b>03</b> Scan the answer & connect
        </span>
      </div>
      <div className="toolbar">
        <span role="status">
          <i className={connected ? 'dot live' : 'dot'} />
          {status}
        </span>
        <button className="text-button" disabled={busy} onClick={reset}>
          Reset session ↺
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="workspace">
        <section className="card">
          <div className="card-title">
            <h2>Your connection code</h2>
            <span>01 / SHARE</span>
          </div>
          <p>Start here on one device. On the other, open the scanner.</p>
          <div className="qr-area">
            {qr ? (
              <img
                src={qr}
                alt={`SDP QR frame ${frame + 1} of ${bundle.frames.length}`}
              />
            ) : (
              <div className="placeholder">
                <span className="qr-icon">▦</span>
                <h3>Ready when you are</h3>
                <p>Your connection QR will appear here.</p>
              </div>
            )}
          </div>
          {bundle && (
            <div className="code-meta">
              <span>
                Frame {frame + 1} / {bundle.frames.length}
              </span>
              <span>
                {bundle.rawBytes.toLocaleString()} B →{' '}
                {bundle.compressedBytes.toLocaleString()} B
              </span>
            </div>
          )}
          <button
            className="primary"
            disabled={busy || !!peer.current}
            onClick={createOffer}
          >
            {busy ? 'Preparing connection…' : 'Create offer'} <span>↗</span>
          </button>
          <p className="hint">
            {bundle?.frames.length > 1
              ? 'Codes rotate automatically. Keep scanning until all frames arrive.'
              : 'SDP is compressed with DEFLATE before becoming a QR code.'}
          </p>
        </section>
        <section className="card">
          <div className="card-title">
            <h2>Scan your peer</h2>
            <span>02 / RECEIVE</span>
          </div>
          <p>Scan an offer to join, or an answer to finish connecting.</p>
          <div className="camera-area">
            {scanning ? (
              <>
                <video ref={video} muted playsInline />
                <div className="scan-guide" />
              </>
            ) : (
              <div className="placeholder">
                <span className="camera-icon">◎</span>
                <h3>Bring your peer into view</h3>
                <p>Camera access starts only when you scan.</p>
              </div>
            )}
          </div>
          <button
            className="secondary"
            disabled={busy || connected}
            onClick={() => {
              setError('');
              setScanning(!scanning);
            }}
          >
            {scanning ? 'Stop camera' : 'Open scanner'} <span>⌾</span>
          </button>
          <p className="hint" role="status">
            {progress ||
              'Uses your rear camera when available. HTTPS or localhost required.'}
          </p>
        </section>
      </div>
      <section className="card chat">
        <div className="card-title">
          <h2>Give the connection a test</h2>
          <span className={connected ? 'connected' : ''}>
            {connected ? '● CHANNEL OPEN' : '○ WAITING FOR PEER'}
          </span>
        </div>
        <div className="messages" aria-live="polite">
          {messages.length ? (
            messages.map((item, i) => (
              <p key={i}>
                <b>{item.from}</b>
                <span>{item.text}</span>
              </p>
            ))
          ) : (
            <p className="empty">
              Once connected, send a hello. It travels directly to the other
              browser.
            </p>
          )}
        </div>
        <form onSubmit={send}>
          <input
            aria-label="Message to peer"
            placeholder="Say hello to the other side…"
            value={message}
            maxLength={4000}
            onChange={(e) => setMessage(e.target.value)}
            disabled={!connected}
          />
          <button className="primary" disabled={!connected || !message.trim()}>
            Send ↗
          </button>
        </form>
      </section>
      <details className="manual">
        <summary>Camera unavailable? Exchange codes manually</summary>
        <p>Copy all outgoing frames and paste them on the other device.</p>
        {bundle && (
          <textarea
            readOnly
            aria-label="Outgoing signaling frames"
            value={bundle.frames.join('\n')}
          />
        )}
        <textarea
          aria-label="Incoming signaling frames"
          placeholder="Paste your peer’s WRTC1 codes here…"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button
          disabled={busy || connected || !manual.trim()}
          className="secondary"
          onClick={async () => {
            for (const line of manual.trim().split(/\s+/)) await receive(line);
          }}
        >
          Import codes
        </button>
      </details>
      <footer>
        <span>Built for a little peer-to-peer exploration.</span>
        <span>React · jsQR · WebRTC</span>
      </footer>
      <p className="network-note">
        Best tested on the same Wi-Fi. A public STUN server helps discover
        addresses; restrictive networks may require TURN, which this demo does
        not configure.
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
