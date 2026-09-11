(() => {
  const statusEl = document.getElementById('status');
  const setupEl = document.getElementById('setup');
  const pinEl = document.getElementById('pin');
  const startBtn = document.getElementById('startBtn');
  const previewCanvas = document.getElementById('preview');
  const sourceVideo = document.getElementById('sourceVideo');
  const statsEl = document.getElementById('stats');
  const previewCtx = previewCanvas.getContext('2d');

  const PIN_KEY = 'remoteCamera.pin';
  function getSavedPin() {
    try {
      return localStorage.getItem(PIN_KEY) || '';
    } catch {
      return '';
    }
  }
  function savePin(pin) {
    try {
      localStorage.setItem(PIN_KEY, pin);
    } catch {
      // ignore (e.g. private browsing)
    }
  }
  function clearSavedPin() {
    try {
      localStorage.removeItem(PIN_KEY);
    } catch {
      // ignore
    }
  }

  const params = new URLSearchParams(location.search);
  pinEl.value = params.get('pin') || getSavedPin();

  let ws = null;
  let pc = null;
  let dataChannel = null;
  let localStream = null;
  let outputStream = null;
  let outputTrack = null;
  let currentFacingMode = 'environment';
  let wakeLock = null;
  let pendingCandidates = [];
  let peerReady = false;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let intentionalClose = false;
  let rotation = 0; // degrees: 0, 90, 180, 270 — applied by redrawing each frame

  // The camera's raw frames are drawn onto previewCanvas (rotated), and THAT
  // canvas is what gets streamed out and what photos are captured from — not
  // the raw track. This is what makes rotation apply consistently everywhere
  // (live view, photos, recordings) instead of just fixing what you see.
  //
  // Driven by setInterval rather than requestVideoFrameCallback/rAF: both of
  // those are tied to the compositor actually painting, and can stall when
  // nothing is actively driving paint — setInterval keeps running regardless.
  function drawFrame() {
    const w = sourceVideo.videoWidth;
    const h = sourceVideo.videoHeight;
    if (!w || !h) return;
    const swapped = rotation % 180 !== 0;
    const canvasW = swapped ? h : w;
    const canvasH = swapped ? w : h;
    if (previewCanvas.width !== canvasW || previewCanvas.height !== canvasH) {
      previewCanvas.width = canvasW;
      previewCanvas.height = canvasH;
    }
    previewCtx.save();
    previewCtx.translate(canvasW / 2, canvasH / 2);
    previewCtx.rotate((rotation * Math.PI) / 180);
    previewCtx.drawImage(sourceVideo, -w / 2, -h / 2, w, h);
    previewCtx.restore();
  }

  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (err) {
      console.warn('Wake lock failed:', err);
    }
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && localStream) {
      await requestWakeLock();
    }
  });

  function connectSignaling() {
    const pin = pinEl.value.trim();
    if (!pin) {
      alert('Enter the PIN shown in the server console.');
      return;
    }
    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${wsProtocol}://${location.host}/ws?role=camera&pin=${encodeURIComponent(pin)}`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      savePin(pin);
      setStatus('waiting for controller…', '');
    });

    ws.addEventListener('message', async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'error') {
        intentionalClose = true;
        if (msg.message === 'Invalid PIN') clearSavedPin();
        setStatus(msg.message, 'error');
        return;
      }
      if (msg.type === 'peer-joined') {
        peerReady = true;
        setStatus('controller connected — negotiating…', '');
        await startPeerConnection();
      } else if (msg.type === 'peer-left') {
        peerReady = false;
        setStatus('controller disconnected', '');
        if (pc) {
          pc.close();
          pc = null;
        }
      } else if (msg.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        pendingCandidates = [];
      } else if (msg.type === 'ice-candidate') {
        const candidate = new RTCIceCandidate(msg.candidate);
        if (pc && pc.remoteDescription) await pc.addIceCandidate(candidate);
        else pendingCandidates.push(candidate);
      }
    });

    ws.addEventListener('close', () => {
      peerReady = false;
      if (intentionalClose) return;
      setStatus(`disconnected — retrying in ${Math.round(reconnectDelay / 1000)}s…`, 'error');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectSignaling, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    });
    ws.addEventListener('error', () => setStatus('connection error', 'error'));
  }

  function send(msg) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  async function startPeerConnection() {
    if (!localStream || !peerReady) return;
    if (pc) pc.close();

    pc = new RTCPeerConnection(rtcConfig);
    pc.addTrack(outputTrack, outputStream);

    dataChannel = pc.createDataChannel('control');
    setupDataChannel(dataChannel);

    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: 'ice-candidate', candidate: event.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setStatus('streaming', 'connected');
      else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        setStatus(pc.connectionState, 'error');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'offer', sdp: offer });
  }

  function setupDataChannel(dc) {
    dc.addEventListener('open', () => {
      sendCapabilities();
      dc.send(JSON.stringify({ type: 'rotation-changed', degrees: rotation }));
    });
    dc.addEventListener('message', async (event) => {
      let cmd;
      try {
        cmd = JSON.parse(event.data);
      } catch {
        return;
      }
      handleCommand(cmd);
    });
  }

  async function handleCommand(cmd) {
    const track = localStream && localStream.getVideoTracks()[0];
    if (!track) return;

    switch (cmd.type) {
      case 'zoom': {
        try {
          await track.applyConstraints({ advanced: [{ zoom: cmd.value }] });
        } catch (err) {
          console.warn('zoom not supported', err);
        }
        break;
      }
      case 'torch': {
        try {
          await track.applyConstraints({ advanced: [{ torch: cmd.value }] });
        } catch (err) {
          console.warn('torch not supported', err);
        }
        break;
      }
      case 'switch-camera': {
        await switchCamera();
        break;
      }
      case 'rotate': {
        rotation = (rotation + 90) % 360;
        if (dataChannel.readyState === 'open') {
          dataChannel.send(JSON.stringify({ type: 'rotation-changed', degrees: rotation }));
        }
        break;
      }
      case 'focus': {
        try {
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          const advanced = { pointsOfInterest: [{ x: cmd.x, y: cmd.y }] };
          if (caps.focusMode && caps.focusMode.includes('single-shot')) {
            advanced.focusMode = 'single-shot';
          }
          await track.applyConstraints({ advanced: [advanced] });
          dataChannel.send(JSON.stringify({ type: 'focus-result', ok: true }));
        } catch (err) {
          console.warn('tap-to-focus not supported', err);
          dataChannel.send(JSON.stringify({ type: 'focus-result', ok: false, error: String(err && err.message || err) }));
        }
        break;
      }
      case 'photo': {
        await capturePhoto();
        break;
      }
      case 'get-capabilities': {
        sendCapabilities();
        break;
      }
    }
  }

  function sendCapabilities() {
    const track = localStream && localStream.getVideoTracks()[0];
    if (!track || !dataChannel || dataChannel.readyState !== 'open') return;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    dataChannel.send(JSON.stringify({ type: 'capabilities', caps }));
  }

  async function switchCamera() {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });

    // No need to touch the peer connection: it streams previewCanvas's own
    // track, which keeps flowing untouched — the draw loop just starts
    // reading from whatever sourceVideo shows next.
    localStream.getVideoTracks().forEach((t) => t.stop());
    localStream = newStream;
    sourceVideo.srcObject = localStream;
    sendCapabilities();
  }

  async function capturePhoto() {
    // previewCanvas is the exact rotated frame being streamed right now (see
    // drawFrame above), so snapshotting it directly guarantees the photo
    // matches the live view — zoom, rotation, and all — with no separate
    // capture pipeline to fall out of sync with.
    const blob = await new Promise((resolve) => previewCanvas.toBlob(resolve, 'image/jpeg', 0.95));
    await sendPhoto(blob);
  }

  const BUFFERED_AMOUNT_LOW = 256 * 1024;

  function waitForBufferDrain() {
    if (dataChannel.bufferedAmount <= BUFFERED_AMOUNT_LOW) return Promise.resolve();
    return new Promise((resolve) => {
      dataChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;
      dataChannel.addEventListener('bufferedamountlow', resolve, { once: true });
    });
  }

  async function sendPhoto(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    const CHUNK = 12000;
    dataChannel.send(JSON.stringify({ type: 'photo-start', mime: blob.type, size: base64.length }));
    for (let i = 0; i < base64.length; i += CHUNK) {
      await waitForBufferDrain();
      dataChannel.send(JSON.stringify({ type: 'photo-chunk', data: base64.slice(i, i + CHUNK) }));
    }
    dataChannel.send(JSON.stringify({ type: 'photo-end' }));
  }

  function updateStats() {
    if (!localStream) {
      statsEl.textContent = '';
      return;
    }
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    const settings = track.getSettings ? track.getSettings() : {};
    statsEl.textContent = `${settings.width || '?'}×${settings.height || '?'} · ${
      settings.frameRate ? Math.round(settings.frameRate) + 'fps' : ''
    } · ${currentFacingMode} · ${rotation}°`;
  }
  setInterval(updateStats, 1000);

  async function startCamera() {
    startBtn.disabled = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      sourceVideo.srcObject = localStream;
      await sourceVideo.play().catch(() => {});

      setInterval(drawFrame, 33); // ~30fps
      outputStream = previewCanvas.captureStream(30);
      outputTrack = outputStream.getVideoTracks()[0];

      await requestWakeLock();
      setupEl.style.display = 'none';
      connectSignaling();
    } catch (err) {
      alert('Could not access camera: ' + err.message);
      startBtn.disabled = false;
    }
  }

  startBtn.addEventListener('click', startCamera);

  // Hands-off recovery: if the browser already granted camera permission and
  // we already know the PIN (from the URL or a previous session), skip the
  // manual tap and start streaming as soon as the page loads — useful after
  // the phone reboots or the tab gets reloaded while it's sitting on a stand.
  (async () => {
    if (!pinEl.value.trim()) return;
    try {
      const status = await navigator.permissions.query({ name: 'camera' });
      if (status.state === 'granted') await startCamera();
    } catch {
      // Permissions API for 'camera' isn't supported everywhere — fall back
      // to the manual button, which is always safe.
    }
  })();
})();
