# Remote Camera

Turn a phone with a working camera but broken touchscreen into a
remote-controllable webcam, using nothing but Chrome and a tiny signaling
server — no native app.

## How it works

- `camera.html` runs on the broken-screen phone. It grabs the camera with
  `getUserMedia()` and streams it out over WebRTC.
- `control.html` runs on your PC (or another phone) and shows the live feed,
  with buttons for zoom, torch, front/rear switch, photo capture, and local
  recording.
- `server.js` is a small Node process that does two things: serves the two
  HTML pages, and relays WebRTC signaling (offer/answer/ICE) between the pair
  over a WebSocket. Once the connection is established, video flows directly
  phone → PC; only the initial handshake and control commands (zoom/torch/
  photo requests) go through the server.
- Control commands travel over a WebRTC `RTCDataChannel`, not the server —
  the server never sees your video or your commands after pairing.

## Requirements

- Both devices on the same local network (WiFi).
- The camera phone must stay unlocked with Chrome open and in the foreground
  — a browser tab cannot use the camera in the background or while the
  screen is locked. A screen wake lock is requested automatically so the
  screen won't sleep while the tab is visible.
- HTTPS is required for camera access on a real device (not `localhost`), so
  the server uses a self-signed certificate. You'll need to click through a
  security warning the first time each device visits it.

## Setup

```bash
npm install
npm start
```

The server prints a PIN and the URLs to use, e.g.:

```
On the broken-screen phone (camera):
  https://192.168.50.10:8443/camera.html?pin=712bef

On the controller (PC / other phone):
  https://192.168.50.10:8443/control.html?pin=712bef
```

1. On the **broken-screen phone**, open the camera URL (use a mouse via
   OTG/Bluetooth, or however you're currently navigating it), accept the
   certificate warning, tap **Start Camera**, and grant camera permission.
2. On the **controller**, open the control URL, accept the certificate
   warning, and tap **Connect**.
3. The live feed should appear within a couple of seconds.

If both devices are the *same* machine (e.g. testing camera + control in two
tabs on your PC), you can instead use the plain HTTP port printed in the
console (`http://localhost:8081/...`) — no certificate warning needed, since
Chrome treats `localhost` as secure. This only works for `localhost`, not for
a real phone reaching over the LAN.

## Controls

- **Take Photo** — snapshots the exact frame currently being streamed
  (post-rotation, post-zoom) and sends it back over the data channel; it
  appears as a downloadable thumbnail.
- **Record** — records the *received* video stream locally in the browser via
  `MediaRecorder`, writing straight to a file you pick (via the File System
  Access API) so a crash mid-recording loses at most ~1s, not the whole clip.
  Falls back to download-on-stop on browsers without that API.
- **Rotate** — cycles the camera phone's own output 0°/90°/180°/270°. Applied
  on the camera side (frames are redrawn through a canvas before being sent),
  so it's consistent across the live view, photos, and recordings — not just
  a cosmetic flip on the controller.
- **Tap-to-focus** — click/tap the live video to send a focus point to the
  camera. Shows a status message if the phone rejects it as unsupported.
- **Torch** / **Switch Camera** / **Zoom** — applied via
  `MediaStreamTrack.applyConstraints()`; support depends on the phone and
  Chrome version. If a control has no effect, that capability likely isn't
  exposed on your device.

## Using it outside (phone hotspot, no IP typing)

At home the server runs on your PC and everyone's on the same WiFi. Outside,
there's no shared WiFi — but you can get the exact same "just open the page"
experience by running the server on your *other* (normal-screen) Android
phone and having it host the hotspot too:

1. **Install [Termux](https://f-droid.org/packages/com.termux/)** on your
   normal phone (get it from F-Droid or Termux's GitHub releases — the Play
   Store version is outdated and unsupported). This is the only thing that
   needs installing, and it's on the phone you *can* install things on.
2. **In Termux**, install Node and get the project onto the phone:
   ```bash
   pkg update && pkg install nodejs git
   git clone <your-repo-url> remote-camera-project
   cd remote-camera-project
   npm install --no-optional
   ```
   (If you haven't pushed this project anywhere yet, push it to a private
   GitHub repo from your PC first — simplest way to get it onto the phone.
   `adb push` over USB is a fine alternative if you'd rather skip git.)
3. **The certificate needs no changes** — the one already in this repo covers
   the hotspot IP used below, so the same `certs/` folder you clone works
   as-is on the phone.
4. **Every time you're heading out:**
   - Turn on your normal phone's **Hotspot** (Settings → Network & internet →
     Hotspot & tethering). Android's hotspot feature gives itself the fixed
     address `192.168.43.1` essentially always, regardless of what IP the
     connecting phone gets — that fixed address is what makes this work
     without ever typing an IP.
   - In Termux: `termux-wake-lock && npm start` (the wake lock stops Android
     from throttling Termux's CPU while the screen is off or you switch to
     another app).
   - Connect the **broken phone's** WiFi to your normal phone's hotspot.

5. **One-time setup on the broken phone** (do this once, e.g. at home first by
   turning the hotspot on there too): open
   `https://192.168.43.1:8443/camera.html`, accept the certificate warning,
   enter the PIN once, tap Start Camera, and grant camera permission. Then in
   Chrome's menu, **"Add to Home screen"** for that page — this creates an
   icon that reopens straight to that exact URL, with no app install.

   From then on, tapping that home-screen icon does everything automatically:
   both pages remember their PIN and auto-connect on load, and `camera.html`
   specifically auto-starts the camera with no tap at all once permission has
   been granted once — the same hands-off recovery that helps after a phone
   reboot at home also covers "outside, no home WiFi" with a single tap.

Why no typing is needed, mechanically: the PIN is remembered in the browser's
`localStorage` (cleared automatically if it's ever rejected) and now also
persisted on the *server* side to a `.pin` file, so restarting `npm start` in
Termux keeps handing out the same PIN — the home-screen shortcut never goes
stale. The IP never needs to be looked up because the hotspot's gateway
address is fixed. The only manual step every outing is starting the server in
Termux and turning the hotspot on, both on the phone you're already holding.

**A couple of things worth flagging honestly:**
- Android is often aggressive about killing backgrounded processes to save
  battery. `termux-wake-lock` helps, but if the server still gets killed
  after a while, go to Settings → Apps → Termux → Battery and set it to
  **Unrestricted**.
- The controller (viewing/controlling the stream) would also run in Chrome on
  this same normal phone in this setup — `https://192.168.43.1:8443/control.html`
  — since it's now also the server. Running Termux + the server + Chrome all
  on one phone is normal and should be fine performance-wise.
- If your phone's hotspot happens to use a different gateway IP than
  `192.168.43.1` (rare, but some OEM skins vary), check it once under the
  hotspot settings or your phone's WiFi IP config, and use that instead
  throughout.

## Known limitations

- **No background operation.** Chrome cannot hold the camera open once the
  tab is backgrounded or the phone locks. Plan on the camera phone sitting on
  a stand, plugged in, with the tab kept in the foreground.
- **LAN only, by default.** There's no TURN server configured, so this works
  on the same network out of the box. For access over the internet, you'd
  need to add a STUN/TURN server (e.g. coturn) and update `rtcConfig` in
  `public/camera.js` and `public/control.js`.
- **One camera, one controller at a time** (v1). The server only tracks a
  single pairing slot.
- **Not the stock camera app.** You get whatever Chrome's WebRTC/camera APIs
  expose — no manufacturer HDR/night-mode/RAW processing.

## Configuration

Environment variables (optional):

- `PORT` — plain HTTP port for localhost-only testing (default `8081`)
- `HTTPS_PORT` — HTTPS port for real LAN/phone use (default `8443`)
- `PIN` — fix the pairing PIN instead of using the persisted one

Without a `PIN` env var, the PIN is generated once and saved to a `.pin` file
next to `server.js`, then reused on every subsequent start — this is what
keeps a bookmarked/home-screen shortcut valid across server restarts. Delete
`.pin` (or set `PIN` explicitly) to force a new one.

## Regenerating the certificate

The current certificate already covers `localhost`, `127.0.0.1`, the home LAN
IP, and the Android hotspot gateway (`192.168.43.1`) — one cert works for all
of them. If your home LAN IP changes, or you need to add another address,
edit `certs/openssl.cnf` (add/update the `IP.*` lines under `[alt_names]`)
and regenerate:

```bash
cd certs
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -config openssl.cnf
```
