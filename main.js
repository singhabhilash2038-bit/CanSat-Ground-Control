/**
 * main.js — CanSat GCS Orchestration & Event Hub
 * Central bootstrap and event routing for the Ground Control Software.
 * Initializes all subsystems, wires UI actions to backend handlers,
 * and manages the application-level state machine.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   APPLICATION STATE MATRIX
═══════════════════════════════════════════════════════════ */
const AppState = {
  isConnected:      false,
  isStreaming:      false,
  missionStartedAt: null,
  sessionId:        null,
  totalPackets:     0,
  goodPackets:      0,
  parseErrors:      0,
  checksumFails:    0,
  cameraStream:     null,   // MediaStream for camera
  cameraActive:     false,
};

// Global variable for camera stream (Architectural Requirement #3)
let globalCameraStream = null;

/* ═══════════════════════════════════════════════════════════
   BOOTSTRAP
═══════════════════════════════════════════════════════════ */
window.addEventListener('load', () => {
  _bootstrap();
});

async function _bootstrap() {
  // ── 1. Initialize UI (must come first — other modules call UI.logConsole) ──
  UI.init();

  // ── 2. Initialize Charts ──
  Charts.init();
  UI.logConsole('Charts initialized.', 'ok');

  // ── 3. Initialize Map ──
  MapModule.init();
  UI.logConsole('Leaflet map initialized.', 'ok');

  // ── 4. Initialize 3D Attitude Viewer ──
  AttitudeViewer.init();
  UI.logConsole('3D attitude viewer initialized.', 'ok');

  // ── 5. Wire all event handlers ──
  _wireEventHandlers();
  _wireCommandButtons();

  // ── 6. Generate a session ID ──
  AppState.sessionId = _generateSessionId();
  UI.logConsole(`Session ID: ${AppState.sessionId}`, 'info');

  // ── 7. Check browser capabilities ──
  _checkCapabilities();

  // ── 8. Demo data injection (helps verify rendering on first load) ──
  _injectDemoData();

  // ── 9. Force a layout recalculation for visualizers ──
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 500);

  UI.logConsole('CanSat GCS ready. Awaiting serial connection.', 'ok');
}

/* ═══════════════════════════════════════════════════════════
   CAPABILITY CHECKS
═══════════════════════════════════════════════════════════ */
function _checkCapabilities() {
  if (!SerialDriver.isSupported()) {
    UI.logConsole(
      'WARNING: Web Serial API not supported. Please use Chrome or Edge v89+.',
      'error'
    );
  } else {
    UI.logConsole('Web Serial API: supported.', 'ok');
  }

  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)) {
    UI.logConsole('Camera API not available in this browser.', 'warn');
  }

  if (typeof Chart === 'undefined') {
    UI.logConsole('ERROR: Chart.js not loaded.', 'error');
  }

  if (typeof L === 'undefined') {
    UI.logConsole('ERROR: Leaflet.js not loaded.', 'error');
  }

  if (typeof THREE === 'undefined') {
    UI.logConsole('ERROR: Three.js not loaded.', 'error');
  }
}

/* ═══════════════════════════════════════════════════════════
   EVENT HANDLER WIRING
═══════════════════════════════════════════════════════════ */
function _wireEventHandlers() {
  const el = UI.getElements();

  // ── Serial Connect ──
  el.btnConnect.addEventListener('click', async () => {
    const baud = parseInt(el.baudRateSelect.value, 10);
    UI.logConsole(`Requesting serial port at ${baud} baud...`, 'info');

    const ok = await SerialDriver.connect(
      baud,
      _onSerialLine,       // called for every complete line
      _onSerialDisconnect  // called on unexpected disconnect
    );

    if (ok) {
      AppState.isConnected = true;
      AppState.isStreaming  = true;
      UI.setSerialConnected(baud);
    }
  });

  // ── Serial Disconnect ──
  el.btnDisconnect.addEventListener('click', async () => {
    UI.logConsole('Disconnecting serial port...', 'info');
    await SerialDriver.disconnect();
    _onSerialDisconnect();
  });

  // ── Export CSV ──
  el.btnExportCsv.addEventListener('click', () => {
    const csv = Telemetry.exportCsv();
    if (!csv) {
      UI.logConsole('No telemetry data to export.', 'warn');
      return;
    }
    _downloadFile(
      csv,
      `cansat_telemetry_${AppState.sessionId}.csv`,
      'text/csv;charset=utf-8;'
    );
    UI.logConsole(`Exported ${Telemetry.getHistory().length} packets as CSV.`, 'ok');
  });

  // ── Export JSON ──
  el.btnExportJson.addEventListener('click', () => {
    const json = Telemetry.exportJson();
    if (!json) {
      UI.logConsole('No telemetry data to export.', 'warn');
      return;
    }
    _downloadFile(
      json,
      `cansat_telemetry_${AppState.sessionId}.json`,
      'application/json'
    );
    UI.logConsole(`Exported ${Telemetry.getHistory().length} packets as JSON.`, 'ok');
  });

  // ── Clear All Data ──
  el.btnClearData.addEventListener('click', () => {
    if (AppState.isStreaming) {
      UI.logConsole('Cannot clear data while streaming. Disconnect first.', 'warn');
      return;
    }
    _clearAllData();
  });

  // ── Camera: Start ──
  el.btnCameraStart.addEventListener('click', async () => {
    await _startCamera();
  });

  // ── Camera: Stop ──
  el.btnCameraStop.addEventListener('click', () => {
    _stopCamera();
  });

  // ── Console Controls ──
  el.btnClearConsole.addEventListener('click', () => {
    UI.clearConsole();
  });

  // ── Camera: Snapshot ──
  el.btnCameraSnapshot.addEventListener('click', () => {
    _takeSnapshot();
  });

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', (e) => {
    // Ctrl+S = snapshot
    if (e.ctrlKey && e.key === 's' && AppState.cameraActive) {
      e.preventDefault();
      _takeSnapshot();
    }
    // Ctrl+E = export CSV
    if (e.ctrlKey && e.key === 'e') {
      e.preventDefault();
      el.btnExportCsv.click();
    }
    // Escape = close modal
    if (e.key === 'Escape') {
      const modal = document.getElementById('snapshot-modal');
      if (modal) modal.style.display = 'none';
    }
  });

  // ── Window resize: re-fit attitude viewer ──
  window.addEventListener('resize', () => {
    // Charts auto-resize via Chart.js responsive mode
    // Attitude viewer has its own resize handler
    // Map auto-resizes via Leaflet
    // Force Leaflet map invalidation after layout shift
    setTimeout(() => {
      if (MapModule.getMap()) {
        MapModule.getMap().invalidateSize();
      }
    }, 200);
  });

  UI.logConsole('Event handlers wired.', 'ok');
}

/* ═══════════════════════════════════════════════════════════
   SERIAL LINE HANDLER
═══════════════════════════════════════════════════════════ */

/**
 * Called by SerialDriver for every complete newline-terminated string.
 * Routes the raw line to the Telemetry module.
 * @param {string} rawLine
 */
function _onSerialLine(rawLine) {
  if (!rawLine || rawLine.trim().length === 0) return;

  // Route through telemetry parser (which calls UI, Charts, Map, Attitude internally)
  Telemetry.processLine(rawLine);
}

/* ═══════════════════════════════════════════════════════════
   DISCONNECT HANDLER
═══════════════════════════════════════════════════════════ */

/**
 * Called when the serial port disconnects (graceful or unexpected).
 */
function _onSerialDisconnect() {
  AppState.isConnected = false;
  AppState.isStreaming  = false;

  UI.setSerialDisconnected();
  UI.stopMissionElapsedTimer();

  // Log final session statistics
  const stats = Telemetry.getStats();
  UI.logConsole(
    `Session ended. Packets: ${stats.totalPackets} | Good: ${stats.goodPackets} | Errors: ${stats.parseErrors} | CRC fails: ${stats.checksumFails}`,
    'info'
  );
}

/* ═══════════════════════════════════════════════════════════
   CAMERA MODULE
═══════════════════════════════════════════════════════════ */

/**
 * Request camera access and start the live feed.
 */
async function _startCamera() {
  if (AppState.cameraActive) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    UI.logConsole('Camera API not supported.', 'error');
    return;
  }

  try {
    UI.logConsole('Requesting camera access...', 'info');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode:  'environment',   // Prefer rear camera on mobile
        width:       { ideal: 1280 },
        height:      { ideal: 720  },
        frameRate:   { ideal: 30   },
      },
      audio: false,
    });

    const el = UI.getElements();
    el.cameraVideo.srcObject = stream;

    el.cameraVideo.onloadedmetadata = () => {
      el.cameraVideo.play();
      _startCameraOverlay();
    };

    globalCameraStream = stream;
    AppState.cameraActive = true;

    UI.setCameraActive(true);
    UI.logConsole('Camera stream started.', 'ok');

    // Display camera track label
    const track = stream.getVideoTracks()[0];
    if (track) {
      UI.logConsole(`Camera: ${track.label}`, 'info');
    }

  } catch (err) {
    if (err.name === 'NotAllowedError') {
      UI.logConsole('Camera access denied by user.', 'error');
    } else if (err.name === 'NotFoundError') {
      UI.logConsole('No camera device found.', 'error');
    } else {
      UI.logConsole(`Camera error: ${err.message}`, 'error');
    }
  }
}

/**
 * Stop the camera feed and release the media track.
 */
function _stopCamera() {
  if (!AppState.cameraActive) return;

  if (globalCameraStream) {
    globalCameraStream.getTracks().forEach(track => track.stop());
    globalCameraStream = null;
  }

  const el = UI.getElements();
  el.cameraVideo.srcObject = null;

  _stopCameraOverlay();

  AppState.cameraActive = false;
  UI.setCameraActive(false);
  UI.logConsole('Camera stream stopped.', 'info');
}

/* ─────────────────────────────────────────────────────────
   CAMERA OVERLAY CANVAS (HUD telemetry burn-in on video)
───────────────────────────────────────────────────────── */
let _overlayAnimId = null;

function _startCameraOverlay() {
  const canvas = document.getElementById('camera-overlay-canvas');
  if (!canvas) return;

  const video = document.getElementById('camera-video');
  if (!video) return;

  function _drawOverlay() {
    const W = canvas.width  = canvas.offsetWidth;
    const H = canvas.height = canvas.offsetHeight;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // Semi-transparent top banner
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, 28);

    // Bottom banner
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, H - 28, W, 28);

    // Crosshair
    ctx.strokeStyle = 'rgba(0,212,255,0.5)';
    ctx.lineWidth   = 1;
    const cx = W / 2;
    const cy = H / 2;
    const ch = 20;
    ctx.beginPath();
    ctx.moveTo(cx - ch, cy); ctx.lineTo(cx + ch, cy);
    ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy + ch);
    ctx.stroke();

    // Corner brackets
    const bSize = 15;
    ctx.strokeStyle = '#F5A623';
    ctx.lineWidth   = 2;
    const corners = [
      [10, 10], [W - 10, 10], [10, H - 10], [W - 10, H - 10]
    ];
    corners.forEach(([x, y]) => {
      const sx = x < W / 2 ? 1 : -1;
      const sy = y < H / 2 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(x, y + sy * bSize); ctx.lineTo(x, y); ctx.lineTo(x + sx * bSize, y);
      ctx.stroke();
    });

    // UTC timestamp
    const now = new Date();
    const ts  = now.toUTCString().replace(' GMT', ' UTC');
    ctx.font      = '700 10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#F5A623';
    ctx.fillText(`CanSat GCS | ${ts}`, 10, 17);

    // Recording indicator
    ctx.fillStyle = '#FF3D3D';
    ctx.beginPath();
    ctx.arc(W - 16, 14, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font      = '700 9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText('REC', W - 55, 18);

    // Bottom telemetry pull from history
    const history = Telemetry.getHistory();
    if (history.length > 0) {
      const last = history[history.length - 1];
      ctx.font      = '700 9px "JetBrains Mono", monospace';
      ctx.fillStyle = '#00D4FF';
      const info = `ALT:${last.altitude.toFixed(1)}m | T:${last.temperature.toFixed(1)}°C | BATT:${last.batteryVoltage.toFixed(2)}V | PKT#${last.packetCount}`;
      ctx.fillText(info, 10, H - 10);
    }

    _overlayAnimId = requestAnimationFrame(_drawOverlay);
  }

  _drawOverlay();
}

function _stopCameraOverlay() {
  if (_overlayAnimId !== null) {
    cancelAnimationFrame(_overlayAnimId);
    _overlayAnimId = null;
  }
  const canvas = document.getElementById('camera-overlay-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

/* ─────────────────────────────────────────────────────────
   SNAPSHOT CAPTURE
───────────────────────────────────────────────────────── */

/**
 * Capture the current camera frame as a PNG snapshot.
 * Composites the video frame and the overlay canvas.
 */
function _takeSnapshot() {
  const video  = document.getElementById('camera-video');
  const overlay = document.getElementById('camera-overlay-canvas');

  if (!video || !AppState.cameraActive) {
    UI.logConsole('Cannot snapshot: camera not active.', 'warn');
    return;
  }

  // Create offscreen canvas at video resolution
  const W = video.videoWidth  || 640;
  const H = video.videoHeight || 480;

  const offscreen = document.createElement('canvas');
  offscreen.width  = W;
  offscreen.height = H;
  const ctx = offscreen.getContext('2d');

  // Draw video frame
  ctx.drawImage(video, 0, 0, W, H);

  // Composite overlay (scaled from display size to video resolution)
  if (overlay && overlay.width > 0 && overlay.height > 0) {
    ctx.drawImage(overlay, 0, 0, W, H);
  }

  const dataUrl  = offscreen.toDataURL('image/png');
  const history  = Telemetry.getHistory();
  const last     = history.length > 0 ? history[history.length - 1] : null;
  const metaStr  = last
    ? `PKT#${last.packetCount} | ALT:${last.altitude.toFixed(1)}m | T:${last.temperature.toFixed(1)}°C | ${new Date().toISOString()}`
    : `Snapshot at ${new Date().toISOString()}`;

  AppState.snapshotIndex++;
  UI.addSnapshotThumb(dataUrl, metaStr);
  UI.logConsole(`Snapshot #${AppState.snapshotIndex} captured. ${metaStr}`, 'ok');
}

/* ═══════════════════════════════════════════════════════════
   CLEAR ALL DATA
═══════════════════════════════════════════════════════════ */
function _clearAllData() {
  // Reset telemetry session
  Telemetry.resetSession();

  // Clear all charts
  Charts.clearAllCharts();

  // Clear map track
  MapModule.resetTrack();

  // Reset 3D attitude to neutral
  AttitudeViewer.resetOrientation();

  // Reset UI displays
  UI.resetAllDisplays();

  // Reset app state counters
  AppState.totalPackets  = 0;
  AppState.goodPackets   = 0;
  AppState.parseErrors   = 0;
  AppState.checksumFails = 0;
  AppState.snapshotIndex = 0;

  // Generate fresh session ID
  AppState.sessionId = _generateSessionId();
  UI.logConsole(`New session started: ${AppState.sessionId}`, 'info');
}

/* ═══════════════════════════════════════════════════════════
   DEMO DATA INJECTION
   Injects a few synthetic packets on first load so all panels
   render with representative data rather than blank states.
═══════════════════════════════════════════════════════════ */
function _injectDemoData() {
  UI.logConsole('[DEMO] Injecting sample data for UI verification...', 'info');

  // Build 12 synthetic telemetry packets simulating a short descent
  const demoPackets = [
    { pkt: 1,  alt: 320.50, pres: 979.2, temp: 18.3, dsc: 0.0,  batt: 4.12, lat: 12.971598, lng: 77.594563, r: 0.0,   p:  0.0,  y: 0.0   },
    { pkt: 2,  alt: 318.20, pres: 979.8, temp: 18.1, dsc: 2.3,  batt: 4.11, lat: 12.971612, lng: 77.594580, r: 1.2,   p:  0.5,  y: 2.1   },
    { pkt: 3,  alt: 310.10, pres: 980.9, temp: 17.8, dsc: 8.1,  batt: 4.10, lat: 12.971640, lng: 77.594610, r: 3.5,   p:  2.1,  y: 5.4   },
    { pkt: 4,  alt: 301.80, pres: 981.9, temp: 17.4, dsc: 8.3,  batt: 4.10, lat: 12.971670, lng: 77.594640, r: 4.1,   p:  2.8,  y: 8.7   },
    { pkt: 5,  alt: 293.40, pres: 982.9, temp: 17.0, dsc: 8.4,  batt: 4.09, lat: 12.971700, lng: 77.594670, r: 3.8,   p:  3.2,  y: 12.1  },
    { pkt: 6,  alt: 284.90, pres: 983.9, temp: 16.6, dsc: 8.5,  batt: 4.09, lat: 12.971732, lng: 77.594705, r: 2.9,   p:  2.5,  y: 15.8  },
    { pkt: 7,  alt: 276.50, pres: 984.9, temp: 16.2, dsc: 8.4,  batt: 4.08, lat: 12.971760, lng: 77.594740, r: 1.5,   p:  1.8,  y: 19.2  },
    { pkt: 8,  alt: 268.10, pres: 985.9, temp: 15.8, dsc: 8.4,  batt: 4.08, lat: 12.971792, lng: 77.594778, r: -0.5,  p:  1.1,  y: 22.6  },
    { pkt: 9,  alt: 259.80, pres: 986.9, temp: 15.5, dsc: 8.3,  batt: 4.07, lat: 12.971820, lng: 77.594810, r: -2.1,  p:  0.4,  y: 25.9  },
    { pkt: 10, alt: 251.40, pres: 987.9, temp: 15.1, dsc: 8.4,  batt: 4.07, lat: 12.971855, lng: 77.594850, r: -3.4,  p: -0.5,  y: 29.3  },
    { pkt: 11, alt: 243.00, pres: 988.9, temp: 14.7, dsc: 8.4,  batt: 4.06, lat: 12.971888, lng: 77.594888, r: -4.1,  p: -1.2,  y: 32.7  },
    { pkt: 12, alt: 234.60, pres: 990.0, temp: 14.4, dsc: 8.4,  batt: 4.06, lat: 12.971920, lng: 77.594925, r: -4.5,  p: -1.8,  y: 36.1  },
  ];

  demoPackets.forEach(d => {
    // Build a fake raw line
    const body = [
      '$CSV',
      d.pkt,
      d.alt.toFixed(2),
      d.pres.toFixed(2),
      d.temp.toFixed(2),
      d.dsc.toFixed(2),
      d.batt.toFixed(3),
      d.lat.toFixed(8),
      d.lng.toFixed(8),
      d.r.toFixed(2),
      d.p.toFixed(2),
      d.y.toFixed(2),
    ].join(',');

    // Compute XOR checksum
    let cs = 0;
    for (let i = 1; i < body.length; i++) {  // Skip '$'
      cs ^= body.charCodeAt(i);
    }
    const rawLine = `${body}*${cs.toString(16).toUpperCase().padStart(2, '0')}`;

    // Process through the full telemetry pipeline
    Telemetry.processLine(rawLine);
  });

  UI.logConsole('[DEMO] Sample data injected. Connect a device to receive live data.', 'info');
}

/* ═══════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════ */

/**
 * Trigger a browser file download with given content.
 * @param {string} content  - File content
 * @param {string} filename - Suggested file name
 * @param {string} mimeType - MIME type string
 */
function _downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

/**
 * Generate a short unique session identifier.
 * @returns {string} e.g. "SES-1F3A-2026"
 */
function _generateSessionId() {
  const now  = new Date();
  const year = now.getFullYear();
  const hex  = Math.floor(Math.random() * 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
  return `SES-${hex}-${year}`;
}
