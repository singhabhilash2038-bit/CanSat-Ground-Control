/**
 * simulator.js — CanSat GCS In-Browser Flight Simulator
 *
 * Generates a complete, physically plausible CanSat mission entirely
 * inside the browser with no hardware required. Packets are built with
 * proper XOR checksums and injected directly into Telemetry.processLine()
 * at a user-configurable rate (0.5×, 1×, 2×, 5×, 10× real-time).
 *
 * Mission Profile (configurable launch point):
 *   Phase 0 — PRE-LAUNCH    (standby, engines cold)
 *   Phase 1 — ASCENT        (balloon lifts CanSat; ~5 m/s upward)
 *   Phase 2 — APOGEE        (brief coast at peak altitude ~500 m)
 *   Phase 3 — FREE-FALL     (separation event; ~25 m/s descent)
 *   Phase 4 — PARACHUTE     (chute deploys; ~9 m/s nominal descent)
 *   Phase 5 — LANDING       (ground impact, sensors settle)
 *   Phase 6 — RECOVERY      (static ground data)
 *
 * Sensor noise model:
 *   All sensor values have gaussian-approximated white noise applied.
 *   GPS drifts realistically based on altitude (more drift at speed).
 *   IMU angles follow a smooth Euler trajectory with disturbance events.
 *   Battery voltage drains slowly over mission duration.
 *   Pressure computed from altitude via the International Standard Atmosphere.
 *   Temperature lapse rate applied (ISA: −6.5°C per 1000 m).
 */

'use strict';

const Simulator = (() => {

  /* ─────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────── */
  const SEA_LEVEL_PRESSURE    = 1013.25;  // hPa
  const SEA_LEVEL_TEMP_K      = 288.15;   // Kelvin (15°C)
  const TEMP_LAPSE_RATE       = 0.0065;   // K/m
  const GRAVITY               = 9.80665;  // m/s²
  const MOLAR_MASS_AIR        = 0.028964; // kg/mol
  const GAS_CONSTANT          = 8.31446;  // J/(mol·K)
  const EARTH_RADIUS_M        = 6371000;  // metres

  // Degrees per metre at equator (approximate)
  const DEG_PER_METRE_LAT = 1 / 111320;
  const DEG_PER_METRE_LNG = 1 / 111320; // simplified (equatorial)

  /* ─────────────────────────────────────────────────────────
     MISSION PHASE DEFINITIONS
     Each phase drives altitude / attitude / sensor behaviour.
  ───────────────────────────────────────────────────────── */
  const PHASES = {
    PRE_LAUNCH: 0,
    ASCENT:     1,
    APOGEE:     2,
    FREE_FALL:  3,
    PARACHUTE:  4,
    LANDING:    5,
    RECOVERY:   6,
  };

  /* ─────────────────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────────────────── */
  let _running        = false;
  let _timerId        = null;
  let _packetCount    = 0;
  let _simTimeMs      = 0;      // Simulated mission time in milliseconds
  let _realIntervalMs = 1000;   // Real-time milliseconds between packets
  let _speedMultiplier = 1.0;   // How many seconds of sim-time per real second

  // Physical state vector
  let _altitude       = 0.0;    // metres AGL
  let _verticalVel    = 0.0;    // m/s (positive = upward)
  let _descentRate    = 0.0;    // m/s (positive = downward, for display)
  let _currentPhase   = PHASES.PRE_LAUNCH;

  // Attitude state (degrees)
  let _roll     = 0.0;
  let _pitch    = 0.0;
  let _yaw      = 0.0;
  let _rollRate  = 0.0;   // deg/s
  let _pitchRate = 0.0;   // deg/s
  let _yawRate   = 0.0;   // deg/s

  // GPS state
  let _gpsLat         = 0.0;
  let _gpsLng         = 0.0;
  let _gpsVelNorth    = 0.0;   // m/s northward drift
  let _gpsVelEast     = 0.0;   // m/s eastward drift
  let _gpsDropped     = false;

  // Battery
  let _batteryVoltage = 4.20;   // V, drains over mission

  // Callbacks
  let _onPacketCallback    = null;
  let _onPhaseChange       = null;
  let _onSimComplete       = null;

  // Mission config (set at start)
  let _cfg = {};

  // Timers for phase transitions (sim-time seconds)
  let _phaseStartTimeS  = 0;
  let _apogeeAltitude   = 0;

  /* ─────────────────────────────────────────────────────────
     NOISE UTILITIES
  ───────────────────────────────────────────────────────── */

  /**
   * Box-Muller gaussian random number (mean=0, std=1).
   */
  function _randn() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  /**
   * Apply gaussian noise with given standard deviation.
   * @param {number} value - Clean value
   * @param {number} sigma - Noise standard deviation
   */
  function _addNoise(value, sigma) {
    return value + _randn() * sigma;
  }

  /**
   * Clamp a value between min and max.
   */
  function _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /* ─────────────────────────────────────────────────────────
     PHYSICS: INTERNATIONAL STANDARD ATMOSPHERE
  ───────────────────────────────────────────────────────── */

  /**
   * Compute ambient pressure (hPa) at a given altitude (m) using ISA.
   * Valid for troposphere (0–11,000 m).
   * @param {number} altM - Altitude in metres AGL
   * @returns {number}    - Pressure in hPa
   */
  function _altitudeToPressure(altM) {
    const T = SEA_LEVEL_TEMP_K - TEMP_LAPSE_RATE * altM;
    const exponent = (GRAVITY * MOLAR_MASS_AIR) / (GAS_CONSTANT * TEMP_LAPSE_RATE);
    const pressure = SEA_LEVEL_PRESSURE * Math.pow(T / SEA_LEVEL_TEMP_K, exponent);
    return pressure;
  }

  /**
   * Compute ambient temperature (°C) at a given altitude (m) using ISA.
   * @param {number} altM - Altitude in metres AGL
   * @returns {number}    - Temperature in °C
   */
  function _altitudeToTemperature(altM) {
    const T_K = SEA_LEVEL_TEMP_K - TEMP_LAPSE_RATE * altM;
    return T_K - 273.15;
  }

  /* ─────────────────────────────────────────────────────────
     PHYSICS: PHASE STEP
  ───────────────────────────────────────────────────────── */

  /**
   * Advance the simulation by one time step (dtS seconds of sim time).
   * Updates altitude, attitude, GPS, battery, and phase.
   * @param {number} dtS - Time step in seconds (simulated)
   */
  function _stepPhysics(dtS) {
    const simTimeS = _simTimeMs / 1000;

    // ── Phase logic ──
    switch (_currentPhase) {

      case PHASES.PRE_LAUNCH: {
        // CanSat is stationary. After 3 seconds, launch.
        _altitude     = 0;
        _verticalVel  = 0;
        _descentRate  = 0;
        _rollRate     = _addNoise(0, 0.05);
        _pitchRate    = _addNoise(0, 0.05);
        _yawRate      = _addNoise(0, 0.1);

        if (simTimeS - _phaseStartTimeS >= 3.0) {
          _enterPhase(PHASES.ASCENT, simTimeS);
        }
        break;
      }

      case PHASES.ASCENT: {
        // Balloon ascent: ~5 m/s up, slightly varying
        const targetVel = 5.0 + _addNoise(0, 0.3);
        _verticalVel   = _lerp(_verticalVel, targetVel, 0.05);
        _altitude      += _verticalVel * dtS;
        _descentRate    = -_verticalVel; // negative = ascending

        // Slow yaw rotation during ascent (balloon spin)
        _yawRate  = 8.0 + _addNoise(0, 1.0);   // ~8 deg/s
        _rollRate  = _addNoise(0, 0.5);
        _pitchRate = _addNoise(0, 0.3);

        // GPS drifts slowly in wind
        _gpsVelNorth  = _addNoise(0.3, 0.1);  // slight north drift (wind)
        _gpsVelEast   = _addNoise(0.1, 0.1);

        // Target apogee: cfg.apogeeAlt metres
        if (_altitude >= _cfg.apogeeAlt * 0.98) {
          _apogeeAltitude = _altitude;
          _enterPhase(PHASES.APOGEE, simTimeS);
        }
        break;
      }

      case PHASES.APOGEE: {
        // Brief coast at apogee (1.5 s)
        _verticalVel = _lerp(_verticalVel, 0, 0.3);
        _altitude   += _verticalVel * dtS;
        _descentRate = -_verticalVel;

        _yawRate  = _addNoise(0, 2.0);
        _rollRate  = _addNoise(0, 1.0);
        _pitchRate = _addNoise(0, 1.0);

        if (simTimeS - _phaseStartTimeS >= 1.5) {
          _enterPhase(PHASES.FREE_FALL, simTimeS);
        }
        break;
      }

      case PHASES.FREE_FALL: {
        // Separation event — CanSat free-falls at terminal velocity ~25 m/s
        // Accelerate downward up to terminal velocity
        const terminalVel = -25.0;
        _verticalVel = _lerp(_verticalVel, terminalVel, 0.12);
        _altitude   += _verticalVel * dtS;
        _descentRate = -_verticalVel;

        // Tumbling: increased rates
        _rollRate  = _cfg.tumblingRoll  + _addNoise(0, 5.0);
        _pitchRate = _cfg.tumblingPitch + _addNoise(0, 3.0);
        _yawRate   = 20.0 + _addNoise(0, 5.0);

        // GPS drifts faster (higher horizontal speed due to wind)
        _gpsVelNorth = 2.0 + _addNoise(0, 0.5);
        _gpsVelEast  = 1.5 + _addNoise(0, 0.5);

        // Parachute deploys at configured altitude
        if (_altitude <= _cfg.chuteDeployAlt) {
          _enterPhase(PHASES.PARACHUTE, simTimeS);
        }
        break;
      }

      case PHASES.PARACHUTE: {
        // Chute deployed: nominal 8–10 m/s descent
        const targetDescentMs = _cfg.nominalDescentRate + _addNoise(0, 0.2);
        _verticalVel = _lerp(_verticalVel, -targetDescentMs, 0.08);
        _altitude   += _verticalVel * dtS;
        _descentRate = -_verticalVel;

        // Gentle swaying under canopy
        _rollRate  = _addNoise(0, 1.5);
        _pitchRate = _addNoise(0, 1.0);
        _yawRate   = _addNoise(2.0, 1.0);   // slow rotation under chute

        // GPS drift (horizontal wind carries CanSat)
        _gpsVelNorth = 1.2 + _addNoise(0, 0.3);
        _gpsVelEast  = 0.8 + _addNoise(0, 0.3);

        // Battery drains slightly faster when radio is active
        _batteryVoltage -= 0.00005 * dtS;

        if (_altitude <= 0.5) {
          _altitude    = 0.0;
          _verticalVel = 0.0;
          _enterPhase(PHASES.LANDING, simTimeS);
        }
        break;
      }

      case PHASES.LANDING: {
        // Impact + bounce + settle (3 seconds)
        const phaseElapsed = simTimeS - _phaseStartTimeS;

        if (phaseElapsed < 0.5) {
          // Impact bounce
          _altitude    = _addNoise(0.3, 0.2);
          _rollRate    = _addNoise(0, 30);
          _pitchRate   = _addNoise(0, 30);
          _yawRate     = _addNoise(0, 20);
        } else if (phaseElapsed < 1.5) {
          // Settle
          _altitude    = _lerp(_altitude, 0.0, 0.2);
          _rollRate    = _lerp(_rollRate, 0, 0.3);
          _pitchRate   = _lerp(_pitchRate, 0, 0.3);
          _yawRate     = _lerp(_yawRate, 0, 0.3);
        } else {
          _altitude    = _addNoise(0.02, 0.01);
          _rollRate    = _addNoise(0, 0.1);
          _pitchRate   = _addNoise(0, 0.1);
          _yawRate     = _addNoise(0, 0.1);
          _enterPhase(PHASES.RECOVERY, simTimeS);
        }
        _descentRate = 0;
        _gpsVelNorth = 0;
        _gpsVelEast  = 0;
        break;
      }

      case PHASES.RECOVERY: {
        // CanSat is on the ground. Static data.
        _altitude    = _addNoise(0.02, 0.01);
        _descentRate = 0;
        _verticalVel = 0;
        _rollRate    = _addNoise(0, 0.08);
        _pitchRate   = _addNoise(0, 0.08);
        _yawRate     = _addNoise(0, 0.05);
        _gpsVelNorth = 0;
        _gpsVelEast  = 0;

        // Stop after configured recovery duration
        if (simTimeS - _phaseStartTimeS >= _cfg.recoveryDurationS) {
          _stopSimulation(true);
          return;
        }
        break;
      }

      default:
        break;
    }

    // ── Integrate attitude angles ──
    _roll  += _rollRate  * dtS;
    _pitch += _pitchRate * dtS;
    _yaw   += _yawRate   * dtS;

    // Normalise angles to [-180, 180] and [0, 360] respectively
    _roll  = _normaliseAngle180(_roll);
    _pitch = _clamp(_pitch, -90, 90);
    _yaw   = ((_yaw % 360) + 360) % 360;

    // ── Integrate GPS ──
    const altFactor = Math.max(0, _altitude) / 1000; // Higher = bigger drift
    const noiseFactor = (1.0 + altFactor * 0.5);

    _gpsLat += (_gpsVelNorth * DEG_PER_METRE_LAT * dtS)
             + _addNoise(0, 0.000003 * noiseFactor);
    _gpsLng += (_gpsVelEast  * DEG_PER_METRE_LNG * dtS)
             + _addNoise(0, 0.000003 * noiseFactor);

    // ── GPS drop simulation (brief outages) ──
    // Small random chance of GPS drop during free-fall
    if (_currentPhase === PHASES.FREE_FALL && Math.random() < 0.03) {
      _gpsDropped = true;
    } else if (_gpsDropped && Math.random() < 0.4) {
      _gpsDropped = false;
    }

    // ── Battery drain ──
    _batteryVoltage -= 0.000008 * dtS;
    _batteryVoltage  = Math.max(3.0, _batteryVoltage);
    _altitude        = Math.max(0, _altitude);
  }

  /**
   * Enter a new mission phase, logging the transition.
   */
  function _enterPhase(phase, simTimeS) {
    const phaseNames = ['PRE_LAUNCH','ASCENT','APOGEE','FREE_FALL','PARACHUTE','LANDING','RECOVERY'];
    const prev = _currentPhase;
    _currentPhase    = phase;
    _phaseStartTimeS = simTimeS;

    if (typeof _onPhaseChange === 'function') {
      _onPhaseChange(phaseNames[prev], phaseNames[phase], _altitude);
    }
  }

  /**
   * Wrap an angle to the range [-180, 180].
   */
  function _normaliseAngle180(deg) {
    let d = deg % 360;
    if (d > 180)  d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  /**
   * Linear interpolate.
   */
  function _lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /* ─────────────────────────────────────────────────────────
     PACKET BUILDER
  ───────────────────────────────────────────────────────── */

  /**
   * Compute the XOR checksum for the body string (between $ and *).
   * @param {string} body - Full packet body including '$'
   * @returns {string}    - Two-char uppercase hex checksum
   */
  function _computeChecksum(body) {
    let cs = 0;
    // Skip the leading '$'
    for (let i = 1; i < body.length; i++) {
      cs ^= body.charCodeAt(i);
    }
    return cs.toString(16).toUpperCase().padStart(2, '0');
  }

  /**
   * Build a valid $CSV telemetry packet from current simulation state.
   * Applies sensor noise models appropriate to each phase.
   * @returns {string} - Complete raw packet line with checksum
   */
  function _buildPacket() {
    _packetCount++;

    // ── Sensor noise profiles (varies by phase) ──
    const altNoiseSigma   = _currentPhase === PHASES.FREE_FALL ? 2.0 : 0.3;
    const presNoiseSigma  = 0.08;
    const tempNoiseSigma  = 0.05;
    const drNoiseSigma    = _currentPhase === PHASES.PARACHUTE ? 0.15 : 0.5;
    const voltNoiseSigma  = 0.003;
    const imuNoiseSigma   = _currentPhase === PHASES.FREE_FALL ? 1.5 : 0.3;

    const measAlt    = _addNoise(_altitude,       altNoiseSigma);
    const measPres   = _addNoise(_altitudeToPressure(Math.max(0, _altitude)), presNoiseSigma);
    const measTemp   = _addNoise(_altitudeToTemperature(Math.max(0, _altitude)), tempNoiseSigma);
    const measDr     = _addNoise(Math.max(0, _descentRate), drNoiseSigma);
    const measBatt   = _addNoise(_batteryVoltage, voltNoiseSigma);

    // GPS: if dropped, report 0,0 (no fix sentinel)
    const measLat    = _gpsDropped ? 0.0 : _addNoise(_gpsLat, 0.000005);
    const measLng    = _gpsDropped ? 0.0 : _addNoise(_gpsLng, 0.000005);

    const measRoll   = _addNoise(_roll,  imuNoiseSigma);
    const measPitch  = _addNoise(_pitch, imuNoiseSigma);
    const measYaw    = _addNoise(_yaw,   imuNoiseSigma);

    // ── Build packet body ──
    const body = [
      '$CSV',
      _packetCount,
      measAlt.toFixed(2),
      measPres.toFixed(2),
      measTemp.toFixed(2),
      Math.max(0, measDr).toFixed(2),
      _clamp(measBatt, 3.0, 4.25).toFixed(3),
      measLat.toFixed(8),
      measLng.toFixed(8),
      measRoll.toFixed(2),
      measPitch.toFixed(2),
      measYaw.toFixed(2),
    ].join(',');

    const cs = _computeChecksum(body);
    return `${body}*${cs}`;
  }

  /* ─────────────────────────────────────────────────────────
     SIMULATION TICK
  ───────────────────────────────────────────────────────── */

  /**
   * Called at each real-time interval.
   * Steps simulation time, updates physics, emits packet.
   */
  function _tick() {
    if (!_running) return;

    // Advance simulation time by speedMultiplier seconds
    const simDtS = _speedMultiplier * (_realIntervalMs / 1000);
    _simTimeMs  += _speedMultiplier * _realIntervalMs;

    // Step physics
    _stepPhysics(simDtS);

    // Build and emit packet
    const rawLine = _buildPacket();

    if (typeof _onPacketCallback === 'function') {
      _onPacketCallback(rawLine);
    }
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC: START
  ───────────────────────────────────────────────────────── */

  /**
   * Start the flight simulation.
   *
   * @param {object} config - Simulation configuration
   *   @param {number} config.startLat            - Launch site latitude  (e.g. 12.9716)
   *   @param {number} config.startLng            - Launch site longitude (e.g. 77.5946)
   *   @param {number} config.apogeeAlt           - Target apogee altitude in m (e.g. 500)
   *   @param {number} config.chuteDeployAlt      - Parachute deploy altitude in m (e.g. 350)
   *   @param {number} config.nominalDescentRate  - Target descent rate under chute m/s (e.g. 9)
   *   @param {number} config.tumblingRoll        - Roll rate during free-fall deg/s (e.g. 30)
   *   @param {number} config.tumblingPitch       - Pitch rate during free-fall deg/s (e.g. 20)
   *   @param {number} config.recoveryDurationS   - How many seconds to run after landing (e.g. 10)
   *   @param {number} config.packetIntervalMs    - Real-time ms between packets (e.g. 1000)
   *   @param {number} config.speedMultiplier     - Sim speed multiplier (e.g. 1 = real-time, 5 = 5× faster)
   *   @param {function} config.onPacket          - Callback: (rawLine: string) => void
   *   @param {function} config.onPhaseChange     - Callback: (fromPhase, toPhase, altitude) => void
   *   @param {function} config.onComplete        - Callback: () => void
   */
  function start(config) {
    if (_running) {
      console.warn('[Simulator] Already running. Stop first.');
      return;
    }

    // Apply config with defaults
    _cfg = {
      startLat:           config.startLat           ?? 12.9716,
      startLng:           config.startLng           ?? 77.5946,
      apogeeAlt:          config.apogeeAlt          ?? 500,
      chuteDeployAlt:     config.chuteDeployAlt     ?? 350,
      nominalDescentRate: config.nominalDescentRate ?? 9.0,
      tumblingRoll:       config.tumblingRoll       ?? 30.0,
      tumblingPitch:      config.tumblingPitch      ?? 20.0,
      recoveryDurationS:  config.recoveryDurationS  ?? 15,
      packetIntervalMs:   config.packetIntervalMs   ?? 1000,
      speedMultiplier:    config.speedMultiplier    ?? 1.0,
    };

    _onPacketCallback = config.onPacket     ?? null;
    _onPhaseChange    = config.onPhaseChange ?? null;
    _onSimComplete    = config.onComplete    ?? null;

    // Reset state
    _running          = true;
    _packetCount      = 0;
    _simTimeMs        = 0;
    _realIntervalMs   = _cfg.packetIntervalMs;
    _speedMultiplier  = _cfg.speedMultiplier;
    _altitude         = 0.0;
    _verticalVel      = 0.0;
    _descentRate      = 0.0;
    _currentPhase     = PHASES.PRE_LAUNCH;
    _phaseStartTimeS  = 0;
    _apogeeAltitude   = 0;
    _gpsLat           = _cfg.startLat;
    _gpsLng           = _cfg.startLng;
    _gpsVelNorth      = 0;
    _gpsVelEast       = 0;
    _gpsDropped       = false;
    _roll             = 0.0;
    _pitch            = 0.0;
    _yaw              = Math.random() * 360; // Random initial heading
    _rollRate         = 0.0;
    _pitchRate        = 0.0;
    _yawRate          = 0.0;
    _batteryVoltage   = 4.18 + _addNoise(0, 0.02); // Realistic starting charge

    // Start tick interval
    _timerId = setInterval(_tick, _realIntervalMs);
    console.info(`[Simulator] Started. Speed: ${_speedMultiplier}×, Interval: ${_realIntervalMs}ms, Apogee target: ${_cfg.apogeeAlt}m`);
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC: STOP
  ───────────────────────────────────────────────────────── */

  /**
   * Stop the simulation (manual stop or auto-complete).
   * @param {boolean} [completed] - true if ended naturally (recovery phase done)
   */
  function _stopSimulation(completed) {
    if (!_running) return;
    _running = false;

    if (_timerId !== null) {
      clearInterval(_timerId);
      _timerId = null;
    }

    console.info(`[Simulator] Stopped. Packets emitted: ${_packetCount}. Completed: ${completed}`);

    if (completed && typeof _onSimComplete === 'function') {
      _onSimComplete();
    }
  }

  function stop() {
    _stopSimulation(false);
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC: CHANGE SPEED ON-THE-FLY
  ───────────────────────────────────────────────────────── */

  /**
   * Change the simulation speed multiplier while running.
   * Restarts the interval with the same real-time period, but steps more sim-time.
   * @param {number} mult - New speed multiplier (0.5, 1, 2, 5, 10)
   */
  function setSpeed(mult) {
    _speedMultiplier = mult;
    console.info(`[Simulator] Speed changed to ${mult}×`);
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC: RECEIVE COMMAND
  ───────────────────────────────────────────────────────── */
  
  /**
   * Inject an outbound command into the simulator to force phase transitions.
   * @param {string} cmdString 
   */
  function receiveCommand(cmdString) {
    if (!_running) return;
    
    const cmd = cmdString.trim();
    const simTimeS = _simTimeMs / 1000;

    if (cmd === 'CMD,SEP') {
      console.info('[Simulator] Received manual separation command.');
      if (_currentPhase < PHASES.FREE_FALL) {
        _enterPhase(PHASES.FREE_FALL, simTimeS);
      }
    } else if (cmd === 'CMD,CHUTE') {
      console.info('[Simulator] Received emergency chute command.');
      if (_currentPhase < PHASES.PARACHUTE) {
        _enterPhase(PHASES.PARACHUTE, simTimeS);
      }
    } else if (cmd === 'CMD,RED') {
      console.info('[Simulator] Received redundant activation command.');
      // Force into free fall if not already
      if (_currentPhase < PHASES.FREE_FALL) {
        _enterPhase(PHASES.FREE_FALL, simTimeS);
      }
    }
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────── */
  return {
    start,
    stop,
    setSpeed,
    receiveCommand,
    isRunning:       () => _running,
    getPhase:        () => _currentPhase,
    getPhaseNames:   () => Object.keys(PHASES),
    getPacketCount:  () => _packetCount,
    getAltitude:     () => _altitude,
    getSimTimeMs:    () => _simTimeMs,
  };

})();
