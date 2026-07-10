/**
 * telemetry.js — CanSat GCS Telemetry Parser & Validator
 *
 * Parses the structured CSV telemetry packet:
 *   $CSV,PACKET_COUNT,ALTITUDE,PRESSURE,TEMPERATURE,DESCENT_RATE,
 *         BATTERY_VOLTAGE,GPS_LAT,GPS_LNG,ROLL,PITCH,YAW*CHECKSUM
 *
 * Validates XOR checksum, extracts bitflags for fault annunciators,
 * maintains session-level statistics, and dispatches parsed data
 * to all downstream consumers (charts, map, 3D, UI).
 */

'use strict';

const Telemetry = (() => {

  /* ─────────────────────────────────────────────────────────
     SESSION STATISTICS
  ───────────────────────────────────────────────────────── */
  let _stats = {
    totalPackets:  0,
    goodPackets:   0,
    parseErrors:   0,
    checksumFails: 0,
  };

  /* ─────────────────────────────────────────────────────────
     TELEMETRY HISTORY
     Full log of all successfully parsed packets for export.
  ───────────────────────────────────────────────────────── */
  const _history = [];

  /* ─────────────────────────────────────────────────────────
     MISSION PHASE INFERENCE
     Derived from altitude trajectory.
  ───────────────────────────────────────────────────────── */
  let _prevAltitude       = null;
  let _missionPhase       = 'STANDBY';
  let _altitudeAtApogee   = null;
  let _hasLaunched        = false;
  const LAUNCH_THRESHOLD_M  = 5.0;   // meters above start to detect launch
  const LANDED_THRESHOLD_M  = 3.0;   // meters of descent rate near zero to detect landing
  const LANDED_ALT_MARGIN   = 10.0;  // within N meters of ground to consider landing

  /* ─────────────────────────────────────────────────────────
     XOR CHECKSUM CALCULATION
  ───────────────────────────────────────────────────────── */

  /**
   * Compute the NMEA-style XOR checksum for the content
   * between (and excluding) '$' and '*' in the raw packet string.
   * @param {string} rawLine - The full raw packet line
   * @returns {number|null}  - The computed checksum byte, or null if malformed
   */
  function _computeChecksum(rawLine) {
    // Find the '$' start marker and '*' end marker
    const dollarIdx = rawLine.indexOf('$');
    const starIdx   = rawLine.indexOf('*');

    if (dollarIdx === -1 || starIdx === -1 || starIdx <= dollarIdx) {
      return null; // Malformed: missing delimiters
    }

    // XOR all bytes between (excluding) '$' and '*'
    let checksum = 0;
    for (let i = dollarIdx + 1; i < starIdx; i++) {
      checksum ^= rawLine.charCodeAt(i);
    }
    return checksum;
  }

  /**
   * Extract the transmitted checksum hex string from the raw line.
   * @param {string} rawLine
   * @returns {number|null} - Parsed integer checksum, or null if missing/invalid
   */
  function _extractTransmittedChecksum(rawLine) {
    const starIdx = rawLine.indexOf('*');
    if (starIdx === -1) return null;

    const hexStr = rawLine.substring(starIdx + 1).trim();
    if (hexStr.length === 0) return null;

    const parsed = parseInt(hexStr, 16);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Validate the checksum of an incoming raw packet line.
   * @param {string} rawLine
   * @returns {{ valid: boolean, computed: number|null, transmitted: number|null }}
   */
  function validateChecksum(rawLine) {
    const computed    = _computeChecksum(rawLine);
    const transmitted = _extractTransmittedChecksum(rawLine);

    if (computed === null || transmitted === null) {
      return { valid: false, computed, transmitted };
    }

    return {
      valid:       computed === transmitted,
      computed,
      transmitted,
    };
  }

  /* ─────────────────────────────────────────────────────────
     PACKET PARSER
  ───────────────────────────────────────────────────────── */

  /**
   * Parse a single raw telemetry line into a structured object.
   *
   * Expected format (0-indexed fields after splitting on comma):
   *   [0]  $CSV
   *   [1]  PACKET_COUNT
   *   [2]  ALTITUDE       (meters, float)
   *   [3]  PRESSURE       (hPa, float)
   *   [4]  TEMPERATURE    (°C, float)
   *   [5]  DESCENT_RATE   (m/s, float)
   *   [6]  BATTERY_VOLTAGE (V, float)
   *   [7]  GPS_LAT        (decimal degrees, float)
   *   [8]  GPS_LNG        (decimal degrees, float)
   *   [9]  ROLL           (degrees, float)
   *   [10] PITCH          (degrees, float)
   *   [11] YAW*CHECKSUM   (degrees, float; checksum stripped before parsing)
   *
   * @param {string} rawLine
   * @returns {{ ok: boolean, packet?: object, error?: string }}
   */
  function parseLine(rawLine) {
    _stats.totalPackets++;

    // Quick prefix check
    if (!rawLine.startsWith('$CSV,')) {
      _stats.parseErrors++;
      return { ok: false, error: `Invalid prefix: "${rawLine.substring(0, 10)}"` };
    }

    // ── Checksum validation ──
    const csResult = validateChecksum(rawLine);
    if (!csResult.valid) {
      _stats.checksumFails++;
      const detail = (csResult.computed === null || csResult.transmitted === null)
        ? 'missing checksum field'
        : `computed=0x${(csResult.computed).toString(16).toUpperCase()} vs received=0x${(csResult.transmitted).toString(16).toUpperCase()}`;
      return { ok: false, error: `Checksum mismatch (${detail}): ${rawLine}` };
    }

    // ── Strip checksum suffix to get clean CSV body ──
    const starIdx = rawLine.indexOf('*');
    const csvBody = rawLine.substring(0, starIdx);

    // ── Split fields ──
    const fields = csvBody.split(',');

    if (fields.length < 12) {
      _stats.parseErrors++;
      return { ok: false, error: `Too few fields (${fields.length}/12): ${rawLine}` };
    }

    // ── Parse numeric fields ──
    const packetCount    = parseInt(fields[1],  10);
    const altitude       = parseFloat(fields[2]);
    const pressure       = parseFloat(fields[3]);
    const temperature    = parseFloat(fields[4]);
    const descentRate    = parseFloat(fields[5]);
    const batteryVoltage = parseFloat(fields[6]);
    const gpsLat         = parseFloat(fields[7]);
    const gpsLng         = parseFloat(fields[8]);
    const roll           = parseFloat(fields[9]);
    const pitch          = parseFloat(fields[10]);
    const yaw            = parseFloat(fields[11]);

    // ── Validate numeric fields ──
    const numerics = [altitude, pressure, temperature, descentRate,
                      batteryVoltage, gpsLat, gpsLng, roll, pitch, yaw];
    for (const val of numerics) {
      if (isNaN(val)) {
        _stats.parseErrors++;
        return { ok: false, error: `NaN field in packet: ${rawLine}` };
      }
    }

    // ── Assemble packet object ──
    const timestamp = Date.now();
    const packet = {
      timestamp,
      packetCount,
      altitude,
      pressure,
      temperature,
      descentRate,
      batteryVoltage,
      gpsLat,
      gpsLng,
      roll,
      pitch,
      yaw,
      rawLine,
    };

    // ── Compute fault flags ──
    packet.faultFlags = _computeFaultFlags(packet);

    // ── Infer mission phase ──
    packet.missionPhase = _inferMissionPhase(packet);

    // ── Update stats ──
    _stats.goodPackets++;

    // ── Store in history ──
    _history.push(packet);

    return { ok: true, packet };
  }

  /* ─────────────────────────────────────────────────────────
     FAULT FLAG EXTRACTION
  ───────────────────────────────────────────────────────── */

  /**
   * Derive the 4-digit fault code from current telemetry values.
   *
   * D1 (descentRateFlag):  0=nominal 8–10 m/s, 1=out of bounds
   * D2 (gpsStateFlag):     0=valid fix (lat & lng non-zero), 1=no fix / dropped
   * D3 (separationFlag):   Not directly measurable from sensor data alone.
   *                        Here we infer: if altitude > 20m and descentRate > 15 (freefall)
   *                        then parachute hasn't deployed — potential separation failure.
   *                        This can be overridden by external bitflag in the packet if
   *                        the firmware transmits a dedicated field.
   * D4 (parachuteFlag):    0=inactive (not in descent or descent rate nominal),
   *                        1=deployed (descent rate within parachute range 8–10 m/s)
   *
   * @param {object} packet - Parsed telemetry packet
   * @returns {{ descentRateFlag, gpsStateFlag, separationFlag, parachuteFlag }}
   */
  function _computeFaultFlags(packet) {
    const { altitude, descentRate, gpsLat, gpsLng } = packet;

    // D1 — Descent Rate Violation
    // Flag if descending (rate > 0) but outside nominal 8–10 m/s range
    let descentRateFlag = 0;
    if (descentRate > 0) {
      // Actively descending
      if (descentRate < 8.0 || descentRate > 10.0) {
        descentRateFlag = 1;
      }
    }

    // D2 — GPS State
    // Flag if both lat and lng are zero (common no-fix sentinel) or clearly invalid
    let gpsStateFlag = 0;
    const latAbsZero = Math.abs(gpsLat) < 0.0001;
    const lngAbsZero = Math.abs(gpsLng) < 0.0001;
    if (latAbsZero && lngAbsZero) {
      gpsStateFlag = 1;
    }
    // Also flag if out of valid geographic range
    if (Math.abs(gpsLat) > 90.0 || Math.abs(gpsLng) > 180.0) {
      gpsStateFlag = 1;
    }

    // D3 — Separation failure inference
    // If altitude is significant and descent rate is extremely high (>> 10 m/s),
    // parachute may not have deployed, indicating possible separation failure.
    let separationFlag = 0;
    if (altitude > 50 && descentRate > 20.0) {
      separationFlag = 1;
    }

    // D4 — Parachute deployed (warning / informational)
    // Parachute is considered deployed when descent rate is in nominal range
    // and altitude is positive (actively falling)
    let parachuteFlag = 0;
    if (altitude > 5 && descentRate >= 8.0 && descentRate <= 10.0) {
      parachuteFlag = 1;
    }

    return { descentRateFlag, gpsStateFlag, separationFlag, parachuteFlag };
  }

  /* ─────────────────────────────────────────────────────────
     MISSION PHASE INFERENCE
  ───────────────────────────────────────────────────────── */

  /**
   * Infer the current mission phase based on altitude trajectory.
   * @param {object} packet
   * @returns {string} phase name
   */
  function _inferMissionPhase(packet) {
    const { altitude, descentRate } = packet;

    if (!_hasLaunched) {
      if (altitude > LAUNCH_THRESHOLD_M) {
        _hasLaunched = true;
        _missionPhase = 'ASCENT';
      } else {
        _missionPhase = 'STANDBY';
      }
    } else {
      if (_missionPhase === 'ASCENT' || _missionPhase === 'APOGEE') {
        if (descentRate > 2.0 && _prevAltitude !== null && altitude < _prevAltitude) {
          // Detected descent
          if (_missionPhase === 'ASCENT') {
            _altitudeAtApogee = _prevAltitude;
            _missionPhase = 'APOGEE';
          } else {
            _missionPhase = 'DESCENT';
          }
        } else if (_missionPhase === 'APOGEE' && descentRate > 0.5) {
          _missionPhase = 'DESCENT';
        }
      } else if (_missionPhase === 'DESCENT') {
        // Detect landing: very low altitude and very low descent rate
        if (altitude <= LANDED_ALT_MARGIN && Math.abs(descentRate) < 0.5) {
          _missionPhase = 'LANDED';
        }
      } else if (_missionPhase === 'LANDED') {
        // Once landed, remain landed (recovery phase transition is manual)
        _missionPhase = 'LANDED';
      }
    }

    _prevAltitude = altitude;
    return _missionPhase;
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC INTERFACE — PROCESS A LINE
  ───────────────────────────────────────────────────────── */

  /**
   * Process a raw line from the serial stream.
   * Logs to console, dispatches to all downstream modules.
   * @param {string} rawLine
   */
  function processLine(rawLine) {
    // Always log raw data to console
    UI.logConsole(rawLine, 'data');

    // Parse the line
    const result = parseLine(rawLine);

    if (!result.ok) {
      UI.logConsole(`[TELEM] Parse error: ${result.error}`, 'error');
      UI.updateHealthStats(_stats);
      return;
    }

    const { packet } = result;

    // ── Dispatch to UI ──
    UI.updateTelemetryValues(packet);
    UI.updateFaultAnnunciators(packet.faultFlags);
    UI.setMissionPhase(packet.missionPhase);
    UI.updateHealthStats(_stats);

    // Start mission elapsed timer on first good packet
    if (_stats.goodPackets === 1) {
      UI.startMissionElapsedTimer();
    }

    // ── Dispatch to Charts ──
    Charts.addDataPoint(packet);

    // ── Dispatch to Map ──
    MapModule.updatePosition(packet.gpsLat, packet.gpsLng, packet.altitude);

    // ── Dispatch to Attitude Viewer ──
    AttitudeViewer.updateOrientation(packet.roll, packet.pitch, packet.yaw);
  }

  /* ─────────────────────────────────────────────────────────
     SESSION RESET
  ───────────────────────────────────────────────────────── */
  function resetSession() {
    _stats = {
      totalPackets:  0,
      goodPackets:   0,
      parseErrors:   0,
      checksumFails: 0,
    };
    _history.length       = 0;
    _prevAltitude         = null;
    _missionPhase         = 'STANDBY';
    _altitudeAtApogee     = null;
    _hasLaunched          = false;
  }

  /* ─────────────────────────────────────────────────────────
     DATA EXPORT
  ───────────────────────────────────────────────────────── */

  /**
   * Export the session history as a CSV string.
   * @returns {string} CSV text
   */
  function exportCsv() {
    if (_history.length === 0) return '';

    const headers = [
      'timestamp_ms', 'packet_count', 'altitude_m', 'pressure_hpa',
      'temperature_c', 'descent_rate_ms', 'battery_v',
      'gps_lat', 'gps_lng', 'roll_deg', 'pitch_deg', 'yaw_deg',
      'mission_phase', 'fault_d1', 'fault_d2', 'fault_d3', 'fault_d4',
    ];

    const rows = _history.map(p => [
      p.timestamp,
      p.packetCount,
      p.altitude.toFixed(4),
      p.pressure.toFixed(4),
      p.temperature.toFixed(4),
      p.descentRate.toFixed(4),
      p.batteryVoltage.toFixed(4),
      p.gpsLat.toFixed(8),
      p.gpsLng.toFixed(8),
      p.roll.toFixed(4),
      p.pitch.toFixed(4),
      p.yaw.toFixed(4),
      p.missionPhase,
      p.faultFlags.descentRateFlag,
      p.faultFlags.gpsStateFlag,
      p.faultFlags.separationFlag,
      p.faultFlags.parachuteFlag,
    ].join(','));

    return [headers.join(','), ...rows].join('\r\n');
  }

  /**
   * Export the session history as a JSON string.
   * @returns {string} JSON text
   */
  function exportJson() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      stats:      { ..._stats },
      packets:    _history,
    }, null, 2);
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────── */
  return {
    processLine,
    resetSession,
    exportCsv,
    exportJson,
    getHistory:   () => [..._history],
    getStats:     () => ({ ..._stats }),
    getMissionPhase: () => _missionPhase,
    validateChecksum,
    parseLine,
  };

})();
