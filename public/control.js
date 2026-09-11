(() => {
  const statusEl = document.getElementById('status');
  const setupEl = document.getElementById('setup');
  const controlsEl = document.getElementById('controls');
  const capturesEl = document.getElementById('captures');
  const pinEl = document.getElementById('pin');
  const connectBtn = document.getElementById('connectBtn');
  const remote = document.getElementById('remote');
  const photoBtn = document.getElementById('photoBtn');
  const recordBtn = document.getElementById('recordBtn');
  const torchBtn = document.getElementById('torchBtn');
  const switchBtn = document.getElementById('switchBtn');
  const rotateBtn = document.getElementById('rotateBtn');
  const zoomRow = document.getElementById('zoomRow');
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomValue = document.getElementById('zoomValue');
  const statsEl = document.getElementById('stats');
  const thumbs = document.getElementById('thumbs');
  const tapToPlay = document.getElementById('tapToPlay');
  const videoWrap = document.querySelector('.video-wrap');
  const focusRing = document.getElementById('focusRing');

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
  let pendingCandidates = [];
  let torchOn = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let incomingPhoto = null;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let intentionalClose = false;

  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function send(msg) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function connectSignaling() {
    const pin = pinEl.value.trim();
    if (!pin) {
      alert('Enter the PIN shown in the server console.');
      return;
    }
    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${wsProtocol}://${location.host}/ws?role=control&pin=${encodeURIComponent(pin)}`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      savePin(pin);
      setStatus('waiting for camera…', '');
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
        setStatus('camera connected — waiting for stream…', '');
      } else if (msg.type === 'peer-left') {
        setStatus('camera disconnected', 'error');
        controlsEl.style.display = 'none';
        if (pc) {
          pc.close();
          pc = null;
        }
      } else if (msg.type === 'offer') {
        await handleOffer(msg.sdp);
      } else if (msg.type === 'ice-candidate') {
        const candidate = new RTCIceCandidate(msg.candidate);
        if (pc && pc.remoteDescription) await pc.addIceCandidate(candidate);
        else pendingCandidates.push(candidate);
      }
    });

    ws.addEventListener('close', () => {
      if (intentionalClose) return;
      setStatus(`disconnected — retrying in ${Math.round(reconnectDelay / 1000)}s…`, 'error');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectSignaling, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    });
    ws.addEventListener('error', () => setStatus('connection error', 'error'));
  }

  async function handleOffer(sdp) {
    if (pc) pc.close();
    pc = new RTCPeerConnection(rtcConfig);

    pc.ontrack = (event) => {
      remote.srcObject = event.streams[0];
      controlsEl.style.display = 'block';
      setStatus('streaming', 'connected');
      // Always let people try tapping to focus: some phones accept the
      // constraint without advertising pointsOfInterest in getCapabilities(),
      // so gating this on capability detection hid it even when it worked.
      videoWrap.classList.add('focusable');
      remote.play().catch(() => {
        // Autoplay was blocked (no user gesture on this page load yet).
        // The stream is attached and ready; it just needs one tap to start.
        tapToPlay.style.display = 'block';
      });
    };

    pc.ondatachannel = (event) => {
      dataChannel = event.channel;
      dataChannel.binaryType = 'arraybuffer';
      dataChannel.addEventListener('message', onDataChannelMessage);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: 'ice-candidate', candidate: event.candidate });
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    for (const c of pendingCandidates) await pc.addIceCandidate(c);
    pendingCandidates = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'answer', sdp: answer });
  }

  function onDataChannelMessage(event) {
    // Photo bytes arrive as raw binary messages (not base64-in-JSON, to avoid
    // both the size overhead and the CPU cost of encoding/decoding — see
    // camera.js's sendPhoto), interleaved with JSON control messages.
    if (event.data instanceof ArrayBuffer) {
      if (incomingPhoto) {
        incomingPhoto.chunks.push(event.data);
        incomingPhoto.received += event.data.byteLength;
        updatePhotoProgress();
      }
      return;
    }

    const msg = JSON.parse(event.data);
    if (msg.type === 'capabilities') {
      applyCapabilities(msg.caps || {});
    } else if (msg.type === 'rotation-changed') {
      rotateBtn.textContent = `⟳ Rotate (${msg.degrees}°)`;
    } else if (msg.type === 'focus-result') {
      if (!msg.ok) {
        console.warn('Camera rejected the focus point:', msg.error);
        setStatus(`focus not supported on this camera (${msg.error || 'unsupported'})`, 'error');
        setTimeout(() => setStatus('streaming', 'connected'), 2500);
      }
    } else if (msg.type === 'photo-start') {
      incomingPhoto = { mime: msg.mime || 'image/jpeg', size: msg.size || 0, received: 0, chunks: [] };
      photoBtn.disabled = true;
      updatePhotoProgress();
    } else if (msg.type === 'photo-end' && incomingPhoto) {
      const blob = new Blob(incomingPhoto.chunks, { type: incomingPhoto.mime });
      addThumb(blob);
      incomingPhoto = null;
      photoBtn.disabled = false;
      photoBtn.textContent = '📷 Take Photo';
    }
  }

  function updatePhotoProgress() {
    if (!incomingPhoto || !incomingPhoto.size) return;
    const pct = Math.min(100, Math.round((incomingPhoto.received / incomingPhoto.size) * 100));
    photoBtn.textContent = `📷 Receiving… ${pct}%`;
  }

  function applyCapabilities(caps) {
    if (caps.zoom && typeof caps.zoom.min === 'number') {
      zoomRow.style.display = 'flex';
      zoomSlider.min = caps.zoom.min;
      zoomSlider.max = caps.zoom.max;
      zoomSlider.step = caps.zoom.step || 0.1;
      zoomSlider.value = caps.zoom.min;
      zoomValue.textContent = Number(caps.zoom.min).toFixed(1) + '×';
    } else {
      zoomRow.style.display = 'none';
    }

    if (caps.torch) {
      torchBtn.style.display = '';
    } else {
      torchBtn.style.display = 'none';
      torchOn = false;
    }
  }

  function addThumb(blob) {
    const url = URL.createObjectURL(blob);
    capturesEl.style.display = 'block';
    const a = document.createElement('a');
    a.href = url;
    a.download = `photo-${Date.now()}.jpg`;
    const img = document.createElement('img');
    img.src = url;
    a.appendChild(img);
    thumbs.prepend(a);
  }

  function sendCommand(cmd) {
    if (dataChannel && dataChannel.readyState === 'open') dataChannel.send(JSON.stringify(cmd));
  }

  remote.addEventListener('click', (e) => {
    if (!videoWrap.classList.contains('focusable') || !remote.videoWidth) return;

    // The video is letterboxed (object-fit: contain) inside its box, so map
    // the click through the actual rendered video rect, not the element box.
    const rect = remote.getBoundingClientRect();
    const videoAspect = remote.videoWidth / remote.videoHeight;
    const boxAspect = rect.width / rect.height;
    let renderWidth = rect.width;
    let renderHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (videoAspect > boxAspect) {
      renderHeight = rect.width / videoAspect;
      offsetY = (rect.height - renderHeight) / 2;
    } else {
      renderWidth = rect.height * videoAspect;
      offsetX = (rect.width - renderWidth) / 2;
    }

    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const x = (px - offsetX) / renderWidth;
    const y = (py - offsetY) / renderHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return; // clicked the letterbox bars

    sendCommand({ type: 'focus', x, y });

    focusRing.style.left = `${px}px`;
    focusRing.style.top = `${py}px`;
    focusRing.hidden = false;
    focusRing.classList.remove('show');
    // Force reflow so the animation restarts on repeated clicks.
    void focusRing.offsetWidth;
    focusRing.classList.add('show');
    setTimeout(() => {
      focusRing.classList.remove('show');
    }, 500);
  });

  tapToPlay.addEventListener('click', () => {
    remote.play();
    tapToPlay.style.display = 'none';
  });

  connectBtn.addEventListener('click', () => {
    connectBtn.disabled = true;
    setupEl.style.display = 'none';
    connectSignaling();
  });

  photoBtn.addEventListener('click', () => sendCommand({ type: 'photo' }));

  torchBtn.addEventListener('click', () => {
    torchOn = !torchOn;
    torchBtn.classList.toggle('active', torchOn);
    sendCommand({ type: 'torch', value: torchOn });
  });

  switchBtn.addEventListener('click', () => sendCommand({ type: 'switch-camera' }));

  rotateBtn.addEventListener('click', () => sendCommand({ type: 'rotate' }));

  zoomSlider.addEventListener('input', () => {
    const v = parseFloat(zoomSlider.value);
    zoomValue.textContent = v.toFixed(1) + '×';
    sendCommand({ type: 'zoom', value: v });
  });

  let fileWritable = null;
  let writeQueue = Promise.resolve();

  recordBtn.addEventListener('click', async () => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      await startRecording();
    } else {
      mediaRecorder.stop();
      recordBtn.textContent = '⏺ Record';
      recordBtn.classList.remove('danger');
    }
  });

  async function startRecording() {
    recordedChunks = [];
    fileWritable = null;
    writeQueue = Promise.resolve();

    // Writing straight to a file on disk means a crash or dropped connection
    // mid-recording only loses the last ~1s (the timeslice below), instead of
    // the whole thing — the old approach buffered everything in memory and
    // only wrote it out on stop. Falls back to that in-memory approach on
    // browsers without the File System Access API (Firefox, mobile Chrome).
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: `recording-${Date.now()}.webm`,
          types: [{ description: 'WebM video', accept: { 'video/webm': ['.webm'] } }],
        });
        fileWritable = await handle.createWritable();
      } catch (err) {
        if (err.name === 'AbortError') return; // user cancelled the save dialog
        console.warn('showSaveFilePicker failed, falling back to in-memory recording', err);
      }
    }

    mediaRecorder = new MediaRecorder(remote.srcObject, { mimeType: 'video/webm' });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      if (fileWritable) {
        writeQueue = writeQueue.then(() => fileWritable.write(e.data)).catch((err) => console.error('recording write failed', err));
      } else {
        recordedChunks.push(e.data);
      }
    };
    mediaRecorder.onstop = async () => {
      if (fileWritable) {
        await writeQueue;
        await fileWritable.close();
        fileWritable = null;
      } else {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recording-${Date.now()}.webm`;
        a.click();
      }
    };
    mediaRecorder.start(1000);
    recordBtn.textContent = '⏹ Stop';
    recordBtn.classList.add('danger');
  }

  function updateStats() {
    if (!remote.srcObject) {
      statsEl.textContent = '';
      return;
    }
    const track = remote.srcObject.getVideoTracks()[0];
    if (!track) return;
    const settings = track.getSettings ? track.getSettings() : {};
    statsEl.textContent = `${settings.width || '?'}×${settings.height || '?'} · ${
      settings.frameRate ? Math.round(settings.frameRate) + 'fps' : ''
    }`;
  }
  setInterval(updateStats, 1000);

  // Connecting is just a WebSocket, no user gesture required — auto-connect
  // whenever the PIN is already known (URL or a remembered previous session)
  // so reopening this page just works.
  if (pinEl.value.trim()) {
    connectBtn.disabled = true;
    setupEl.style.display = 'none';
    connectSignaling();
  }
})();
