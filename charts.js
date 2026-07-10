/**
 * charts.js — CanSat GCS Chart.js Multi-Dataset Driver
 * Manages 5 time-series charts with sliding 50-point windows:
 *   Altitude, Pressure, Temperature, Descent Rate, Battery Voltage
 * Also drives 5 sparkline mini-charts inside the telemetry cards.
 */

'use strict';

const Charts = (() => {

  /* ─────────────────────────────────────────────────────────
     CONFIGURATION
  ───────────────────────────────────────────────────────── */
  const MAX_POINTS = 50; // sliding window size
  const MAX_SPARKLINE_POINTS = 20;

  /* ─────────────────────────────────────────────────────────
     COLOR PALETTE (matching CSS design tokens)
  ───────────────────────────────────────────────────────── */
  const COLORS = {
    altitude:    { line: '#00D4FF', fill: 'rgba(0,212,255,0.12)',    point: '#00D4FF' },
    pressure:    { line: '#F5A623', fill: 'rgba(245,166,35,0.12)',   point: '#F5A623' },
    temperature: { line: '#FF7043', fill: 'rgba(255,112,67,0.12)',   point: '#FF7043' },
    descent:     { line: '#AB47BC', fill: 'rgba(171,71,188,0.12)',   point: '#AB47BC' },
    voltage:     { line: '#00E676', fill: 'rgba(0,230,118,0.12)',    point: '#00E676' },
    sparkline:   '#00D4FF',
  };

  /* ─────────────────────────────────────────────────────────
     CHART INSTANCES
  ───────────────────────────────────────────────────────── */
  let _charts = {
    altitude:    null,
    pressure:    null,
    temperature: null,
    descent:     null,
    voltage:     null,
  };

  let _sparklines = {
    altitude:    null,
    pressure:    null,
    temperature: null,
    descent:     null,
    voltage:     null,
  };

  /* ─────────────────────────────────────────────────────────
     SHARED CHART.JS DEFAULTS
  ───────────────────────────────────────────────────────── */
  function _applyGlobalDefaults() {
    Chart.defaults.color = '#5c667a';
    Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
    Chart.defaults.font.family = "'JetBrains Mono', 'Fira Code', monospace";
    Chart.defaults.font.size   = 10;
    Chart.defaults.animation   = false; // Disable animation for real-time performance
  }

  /* ─────────────────────────────────────────────────────────
     BASE CHART FACTORY
  ───────────────────────────────────────────────────────── */

  /**
   * Create a time-series line chart on the given canvas element.
   * @param {string} canvasId     - ID of the <canvas> element
   * @param {string} label        - Dataset label
   * @param {string} yAxisLabel   - Y-axis title
   * @param {object} colorSet     - { line, fill, point }
   * @param {number} [yMin]       - Optional Y-axis minimum
   * @param {number} [yMax]       - Optional Y-axis maximum
   * @returns {Chart}             - Chart.js instance
   */
  function _createLineChart(canvasId, label, yAxisLabel, colorSet, yMin, yMax) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
      console.error(`[Charts] Canvas not found: ${canvasId}`);
      return null;
    }

    const ctx = canvas.getContext('2d');

    // Build Y-axis scale config
    const yScale = {
      type: 'linear',
      title: {
        display:  true,
        text:     yAxisLabel,
        color:    '#5c667a',
        font:     { size: 9, family: "'JetBrains Mono', monospace" },
        padding:  { bottom: 4 },
      },
      ticks: {
        color:       '#5c667a',
        maxTicksLimit: 6,
        callback: (value) => value.toFixed(1),
      },
      grid: {
        color:       'rgba(255,255,255,0.05)',
        drawBorder:  false,
      },
    };

    if (yMin !== undefined) yScale.suggestedMin = yMin;
    if (yMax !== undefined) yScale.suggestedMax = yMax;

    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels:   [],
        datasets: [{
          label:            label,
          data:             [],
          borderColor:      colorSet.line,
          backgroundColor:  colorSet.fill,
          pointBackgroundColor: colorSet.point,
          pointBorderColor:     colorSet.point,
          pointRadius:      2,
          pointHoverRadius: 5,
          borderWidth:      2,
          fill:             true,
          tension:          0.35,
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        animation:           false,
        interaction: {
          mode:      'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            labels: {
              color:        colorSet.line,
              pointStyle:   'circle',
              usePointStyle: true,
              font:         { size: 9 },
              padding:      10,
            },
          },
          tooltip: {
            backgroundColor: 'rgba(15,20,32,0.92)',
            borderColor:     colorSet.line,
            borderWidth:     1,
            titleColor:      '#8a96b0',
            bodyColor:       '#e8edf5',
            padding:         10,
            callbacks: {
              title: (items) => `Packet #${items[0].label}`,
              label: (item) => ` ${label}: ${item.raw.toFixed(3)} ${yAxisLabel}`,
            },
          },
        },
        scales: {
          x: {
            title: {
              display: true,
              text:    'Packet #',
              color:   '#5c667a',
              font:    { size: 9 },
            },
            ticks: {
              color:           '#5c667a',
              maxTicksLimit:   8,
              maxRotation:     0,
            },
            grid: {
              color:      'rgba(255,255,255,0.04)',
              drawBorder: false,
            },
          },
          y: yScale,
        },
      },
    });

    // Store reference on canvas for external resize calls
    canvas._chartInstance = chart;
    return chart;
  }

  /* ─────────────────────────────────────────────────────────
     SPARKLINE FACTORY
  ───────────────────────────────────────────────────────── */

  /**
   * Create a minimal sparkline chart (no axes, no labels) on a canvas.
   * @param {string} canvasId
   * @param {string} color
   * @returns {Chart}
   */
  function _createSparkline(canvasId, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const ctx = canvas.getContext('2d');

    return new Chart(ctx, {
      type: 'line',
      data: {
        labels:   [],
        datasets: [{
          data:            [],
          borderColor:     color,
          backgroundColor: color.replace(')', ', 0.15)').replace('rgb', 'rgba'),
          borderWidth:     1.5,
          pointRadius:     0,
          fill:            true,
          tension:         0.4,
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        animation:           false,
        plugins: {
          legend:  { display: false },
          tooltip: { enabled: false },
        },
        scales: {
          x: { display: false },
          y: { display: false },
        },
        elements: {
          line: { borderCapStyle: 'round' },
        },
      },
    });
  }

  /* ─────────────────────────────────────────────────────────
     SLIDING WINDOW UPDATE HELPER
  ───────────────────────────────────────────────────────── */

  /**
   * Append a new data point to a Chart.js chart, maintaining max window size.
   * @param {Chart}  chartInstance
   * @param {number|string} label   - X-axis label (e.g., packet number)
   * @param {number} value          - Y value
   * @param {number} maxPoints      - Maximum window size before eviction
   */
  function _appendPoint(chartInstance, label, value, maxPoints) {
    if (!chartInstance) return;

    const dataset = chartInstance.data.datasets[0];
    const labels  = chartInstance.data.labels;

    labels.push(label);
    dataset.data.push(value);

    // Evict oldest point if over limit
    if (labels.length > maxPoints) {
      labels.shift();
      dataset.data.shift();
    }

    chartInstance.update('none'); // 'none' = no animation, maximum performance
  }

  /* ─────────────────────────────────────────────────────────
     INITIALIZATION
  ───────────────────────────────────────────────────────── */
  function init() {
    _applyGlobalDefaults();

    // ── Full-size charts ──
    _charts.altitude = _createLineChart(
      'chart-altitude',
      'Altitude',
      'm',
      COLORS.altitude,
      0
    );

    _charts.pressure = _createLineChart(
      'chart-pressure',
      'Pressure',
      'hPa',
      COLORS.pressure,
      900,
      1100
    );

    _charts.temperature = _createLineChart(
      'chart-temperature',
      'Temperature',
      '°C',
      COLORS.temperature
    );

    _charts.descent = _createLineChart(
      'chart-descent',
      'Descent Rate',
      'm/s',
      COLORS.descent,
      0
    );

    _charts.voltage = _createLineChart(
      'chart-voltage',
      'Battery Voltage',
      'V',
      COLORS.voltage,
      3.0,
      4.5
    );

    // ── Sparklines ──
    _sparklines.altitude    = _createSparkline('spark-altitude',     COLORS.altitude.line);
    _sparklines.pressure    = _createSparkline('spark-pressure',     COLORS.pressure.line);
    _sparklines.temperature = _createSparkline('spark-temperature',  COLORS.temperature.line);
    _sparklines.descent     = _createSparkline('spark-descent',      COLORS.descent.line);
    _sparklines.voltage     = _createSparkline('spark-voltage',      COLORS.voltage.line);
  }

  /* ─────────────────────────────────────────────────────────
     DATA INGESTION
  ───────────────────────────────────────────────────────── */

  /**
   * Add a parsed telemetry packet's values to all charts and sparklines.
   * @param {object} packet - Parsed telemetry packet from Telemetry.parseLine()
   */
  function addDataPoint(packet) {
    const label = packet.packetCount;

    // ── Full charts ──
    _appendPoint(_charts.altitude,    label, packet.altitude,       MAX_POINTS);
    _appendPoint(_charts.pressure,    label, packet.pressure,       MAX_POINTS);
    _appendPoint(_charts.temperature, label, packet.temperature,    MAX_POINTS);
    _appendPoint(_charts.descent,     label, packet.descentRate,    MAX_POINTS);
    _appendPoint(_charts.voltage,     label, packet.batteryVoltage, MAX_POINTS);

    // ── Sparklines ──
    _appendPoint(_sparklines.altitude,    label, packet.altitude,       MAX_SPARKLINE_POINTS);
    _appendPoint(_sparklines.pressure,    label, packet.pressure,       MAX_SPARKLINE_POINTS);
    _appendPoint(_sparklines.temperature, label, packet.temperature,    MAX_SPARKLINE_POINTS);
    _appendPoint(_sparklines.descent,     label, packet.descentRate,    MAX_SPARKLINE_POINTS);
    _appendPoint(_sparklines.voltage,     label, packet.batteryVoltage, MAX_SPARKLINE_POINTS);
  }

  /* ─────────────────────────────────────────────────────────
     RESET / CLEAR
  ───────────────────────────────────────────────────────── */

  /**
   * Clear all data from all charts and sparklines without destroying instances.
   */
  function clearAllCharts() {
    const allCharts = [
      ...Object.values(_charts),
      ...Object.values(_sparklines),
    ];

    allCharts.forEach(chart => {
      if (!chart) return;
      chart.data.labels = [];
      chart.data.datasets[0].data = [];
      chart.update('none');
    });
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────── */
  return {
    init,
    addDataPoint,
    clearAllCharts,
    getChartInstances: () => ({ ..._charts }),
    getSparklineInstances: () => ({ ..._sparklines }),
  };

})();
