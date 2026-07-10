/**
 * map.js — CanSat GCS Leaflet.js GPS Track Module
 * Initializes OpenStreetMap tile layer, manages live pin tracking,
 * draws a polyline trajectory, and maintains launch site marker.
 */

'use strict';

const MapModule = (() => {

  /* ─────────────────────────────────────────────────────────
     INTERNAL STATE
  ───────────────────────────────────────────────────────── */
  let _map              = null;   // Leaflet map instance
  let _currentMarker    = null;   // Animated current position marker
  let _launchMarker     = null;   // Static launch position marker
  let _trackPolyline    = null;   // Trajectory polyline
  let _trackCoords      = [];     // [ [lat, lng], ... ] history
  let _isInitialized    = false;
  let _launchCoordSet   = false;
  let _lastLat          = null;
  let _lastLng          = null;

  /* ─────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────── */
  const DEFAULT_CENTER = [20.5937, 78.9629]; // Geographic center of India (common CanSat event area)
  const DEFAULT_ZOOM   = 15;
  const TILE_URL       = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const TILE_ATTR      = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const MIN_MOVE_DIST  = 0.000001; // Minimum lat/lng delta to register movement

  /* ─────────────────────────────────────────────────────────
     CUSTOM DIVICON FACTORIES
  ───────────────────────────────────────────────────────── */

  /**
   * Create a DivIcon for the animated current-position marker (CanSat dot).
   */
  function _makeCurrentMarkerIcon() {
    return L.divIcon({
      className: '', // prevent Leaflet's default icon styles
      html:      '<div class="cansat-marker"></div>',
      iconSize:  [14, 14],
      iconAnchor: [7, 7],
    });
  }

  /**
   * Create a DivIcon for the static launch site marker.
   */
  function _makeLaunchMarkerIcon() {
    return L.divIcon({
      className: '',
      html:      '<div class="launch-marker"></div>',
      iconSize:  [12, 12],
      iconAnchor: [6, 6],
    });
  }

  /* ─────────────────────────────────────────────────────────
     INITIALIZATION
  ───────────────────────────────────────────────────────── */

  /**
   * Initialize the Leaflet map instance bound to the #leaflet-map div.
   */
  function init() {
    if (_isInitialized) return;
    if (typeof L === 'undefined') {
      console.error('[MapModule] Leaflet.js not loaded.');
      return;
    }

    const mapContainer = document.getElementById('leaflet-map');
    if (mapContainer) {
      // Create map
      _map = L.map('leaflet-map', {
        center:          DEFAULT_CENTER,
        zoom:            DEFAULT_ZOOM,
        zoomControl:     true,
        attributionControl: true,
      });

      // Add OpenStreetMap tile layer
      L.tileLayer(TILE_URL, {
        attribution:    TILE_ATTR,
        maxZoom:        20,
        minZoom:        3,
        subdomains:     ['a', 'b', 'c'],
      }).addTo(_map);

      // Initialize empty polyline for track
      _trackPolyline = L.polyline([], {
        color:   '#00D4FF',
        weight:  2,
        opacity: 0.8,
        smoothFactor: 1,
        dashArray: null,
      }).addTo(_map);

      // Attribution control positioning
      _map.attributionControl.setPrefix('CanSat GCS');

      _isInitialized = true;
      console.info('[MapModule] Leaflet map initialized.');
    } else {
      console.error('[MapModule] #leaflet-map element not found. Initialization aborted.');
    }
  }

  /* ─────────────────────────────────────────────────────────
     POSITION UPDATE
  ───────────────────────────────────────────────────────── */

  /**
   * Update the map with a new GPS coordinate.
   * - Moves the current-position marker.
   * - Appends the coordinate to the track polyline.
   * - Sets the launch marker on the first valid fix.
   * - Auto-pans the map to follow the CanSat.
   *
   * @param {number} lat      - Latitude in decimal degrees
   * @param {number} lng      - Longitude in decimal degrees
   * @param {number} altitude - Altitude in meters (used for popup label)
   */
  function updatePosition(lat, lng, altitude) {
    if (!_isInitialized || !_map) return;

    // Validate coordinates
    if (isNaN(lat) || isNaN(lng)) return;
    if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return; // GPS not fixed
    if (Math.abs(lat) > 90.0 || Math.abs(lng) > 180.0) return;   // Out of range

    // Skip trivially duplicate positions
    if (_lastLat !== null && _lastLng !== null) {
      const dLat = Math.abs(lat - _lastLat);
      const dLng = Math.abs(lng - _lastLng);
      if (dLat < MIN_MOVE_DIST && dLng < MIN_MOVE_DIST) {
        return; // No meaningful movement
      }
    }

    _lastLat = lat;
    _lastLng = lng;

    const latlng = L.latLng(lat, lng);

    // ── Set launch marker on first valid position ──
    if (!_launchCoordSet) {
      _launchMarker = L.marker(latlng, {
        icon:  _makeLaunchMarkerIcon(),
        title: 'Launch Site',
        zIndexOffset: 100,
      }).addTo(_map);

      _launchMarker.bindPopup(
        `<div style="font-family:monospace;font-size:11px;color:#0b0e15;">
          <strong>🚀 Launch Site</strong><br>
          LAT: ${lat.toFixed(6)}°<br>
          LNG: ${lng.toFixed(6)}°
        </div>`,
        { closeButton: false }
      );

      // Center map on first position
      _map.setView(latlng, DEFAULT_ZOOM, { animate: true });
      _launchCoordSet = true;
    }

    // ── Append to track history ──
    _trackCoords.push([lat, lng]);

    // Update polyline
    _trackPolyline.setLatLngs(_trackCoords);

    // ── Update or create current position marker ──
    if (!_currentMarker) {
      _currentMarker = L.marker(latlng, {
        icon:  _makeCurrentMarkerIcon(),
        title: 'CanSat',
        zIndexOffset: 1000,
      }).addTo(_map);

      _currentMarker.bindPopup(
        `<div id="marker-popup" style="font-family:monospace;font-size:11px;color:#0b0e15;min-width:150px;">
          <strong>🛰 CanSat</strong><br>
          <span id="popup-lat">LAT: ${lat.toFixed(6)}°</span><br>
          <span id="popup-lng">LNG: ${lng.toFixed(6)}°</span><br>
          <span id="popup-alt">ALT: ${altitude.toFixed(1)} m</span>
        </div>`,
        { closeButton: false, autoClose: false }
      );
    } else {
      _currentMarker.setLatLng(latlng);

      // Update popup content if open
      const popup = _currentMarker.getPopup();
      if (popup) {
        popup.setContent(
          `<div style="font-family:monospace;font-size:11px;color:#0b0e15;min-width:150px;">
            <strong>🛰 CanSat</strong><br>
            LAT: ${lat.toFixed(6)}°<br>
            LNG: ${lng.toFixed(6)}°<br>
            ALT: ${altitude.toFixed(1)} m
          </div>`
        );
      }
    }

    // ── Auto-pan map to follow CanSat ──
    // Only pan if the marker is close to the edge of the viewport
    const mapBounds  = _map.getBounds();
    const paddedBounds = mapBounds.pad(-0.2); // 20% inset padding
    if (!paddedBounds.contains(latlng)) {
      _map.panTo(latlng, { animate: true, duration: 0.5 });
    }

    // Update track line style based on number of points
    if (_trackCoords.length > 200) {
      // Simplify visual weight for long tracks
      _trackPolyline.setStyle({ weight: 1.5, opacity: 0.6 });
    }
  }

  /* ─────────────────────────────────────────────────────────
     UTILITY: FIT MAP TO TRACK
  ───────────────────────────────────────────────────────── */

  /**
   * Fit the map view to encompass the full recorded trajectory.
   */
  function fitToTrack() {
    if (!_isInitialized || !_map) return;
    if (_trackCoords.length < 2) return;

    const bounds = L.latLngBounds(_trackCoords);
    _map.fitBounds(bounds, {
      padding: [30, 30],
      animate: true,
      maxZoom: 18,
    });
  }

  /* ─────────────────────────────────────────────────────────
     RESET
  ───────────────────────────────────────────────────────── */

  /**
   * Clear all track data and markers from the map.
   */
  function resetTrack() {
    if (!_isInitialized || !_map) return;

    // Remove current position marker
    if (_currentMarker) {
      _currentMarker.remove();
      _currentMarker = null;
    }

    // Remove launch marker
    if (_launchMarker) {
      _launchMarker.remove();
      _launchMarker = null;
    }

    // Clear polyline
    _trackCoords = [];
    if (_trackPolyline) {
      _trackPolyline.setLatLngs([]);
    }

    _launchCoordSet = false;
    _lastLat        = null;
    _lastLng        = null;

    // Reset view to default
    _map.setView(DEFAULT_CENTER, DEFAULT_ZOOM, { animate: true });
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────── */
  return {
    init,
    updatePosition,
    fitToTrack,
    resetTrack,
    getMap:         () => _map,
    getTrackCoords: () => [..._trackCoords],
    isInitialized:  () => _isInitialized,
  };

})();
