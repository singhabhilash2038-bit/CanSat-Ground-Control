/**
 * attitude.js — CanSat GCS Three.js 3D Attitude Visualizer
 * Renders a detailed CanSat vehicle model in a WebGL viewport.
 * Translates Roll, Pitch, Yaw Euler angles (in degrees) into
 * proper aerospace-reference-frame spatial rotations using Three.js.
 *
 * Aerospace Reference Frame (NED — North-East-Down):
 *   Roll  (φ) — rotation about body X-axis (longitudinal)
 *   Pitch (θ) — rotation about body Y-axis (lateral)
 *   Yaw   (ψ) — rotation about body Z-axis (normal/vertical)
 *
 * Three.js convention:
 *   X → right, Y → up, Z → out of screen
 * Mapping applied: Roll → X, Pitch → Z, Yaw → Y
 */

'use strict';

const AttitudeViewer = (() => {

  /* ─────────────────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────────────────── */
  let _scene        = null;
  let _camera       = null;
  let _renderer     = null;
  let _canSatGroup  = null;   // Group containing all CanSat geometry
  let _animFrameId  = null;
  let _isInit       = false;

  // Target Euler angles (degrees), smoothed toward actual
  let _targetRoll   = 0;
  let _targetPitch  = 0;
  let _targetYaw    = 0;

  // Smoothed angles (lerped each frame)
  let _smoothRoll   = 0;
  let _smoothPitch  = 0;
  let _smoothYaw    = 0;

  const LERP_FACTOR = 0.08; // Smoothing factor (0=no move, 1=instant)
  const DEG_TO_RAD  = Math.PI / 180;

  /* ─────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────── */
  function _lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * Linearly interpolate two angles accounting for the 360°/−180° wrap.
   */
  function _lerpAngle(a, b, t) {
    let delta = ((b - a + 540) % 360) - 180;
    return a + delta * t;
  }

  /* ─────────────────────────────────────────────────────────
     SCENE SETUP
  ───────────────────────────────────────────────────────── */

  /**
   * Initialize the Three.js scene, camera, renderer, lights, and model.
   */
  function init() {
    if (_isInit) return;
    if (typeof THREE === 'undefined') {
      console.error('[AttitudeViewer] Three.js not loaded.');
      return;
    }

    const canvas = document.getElementById('attitude-canvas');
    if (canvas) {
      const container = canvas.parentElement;
      const W = container.clientWidth  || 320;
      const H = container.clientHeight || 220;

      // ── Renderer ──
      _renderer = new THREE.WebGLRenderer({
        canvas:     canvas,
        antialias:  true,
        alpha:      true,
      });
      _renderer.setSize(W, H, false);
      _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      _renderer.setClearColor(new THREE.Color(getComputedStyle(document.body).getPropertyValue('--renderer-bg-color').trim() || 0x000000), 1);
      _renderer.shadowMap.enabled = true;
      _renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

      // ── Scene ──
      _scene = new THREE.Scene();
      _scene.background = new THREE.Color(0x050810);
      _scene.fog = new THREE.FogExp2(0x050810, 0.04);

      // ── Camera ──
      _camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
      _camera.position.set(2.5, 1.8, 3.5);
      _camera.lookAt(0, 0, 0);

      // ── Lighting ──
      _setupLighting();

      // ── Reference Grid ──
      _addReferenceGrid();

      // ── Coordinate Axes Helper ──
      _addAxesHelper();

      // ── CanSat Model ──
      _canSatGroup = new THREE.Group();
      _buildCanSatModel(_canSatGroup);
      _scene.add(_canSatGroup);

      // ── Handle Resize ──
      window.addEventListener('resize', _onResize);

      // ── Start Render Loop ──
      _renderLoop();

      _isInit = true;
      console.info('[AttitudeViewer] Three.js scene initialized.');
    } else {
      console.error('[AttitudeViewer] #attitude-canvas not found. Initialization aborted.');
    }
  }

  /* ─────────────────────────────────────────────────────────
     LIGHTING SETUP
  ───────────────────────────────────────────────────────── */
  function _setupLighting() {
    // Ambient — fills shadow areas with dim blue-tinted light
    const ambient = new THREE.AmbientLight(0x1a2040, 0.8);
    _scene.add(ambient);

    // Key light — main directional light from upper-left
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(4, 6, 5);
    keyLight.castShadow          = true;
    keyLight.shadow.mapSize.width  = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.camera.near  = 0.1;
    keyLight.shadow.camera.far   = 30;
    keyLight.shadow.camera.left  = -5;
    keyLight.shadow.camera.right =  5;
    keyLight.shadow.camera.top   =  5;
    keyLight.shadow.camera.bottom = -5;
    _scene.add(keyLight);

    // Fill light — softer, from the right-rear
    const fillLight = new THREE.DirectionalLight(0x3355ff, 0.4);
    fillLight.position.set(-3, 2, -4);
    _scene.add(fillLight);

    // Rim light — orange-amber from below-front to highlight edges
    const rimLight = new THREE.DirectionalLight(0xF5A623, 0.3);
    rimLight.position.set(0, -3, 3);
    _scene.add(rimLight);

    // Hemisphere light — sky/ground gradient
    const hemi = new THREE.HemisphereLight(0x0044aa, 0x001122, 0.3);
    _scene.add(hemi);

    // Point light — cyan glow at top of CanSat
    const topGlow = new THREE.PointLight(0x00D4FF, 0.8, 4);
    topGlow.position.set(0, 1.5, 0);
    _scene.add(topGlow);
  }

  /* ─────────────────────────────────────────────────────────
     REFERENCE GRID
  ───────────────────────────────────────────────────────── */
  function _addReferenceGrid() {
    const gridHelper = new THREE.GridHelper(8, 16, 0x0a1020, 0x0d1830);
    gridHelper.position.y = -1.5;
    _scene.add(gridHelper);
  }

  /* ─────────────────────────────────────────────────────────
     AXES HELPER
  ───────────────────────────────────────────────────────── */
  function _addAxesHelper() {
    // Custom colored axes lines (XYZ = RGB)
    const axesMat = [
      { dir: new THREE.Vector3(1,0,0), color: 0xFF4444 }, // X = Roll (red)
      { dir: new THREE.Vector3(0,1,0), color: 0x44FF44 }, // Y = Yaw  (green)
      { dir: new THREE.Vector3(0,0,1), color: 0x4444FF }, // Z = Pitch (blue)
    ];

    axesMat.forEach(({ dir, color }) => {
      const points = [new THREE.Vector3(0,0,0), dir.clone().multiplyScalar(1.2)];
      const geo    = new THREE.BufferGeometry().setFromPoints(points);
      const mat    = new THREE.LineBasicMaterial({ color });
      const line   = new THREE.Line(geo, mat);
      _scene.add(line);
    });

    // Axis labels as sprites would require a font loader,
    // so we use simple axis-end sphere markers instead
    const labelPositions = [
      { pos: [1.3, 0, 0],   color: 0xFF4444 }, // +X
      { pos: [0, 1.3, 0],   color: 0x44FF44 }, // +Y
      { pos: [0, 0, 1.3],   color: 0x4444FF }, // +Z
    ];

    labelPositions.forEach(({ pos, color }) => {
      const geo  = new THREE.SphereGeometry(0.04, 8, 8);
      const mat  = new THREE.MeshBasicMaterial({ color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...pos);
      _scene.add(mesh);
    });
  }

  /* ─────────────────────────────────────────────────────────
     CANSAT 3D MODEL CONSTRUCTION
  ───────────────────────────────────────────────────────── */

  /**
   * Build a stylized CanSat vehicle model.
   * CanSat is cylindrical with fins and a nose cone.
   * @param {THREE.Group} group - Parent group to add meshes to
   */
  function _buildCanSatModel(group) {
    // ── Materials ──
    const bodyMat = new THREE.MeshStandardMaterial({
      color:       0x2a3a5a,
      metalness:   0.7,
      roughness:   0.3,
      envMapIntensity: 1.0,
    });

    const accentMat = new THREE.MeshStandardMaterial({
      color:     0xF5A623,
      metalness: 0.8,
      roughness: 0.2,
      emissive:  0x3a2000,
      emissiveIntensity: 0.3,
    });

    const noseMat = new THREE.MeshStandardMaterial({
      color:    0xe8edf5,
      metalness: 0.6,
      roughness: 0.4,
    });

    const sensorMat = new THREE.MeshStandardMaterial({
      color:      0x00D4FF,
      metalness:  0.3,
      roughness:  0.7,
      emissive:   0x003344,
      emissiveIntensity: 0.5,
    });

    const finMat = new THREE.MeshStandardMaterial({
      color:     0x1a2a3a,
      metalness: 0.5,
      roughness: 0.5,
      side:      THREE.DoubleSide,
    });

    const glassMat = new THREE.MeshStandardMaterial({
      color:       0x0088aa,
      metalness:   0.1,
      roughness:   0.0,
      transparent: true,
      opacity:     0.4,
    });

    // ── Main Cylindrical Body ──
    const bodyRadius = 0.33;
    const bodyHeight = 1.2;
    const bodyGeo  = new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyHeight, 32);
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.y = 0;
    bodyMesh.castShadow    = true;
    bodyMesh.receiveShadow = true;
    group.add(bodyMesh);

    // ── Nose Cone (top) ──
    const noseGeo  = new THREE.ConeGeometry(bodyRadius, 0.5, 32);
    const noseMesh = new THREE.Mesh(noseGeo, noseMat);
    noseMesh.position.y = bodyHeight / 2 + 0.25;
    noseMesh.castShadow = true;
    group.add(noseMesh);

    // ── Bottom Dome / Endcap ──
    const domeGeo  = new THREE.SphereGeometry(bodyRadius, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    const domeMesh = new THREE.Mesh(domeGeo, noseMat);
    domeMesh.rotation.x = Math.PI;
    domeMesh.position.y = -bodyHeight / 2;
    domeMesh.castShadow = true;
    group.add(domeMesh);

    // ── Accent Ring (upper) ──
    const ringGeo1  = new THREE.TorusGeometry(bodyRadius + 0.01, 0.025, 12, 64);
    const ringMesh1 = new THREE.Mesh(ringGeo1, accentMat);
    ringMesh1.rotation.x = Math.PI / 2;
    ringMesh1.position.y = bodyHeight / 2 - 0.08;
    group.add(ringMesh1);

    // ── Accent Ring (lower) ──
    const ringGeo2  = new THREE.TorusGeometry(bodyRadius + 0.01, 0.025, 12, 64);
    const ringMesh2 = new THREE.Mesh(ringGeo2, accentMat);
    ringMesh2.rotation.x = Math.PI / 2;
    ringMesh2.position.y = -bodyHeight / 2 + 0.08;
    group.add(ringMesh2);

    // ── Center band ──
    const bandGeo  = new THREE.CylinderGeometry(bodyRadius + 0.012, bodyRadius + 0.012, 0.06, 32);
    const bandMesh = new THREE.Mesh(bandGeo, accentMat);
    bandMesh.position.y = 0;
    group.add(bandMesh);

    // ── Four Stabilizing Fins ──
    const finCount   = 4;
    const finAngleStep = (Math.PI * 2) / finCount;
    const finHeight  = 0.4;
    const finWidth   = 0.25;
    const finThick   = 0.015;

    for (let i = 0; i < finCount; i++) {
      const angle    = i * finAngleStep;
      const finGeo   = new THREE.BoxGeometry(finThick, finHeight, finWidth);
      const finMesh  = new THREE.Mesh(finGeo, finMat);

      // Position along the body perimeter
      finMesh.position.x = Math.sin(angle) * (bodyRadius + finWidth / 2 - 0.05);
      finMesh.position.z = Math.cos(angle) * (bodyRadius + finWidth / 2 - 0.05);
      finMesh.position.y = -bodyHeight / 2 + finHeight / 2 + 0.05;
      finMesh.rotation.y = angle;
      finMesh.castShadow  = true;
      group.add(finMesh);
    }

    // ── GPS Antenna stub (top of nose) ──
    const antGeo  = new THREE.CylinderGeometry(0.015, 0.015, 0.18, 8);
    const antMesh = new THREE.Mesh(antGeo, sensorMat);
    antMesh.position.y = bodyHeight / 2 + 0.5 + 0.09;
    antMesh.castShadow = true;
    group.add(antMesh);

    // Antenna ball
    const antBallGeo  = new THREE.SphereGeometry(0.03, 12, 12);
    const antBallMesh = new THREE.Mesh(antBallGeo, sensorMat);
    antBallMesh.position.y = bodyHeight / 2 + 0.5 + 0.19;
    group.add(antBallMesh);

    // ── Sensor Window / PCB viewport (side panel) ──
    const windowGeo  = new THREE.BoxGeometry(0.01, 0.2, 0.18);
    const windowMesh = new THREE.Mesh(windowGeo, glassMat);
    windowMesh.position.set(bodyRadius - 0.01, 0.1, 0);
    group.add(windowMesh);

    // ── Small status LED points ──
    const ledColors = [0x00FF44, 0xFF4444, 0xFFAA00];
    ledColors.forEach((color, idx) => {
      const ledGeo = new THREE.SphereGeometry(0.018, 8, 8);
      const ledMat = new THREE.MeshBasicMaterial({ color });
      const ledMesh = new THREE.Mesh(ledGeo, ledMat);
      ledMesh.position.set(bodyRadius, 0.35 - idx * 0.12, 0);
      group.add(ledMesh);

      // Glow effect: point light for each LED
      const ledLight = new THREE.PointLight(color, 0.2, 0.6);
      ledLight.position.copy(ledMesh.position);
      group.add(ledLight);
    });

    // ── Parachute compartment ring (top of body) ──
    const chuteRingGeo  = new THREE.CylinderGeometry(bodyRadius + 0.02, bodyRadius + 0.02, 0.12, 32);
    const chuteRingMesh = new THREE.Mesh(chuteRingGeo, noseMat);
    chuteRingMesh.position.y = bodyHeight / 2 + 0.06;
    group.add(chuteRingMesh);

    // ── Slow idle rotation baseline removed — orientation controlled externally ──
    // The group is positioned centered at origin for clean rotation.
    group.position.set(0, 0, 0);
  }

  /* ─────────────────────────────────────────────────────────
     RENDER LOOP
  ───────────────────────────────────────────────────────── */
  function _renderLoop() {
    _animFrameId = requestAnimationFrame(_renderLoop);

    if (!_canSatGroup) return;

    // ── Smooth interpolation toward target angles ──
    _smoothRoll  = _lerpAngle(_smoothRoll,  _targetRoll,  LERP_FACTOR);
    _smoothPitch = _lerpAngle(_smoothPitch, _targetPitch, LERP_FACTOR);
    _smoothYaw   = _lerpAngle(_smoothYaw,   _targetYaw,   LERP_FACTOR);

    // ── Apply Euler rotation ──
    // Aerospace convention (NED) mapped to Three.js (Y-up):
    //   Roll  (φ) around body longitudinal axis → Three.js Z axis
    //   Pitch (θ) around body lateral axis      → Three.js X axis
    //   Yaw   (ψ) around body normal axis        → Three.js Y axis (negated for right-hand rule)
    _canSatGroup.rotation.set(
      _smoothPitch * DEG_TO_RAD,   // X: Pitch
      -_smoothYaw  * DEG_TO_RAD,   // Y: Yaw (negated: CW yaw → CCW in left-hand screen space)
      _smoothRoll  * DEG_TO_RAD,   // Z: Roll
      'ZXY'                        // Euler order: Yaw → Pitch → Roll (standard aerospace)
    );

    _renderer.render(_scene, _camera);
  }

  /* ─────────────────────────────────────────────────────────
     RESIZE HANDLER
  ───────────────────────────────────────────────────────── */
  function _onResize() {
    if (!_renderer || !_camera) return;

    const canvas    = document.getElementById('attitude-canvas');
    const container = canvas ? canvas.parentElement : null;
    if (!container) return;

    const W = container.clientWidth;
    const H = container.clientHeight;

    if (W === 0 || H === 0) return;

    _camera.aspect = W / H;
    _camera.updateProjectionMatrix();
    _renderer.setSize(W, H, false);
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC: UPDATE ORIENTATION
  ───────────────────────────────────────────────────────── */

  /**
   * Set the target roll, pitch, yaw angles (in degrees).
   * The render loop will smoothly interpolate toward these values.
   *
   * @param {number} roll  - Roll angle in degrees  (−180 to +180)
   * @param {number} pitch - Pitch angle in degrees (−90  to +90)
   * @param {number} yaw   - Yaw angle in degrees   (0    to 360)
   */
  function updateOrientation(roll, pitch, yaw) {
    if (isNaN(roll) || isNaN(pitch) || isNaN(yaw)) return;

    _targetRoll  = roll;
    _targetPitch = pitch;
    _targetYaw   = yaw;
  }

  /* ─────────────────────────────────────────────────────────
     RESET
  ───────────────────────────────────────────────────────── */
  function resetOrientation() {
    _targetRoll  = 0;
    _targetPitch = 0;
    _targetYaw   = 0;
    _smoothRoll  = 0;
    _smoothPitch = 0;
    _smoothYaw   = 0;
  }

  /* ─────────────────────────────────────────────────────────
     CLEANUP
  ───────────────────────────────────────────────────────── */
  function dispose() {
    if (_animFrameId !== null) {
      cancelAnimationFrame(_animFrameId);
      _animFrameId = null;
    }
    if (_renderer) {
      _renderer.dispose();
      _renderer = null;
    }
    window.removeEventListener('resize', _onResize);
    _isInit = false;
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────── */
  return {
    init,
    updateOrientation,
    resetOrientation,
    dispose,
    getScene:    () => _scene,
    getRenderer: () => _renderer,
  };

})();
