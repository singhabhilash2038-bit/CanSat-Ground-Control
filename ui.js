/**
 * ui.js — CanSat GCS User Interface Controller
 * Handles all DOM manipulations, telemetry display formatting,
 * color flag management, and fault annunciator updates.
 */

'use strict';

const UI = (() => {

  /* ─────────────────────────────────────────────────────────
     INTERNAL STATE
  ───────────────────────────────────────────────────────── */
  let _missionStartTime   = null;
  let _metIntervalId      = null;
  let _utcIntervalId      = null;
  let _lastPacketTimestamp = null;
  let _packetTimestamps   = [];   // rolling window for rate calculation
  const _MAX_RATE_WINDOW  = 5000; // milliseconds

  /* ─────────────────────────────────────────────────────────
     DOM ELEMENT CACHE
  ───────────────────────────────────────────────────────── */
  const el = {};

  function _cacheElements() {
    el.valAltitude      = document.getElementById('val-altitude');
    el.valPressure      = document.getElementById('val-pressure');
    el.valTemperature   = document.getElementById('val-temperature');
    el.valDescentRate   = document.getElementById('val-descent-rate');
    el.valVoltage       = document.getElementById('val-voltage');
    el.valGpsLat        = document.getElementById('val-gps-lat');
    el.valGpsLng        = document.getElementById('val-gps-lng');
    el.valRoll          = document.getElementById('val-roll');
    el.valPitch         = document.getElementById('val-pitch');
    el.valYaw           = document.getElementById('val-yaw');

    el.cardAltitude     = document.getElementById('card-altitude');
    el.cardPressure     = document.getElementById('card-pressure');
    el.cardTemperature  = document.getElementById('card-temperature');
    el.cardDescentRate  = document.getElementById('card-descent-rate');
    el.cardVoltage      = document.getElementById('card-voltage');
    el.cardGpsLat       = document.getElementById('card-gps-lat');
    el.cardGpsLng       = document.getElementById('card-gps-lng');
    el.cardRoll         = document.getElementById('card-roll');
    el.cardPitch        = document.getElementById('card-pitch');
    el.cardYaw          = document.getElementById('card-yaw');

    el.packetCounterBadge  = document.getElementById('packet-counter-badge');
    el.missionPhaseLabel   = document.getElementById('mission-phase-label');
    el.missionPhasePill    = document.getElementById('mission-phase-pill');
    el.missionPhaseDot     = document.getElementById('mission-phase-dot');
    el.serialStatusLabel   = document.getElementById('serial-status-label');
    el.serialStatusPill    = document.getElementById('serial-status-pill');
    el.serialStatusDot     = document.getElementById('serial-status-dot');

    el.missionElapsedTime  = document.getElementById('mission-elapsed-time');
    el.utcClock            = document.getElementById('utc-clock');

    el.annDescentRate   = document.getElementById('ann-descent-rate');
    el.annGpsState      = document.getElementById('ann-gps-state');
    el.annSeparation    = document.getElementById('ann-separation');
    el.annParachute     = document.getElementById('ann-parachute');

    el.errorCodeValue   = document.getElementById('error-code-value');

    el.linkQualityBar   = document.getElementById('link-quality-bar');
    el.linkQualityPct   = document.getElementById('link-quality-pct');
    el.packetRateDisplay    = document.getElementById('packet-rate-display');
    el.totalPacketsDisplay  = document.getElementById('total-packets-display');
    el.parseErrorsDisplay   = document.getElementById('parse-errors-display');
    el.checksumFailDisplay  = document.getElementById('checksum-fail-display');

    el.mapLatDisplay    = document.getElementById('map-lat-display');
    el.mapLngDisplay    = document.getElementById('map-lng-display');

    el.attRollDisplay   = document.getElementById('att-roll-display');
    el.attPitchDisplay  = document.getElementById('att-pitch-display');
    el.attYawDisplay    = document.getElementById('att-yaw-display');

    el.consoleOutput    = document.getElementById('console-output');
    el.consoleAutoscroll = document.getElementById('console-autoscroll');
    el.btnClearConsole  = document.getElementById('btn-clear-console');

    el.btnConnect       = document.getElementById('btn-connect-serial');
    el.btnDisconnect    = document.getElementById('btn-disconnect-serial');
    el.btnExportCsv     = document.getElementById('btn-export-csv');
    el.btnExportJson    = document.getElementById('btn-export-json');
    el.btnClearData     = document.getElementById('btn-clear-data');
    el.baudRateSelect   = document.getElementById('baud-rate-select');

    el.btnCameraStart   = document.getElementById('btn-camera-start');
    el.btnCameraStop    = document.getElementById('btn-camera-stop');
    el.btnCameraSnapshot = document.getElementById('btn-camera-snapshot');
    el.cameraVideo      = document.getElementById('camera-video');
    el.cameraOffline    = document.getElementById('camera-offline-overlay');
    el.snapshotThumbs   = document.getElementById('snapshot-thumbnails');
    el.snapshotModal    = document.getElementById('snapshot-modal');
    el.snapshotModalImg = document.getElementById('snapshot-modal-img');
    el.snapshotModalMeta = document.getElementById('snapshot-modal-meta');
    el.snapshotModalClose = document.getElementById('snapshot-modal-close');
    el.snapshotDownload = document.getElementById('snapshot-download-link');
  }

  /* ─────────────────────────────────────────────────────────
     CLOCK UTILITIES
  ───────────────────────────────────────────────────────── */
  function _padTwo(n) {
    return String(Math.floor(n)).padStart(2, '0');
  }

  function _startUtcClock() {
    function _tick() {
      const now = new Date();
      const h = _padTwo(now.getUTCHours());
      const m = _padTwo(now.getUTCMinutes());
      const s = _padTwo(now.getUTCSeconds());
      if (el.utcClock) {
        el.utcClock.textContent = `${h}:${m}:${s}`;
      }
    }
    _tick();
    _utcIntervalId = setInterval(_tick, 1000);
  }

  function startMissionElapsedTimer() {
    if (_metIntervalId !== null) {
      return; // already running
    }
    _missionStartTime = Date.now();

    function _tick() {
      const elapsed = Math.floor((Date.now() - _missionStartTime) / 1000);
      const h = _padTwo(elapsed / 3600);
      const m = _padTwo((elapsed % 3600) / 60);
      const s = _padTwo(elapsed % 60);
      if (el.missionElapsedTime) {
        el.missionElapsedTime.textContent = `T+${h}:${m}:${s}`;
      }
    }
    _tick();
    _metIntervalId = setInterval(_tick, 1000);
  }

  function stopMissionElapsedTimer() {
    if (_metIntervalId !== null) {
      clearInterval(_metIntervalId);
      _metIntervalId = null;
    }
  }

  function resetMissionElapsedTimer() {
    stopMissionElapsedTimer();
    if (el.missionElapsedTime) {
      el.missionElapsedTime.textContent = 'T+00:00:00';
    }
  }

  /* ─────────────────────────────────────────────────────────
     SERIAL / CONNECTION STATUS
  ───────────────────────────────────────────────────────── */
  function setSerialConnected(baud) {
    el.serialStatusLabel.textContent = `${baud} BAUD`;
    el.serialStatusPill.classList.add('connected');
    el.btnConnect.disabled    = true;
    el.btnDisconnect.disabled = false;
    logConsole(`Serial port connected at ${baud} baud.`, 'ok');
  }

  function setSerialDisconnected() {
    el.serialStatusLabel.textContent = 'DISCONNECTED';
    el.serialStatusPill.classList.remove('connected');
    el.btnConnect.disabled    = false;
    el.btnDisconnect.disabled = true;
    logConsole('Serial port disconnected.', 'warn');
  }

  /* ─────────────────────────────────────────────────────────
     MISSION PHASE
  ───────────────────────────────────────────────────────── */
  function setMissionPhase(phase) {
    const phaseMap = {
      STANDBY:   { label: 'STANDBY',   cls: '' },
      ASCENT:    { label: 'ASCENT',    cls: 'mission-active' },
      APOGEE:    { label: 'APOGEE',    cls: 'mission-active' },
      DESCENT:   { label: 'DESCENT',   cls: 'mission-active' },
      LANDED:    { label: 'LANDED',    cls: '' },
      RECOVERY:  { label: 'RECOVERY',  cls: '' },
    };
    const cfg = phaseMap[phase] || phaseMap['STANDBY'];
    el.missionPhaseLabel.textContent = cfg.label;
    el.missionPhasePill.className    = `status-pill ${cfg.cls}`;
  }

  /* ─────────────────────────────────────────────────────────
     TELEMETRY VALUE FORMATTERS
  ───────────────────────────────────────────────────────── */
  function _safeFixed(val, places) {
    const n = parseFloat(val);
    if (isNaN(n)) return '---';
    return n.toFixed(places);
  }

  function _flashCard(cardEl) {
    if (!cardEl) return;
    cardEl.classList.remove('data-updated');
    void cardEl.offsetWidth; // force reflow to restart animation
    cardEl.classList.add('data-updated');
  }

  function updateTelemetryValues(packet) {
    // Altitude
    el.valAltitude.innerHTML    = `${_safeFixed(packet.altitude, 2)} <span class="telem-unit-inline">m</span>`;
    _flashCard(el.cardAltitude);

    // Pressure
    el.valPressure.innerHTML    = `${_safeFixed(packet.pressure, 2)} <span class="telem-unit-inline">hPa</span>`;
    _flashCard(el.cardPressure);

    // Temperature
    el.valTemperature.innerHTML = `${_safeFixed(packet.temperature, 2)} <span class="telem-unit-inline">°C</span>`;
    _flashCard(el.cardTemperature);

    // Descent rate — color flag based on nominal range 8–10 m/s
    const dr = parseFloat(packet.descentRate);
    el.valDescentRate.innerHTML = `${_safeFixed(packet.descentRate, 2)} <span class="telem-unit-inline">m/s</span>`;
    _flashCard(el.cardDescentRate);
    if (!isNaN(dr) && dr !== 0 && (dr < 8.0 || dr > 10.0)) {
      el.cardDescentRate.classList.add('warn-active');
      el.cardDescentRate.classList.remove('fault-active');
    } else if (!isNaN(dr) && dr < 0) {
      el.cardDescentRate.classList.add('fault-active');
      el.cardDescentRate.classList.remove('warn-active');
    } else {
      el.cardDescentRate.classList.remove('warn-active');
      el.cardDescentRate.classList.remove('fault-active');
    }

    // Battery voltage — warn below 3.5V, fault below 3.2V
    const vlt = parseFloat(packet.batteryVoltage);
    el.valVoltage.innerHTML = `${_safeFixed(packet.batteryVoltage, 3)} <span class="telem-unit-inline">V</span>`;
    _flashCard(el.cardVoltage);
    if (!isNaN(vlt)) {
      if (vlt < 3.2) {
        el.cardVoltage.classList.add('fault-active');
        el.cardVoltage.classList.remove('warn-active');
      } else if (vlt < 3.5) {
        el.cardVoltage.classList.add('warn-active');
        el.cardVoltage.classList.remove('fault-active');
      } else {
        el.cardVoltage.classList.remove('fault-active');
        el.cardVoltage.classList.remove('warn-active');
      }
    }

    // GPS
    el.valGpsLat.innerHTML = `${_safeFixed(packet.gpsLat, 6)} <span class="telem-unit-inline">°</span>`;
    el.valGpsLng.innerHTML = `${_safeFixed(packet.gpsLng, 6)} <span class="telem-unit-inline">°</span>`;
    el.mapLatDisplay.textContent = `LAT: ${_safeFixed(packet.gpsLat, 6)}°`;
    el.mapLngDisplay.textContent = `LNG: ${_safeFixed(packet.gpsLng, 6)}°`;
    _flashCard(el.cardGpsLat);
    _flashCard(el.cardGpsLng);

    // Attitude
    el.valRoll.innerHTML  = `${_safeFixed(packet.roll, 2)} <span class="telem-unit-inline">°</span>`;
    el.valPitch.innerHTML = `${_safeFixed(packet.pitch, 2)} <span class="telem-unit-inline">°</span>`;
    el.valYaw.innerHTML   = `${_safeFixed(packet.yaw, 2)} <span class="telem-unit-inline">°</span>`;
    _flashCard(el.cardRoll);
    _flashCard(el.cardPitch);
    _flashCard(el.cardYaw);

    // Attitude header display
    el.attRollDisplay.textContent  = _safeFixed(packet.roll, 1);
    el.attPitchDisplay.textContent = _safeFixed(packet.pitch, 1);
    el.attYawDisplay.textContent   = _safeFixed(packet.yaw, 1);

    // Packet counter
    el.packetCounterBadge.textContent = `PKT #${packet.packetCount}`;

    // Pulse the telemetry dot
    const telemDot = document.getElementById('telem-status-dot');
    if (telemDot) {
      telemDot.classList.add('active');
      clearTimeout(telemDot._timeout);
      telemDot._timeout = setTimeout(() => {
        telemDot.classList.remove('active');
      }, 1500);
    }
  }

  /* ─────────────────────────────────────────────────────────
     FAULT ANNUNCIATORS
  ───────────────────────────────────────────────────────── */

  /**
   * Update the visual state of a single annunciator tile.
   * @param {HTMLElement} tileEl   - The annunciator-tile element
   * @param {boolean}     isFault  - Whether a fault is active
   * @param {boolean}     isWarn   - Whether a warning (not full fault) is active
   * @param {string}      nomLabel - Label text when nominal
   * @param {string}      faultLabel - Label text when fault
   */
  function _setAnnunciatorState(tileEl, isFault, isWarn, nomLabel, faultLabel) {
    const badge = tileEl.querySelector('.ann-status-badge');
    tileEl.classList.toggle('fault-active', isFault);
    tileEl.classList.toggle('warn-active',  isWarn && !isFault);
    if (badge) {
      badge.textContent = isFault ? faultLabel : (isWarn ? 'WARNING' : nomLabel);
    }
  }

  /**
   * Update all four annunciator panels based on the parsed 4-digit error code.
   * Digit 1: descentRateFlag   0=nominal, 1=violation
   * Digit 2: gpsStateFlag      0=active,  1=drop/no fix
   * Digit 3: separationFlag    0=success, 1=mechanism failure
   * Digit 4: parachuteFlag     0=inactive, 1=deployed/warning
   * @param {object} flags - { descentRateFlag, gpsStateFlag, separationFlag, parachuteFlag }
   */
  function updateFaultAnnunciators(flags) {
    const { descentRateFlag, gpsStateFlag, separationFlag, parachuteFlag } = flags;

    // D1 — Descent Rate
    _setAnnunciatorState(
      el.annDescentRate,
      descentRateFlag === 1,
      false,
      'NOMINAL',
      'VIOLATION'
    );

    // D2 — GPS State
    _setAnnunciatorState(
      el.annGpsState,
      gpsStateFlag === 1,
      false,
      'NOMINAL',
      'NO FIX'
    );

    // D3 — Separation
    _setAnnunciatorState(
      el.annSeparation,
      separationFlag === 1,
      false,
      'NOMINAL',
      'MECH FAIL'
    );

    // D4 — Parachute (warn, not fault)
    _setAnnunciatorState(
      el.annParachute,
      false,
      parachuteFlag === 1,
      'INACTIVE',
      'DEPLOYED'
    );
    if (parachuteFlag === 1) {
      el.annParachute.querySelector('.ann-status-badge').textContent = 'DEPLOYED';
    }

    // Error code display
    const code = `${descentRateFlag}${gpsStateFlag}${separationFlag}${parachuteFlag}`;
    el.errorCodeValue.textContent = code;
    const hasFault = descentRateFlag || gpsStateFlag || separationFlag || parachuteFlag;
    el.errorCodeValue.classList.toggle('has-fault', hasFault > 0);
  }

  /* ─────────────────────────────────────────────────────────
     HEALTH STATS
  ───────────────────────────────────────────────────────── */
  function updateHealthStats(stats) {
    // Total packets
    el.totalPacketsDisplay.textContent = stats.totalPackets;

    // Parse errors
    el.parseErrorsDisplay.textContent = stats.parseErrors;

    // Checksum failures
    el.checksumFailDisplay.textContent = stats.checksumFails;

    // Packet rate (packets per second over rolling window)
    const now = Date.now();
    _packetTimestamps.push(now);
    // Evict timestamps outside the window
    _packetTimestamps = _packetTimestamps.filter(ts => now - ts <= _MAX_RATE_WINDOW);
    const rate = (_packetTimestamps.length / (_MAX_RATE_WINDOW / 1000)).toFixed(1);
    el.packetRateDisplay.textContent = `${rate} pkt/s`;

    // Link quality — ratio of good packets to total, expressed as percentage
    const goodPackets = stats.totalPackets - stats.parseErrors - stats.checksumFails;
    const totalAttempts = stats.totalPackets + stats.parseErrors + stats.checksumFails;
    const quality = totalAttempts > 0
      ? Math.max(0, Math.min(100, Math.round((goodPackets / totalAttempts) * 100)))
      : 0;
    el.linkQualityBar.style.width = `${quality}%`;
    el.linkQualityPct.textContent = `${quality}%`;

    // Color the bar based on quality
    if (quality < 50) {
      el.linkQualityBar.style.background = 'linear-gradient(90deg, #7a1515, #FF3D3D)';
    } else if (quality < 80) {
      el.linkQualityBar.style.background = 'linear-gradient(90deg, #806b00, #FFD600)';
    } else {
      el.linkQualityBar.style.background = 'linear-gradient(90deg, #00994f, #00E676)';
    }
  }

  /* ─────────────────────────────────────────────────────────
     CONSOLE
  ───────────────────────────────────────────────────────── */
  function logConsole(message, type = 'info') {
    if (!el.consoleOutput) return;

    const now   = new Date();
    const h     = _padTwo(now.getHours());
    const m     = _padTwo(now.getMinutes());
    const s     = _padTwo(now.getSeconds());
    const ts    = `${h}:${m}:${s}`;

    const lineEl = document.createElement('div');
    lineEl.className = `console-line console-line--${type}`;

    const tsEl = document.createElement('span');
    tsEl.className   = 'console-ts';
    tsEl.textContent = ts;

    const msgEl = document.createElement('span');
    msgEl.className   = 'console-msg';
    msgEl.textContent = message;

    lineEl.appendChild(tsEl);
    lineEl.appendChild(msgEl);
    el.consoleOutput.appendChild(lineEl);

    // Limit console lines to prevent DOM bloat
    const MAX_CONSOLE_LINES = 500;
    const lines = el.consoleOutput.querySelectorAll('.console-line');
    if (lines.length > MAX_CONSOLE_LINES) {
      for (let i = 0; i < lines.length - MAX_CONSOLE_LINES; i++) {
        lines[i].remove();
      }
    }

    // Auto-scroll if enabled
    if (el.consoleAutoscroll && el.consoleAutoscroll.checked) {
      el.consoleOutput.scrollTop = el.consoleOutput.scrollHeight;
    }
  }

  function clearConsole() {
    if (!el.consoleOutput) return;
    el.consoleOutput.innerHTML = '';
    logConsole('Console cleared.', 'info');
  }

  /* ─────────────────────────────────────────────────────────
     CHART TAB SWITCHING
  ───────────────────────────────────────────────────────── */
  function _initChartTabs() {
    const tabs = document.querySelectorAll('.chart-tab-btn');
    tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetChart = btn.dataset.chart;

        // Deactivate all tabs and containers
        tabs.forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.chart-container').forEach(c => c.classList.add('hidden'));

        // Activate clicked tab and corresponding container
        btn.classList.add('active');
        const container = document.getElementById(`chart-${targetChart}-container`);
        if (container) {
          container.classList.remove('hidden');
          // Trigger chart resize
          const chartCanvas = container.querySelector('canvas');
          if (chartCanvas && chartCanvas._chartInstance) {
            chartCanvas._chartInstance.resize();
          }
          // Dispatch resize event so Chart.js instances can re-layout
          window.dispatchEvent(new Event('resize'));
        }
      });
    });
  }

  /* ─────────────────────────────────────────────────────────
     CAMERA MODULE UI
  ───────────────────────────────────────────────────────── */
  function setCameraActive(active) {
    el.btnCameraStart.disabled  = active;
    el.btnCameraStop.disabled   = !active;
    el.btnCameraSnapshot.disabled = !active;
    if (active) {
      el.cameraOffline.classList.add('hidden');
    } else {
      el.cameraOffline.classList.remove('hidden');
    }

    const camDot = document.getElementById('camera-status-dot');
    if (camDot) {
      if (active) camDot.classList.add('active');
      else camDot.classList.remove('active');
    }
  }

  /**
   * Add a snapshot thumbnail to the strip.
   * @param {string} dataUrl - base64 PNG data URL
   * @param {string} meta    - metadata string for modal
   */
  function addSnapshotThumb(dataUrl, meta) {
    const img = document.createElement('img');
    img.src = dataUrl;
    img.className   = 'snapshot-thumb';
    img.alt         = 'CanSat snapshot';
    img.title       = meta;
    img.addEventListener('click', () => {
      el.snapshotModalImg.src       = dataUrl;
      el.snapshotModalMeta.textContent = meta;
      el.snapshotDownload.href      = dataUrl;
      el.snapshotModal.style.display = 'flex';
    });
    el.snapshotThumbs.appendChild(img);
    el.snapshotThumbs.scrollLeft = el.snapshotThumbs.scrollWidth;
  }

  function _initSnapshotModal() {
    el.snapshotModalClose.addEventListener('click', () => {
      el.snapshotModal.style.display = 'none';
    });
    el.snapshotModal.addEventListener('click', (e) => {
      if (e.target === el.snapshotModal) {
        el.snapshotModal.style.display = 'none';
      }
    });
  }

  /* ─────────────────────────────────────────────────────────
     RESET / CLEAR
  ───────────────────────────────────────────────────────── */
  function resetAllDisplays() {
    const fields = [
      el.valAltitude, el.valPressure, el.valTemperature,
      el.valDescentRate, el.valVoltage, el.valGpsLat, el.valGpsLng,
      el.valRoll, el.valPitch, el.valYaw,
      el.attRollDisplay, el.attPitchDisplay, el.attYawDisplay,
    ];
    fields.forEach(el => { if (el) el.textContent = '---'; });
    el.mapLatDisplay.textContent = 'LAT: ---';
    el.mapLngDisplay.textContent = 'LNG: ---';
    el.packetCounterBadge.textContent = 'PKT #0';
    el.errorCodeValue.textContent = '0000';
    el.errorCodeValue.classList.remove('has-fault');
    el.totalPacketsDisplay.textContent = '0';
    el.parseErrorsDisplay.textContent  = '0';
    el.checksumFailDisplay.textContent = '0';
    el.packetRateDisplay.textContent   = '0 pkt/s';
    el.linkQualityBar.style.width = '0%';
    el.linkQualityPct.textContent = '0%';
    _packetTimestamps = [];

    // Reset all telemetry card states
    [el.cardAltitude, el.cardPressure, el.cardTemperature,
     el.cardDescentRate, el.cardVoltage, el.cardGpsLat,
     el.cardGpsLng, el.cardRoll, el.cardPitch, el.cardYaw].forEach(c => {
      if (c) {
        c.classList.remove('fault-active', 'warn-active', 'data-updated');
      }
    });

    // Reset annunciators
    [el.annDescentRate, el.annGpsState, el.annSeparation, el.annParachute].forEach(tile => {
      if (tile) {
        tile.classList.remove('fault-active', 'warn-active');
        const badge = tile.querySelector('.ann-status-badge');
        if (badge) badge.textContent = 'NOMINAL';
      }
    });
    // Parachute special reset
    if (el.annParachute) {
      const badge = el.annParachute.querySelector('.ann-status-badge');
      if (badge) badge.textContent = 'INACTIVE';
    }

    resetMissionElapsedTimer();
    clearConsole();
    logConsole('All data cleared. Ready for new session.', 'info');
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC INIT
  ───────────────────────────────────────────────────────── */
  function init() {
    _cacheElements();
    _startUtcClock();
    _initChartTabs();
    _initSnapshotModal();

    // Wire console clear button
    el.btnClearConsole.addEventListener('click', clearConsole);

    logConsole('GCS interface initialized.', 'info');
    logConsole(`Web Serial API ${('serial' in navigator) ? 'available' : 'NOT available — use Chrome/Edge'}`, 'info');
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────── */
  return {
    init,
    logConsole,
    clearConsole,
    setSerialConnected,
    setSerialDisconnected,
    setMissionPhase,
    updateTelemetryValues,
    updateFaultAnnunciators,
    updateHealthStats,
    resetAllDisplays,
    startMissionElapsedTimer,
    stopMissionElapsedTimer,
    resetMissionElapsedTimer,
    setCameraActive,
    addSnapshotThumb,
    getElements: () => el,
  };

})();
