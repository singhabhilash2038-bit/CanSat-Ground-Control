/**
 * serial.js — CanSat GCS Web Serial API Driver
 * Manages serial port lifecycle, baud rate selection,
 * stream reading pipeline, buffer assembly, and safe disconnect.
 */

'use strict';

const SerialDriver = (() => {

  /* ─────────────────────────────────────────────────────────
     INTERNAL STATE
  ───────────────────────────────────────────────────────── */
  let _port           = null;  // SerialPort object
  let _reader         = null;  // ReadableStreamDefaultReader
  let _readLoopActive = false; // flag to stop read loop gracefully
  let _lineBuffer     = '';    // accumulates bytes between newlines
  let _onLineCallback = null;  // function called with each complete line
  let _onDisconnectCallback = null;

  /* ─────────────────────────────────────────────────────────
     CAPABILITY CHECK
  ───────────────────────────────────────────────────────── */
  function isSupported() {
    return 'serial' in navigator;
  }

  /* ─────────────────────────────────────────────────────────
     CONNECTION
  ───────────────────────────────────────────────────────── */

  /**
   * Request and open a serial port from the browser's port picker.
   * @param {number}   baudRate - e.g. 9600 or 115200
   * @param {function} onLine   - called with each complete line string
   * @param {function} onDisconnect - called when port unexpectedly closes
   * @returns {Promise<boolean>} resolves true if connected, false if cancelled
   */
  async function connect(baudRate, onLine, onDisconnect) {
    if (!isSupported()) {
      UI.logConsole('ERROR: Web Serial API not supported. Use Chrome or Edge v89+.', 'error');
      return false;
    }

    if (_port) {
      UI.logConsole('Already connected. Disconnect first.', 'warn');
      return false;
    }

    try {
      // Prompt user to select a port
      _port = await navigator.serial.requestPort({});
      UI.logConsole(`Port selected: ${_describePort(_port)}`, 'info');
    } catch (err) {
      if (err.name === 'NotFoundError' || err.name === 'AbortError') {
        UI.logConsole('Port selection cancelled by user.', 'warn');
      } else {
        UI.logConsole(`Port selection error: ${err.message}`, 'error');
      }
      _port = null;
      return false;
    }

    try {
      await _port.open({
        baudRate:   baudRate,
        dataBits:   8,
        stopBits:   1,
        parity:     'none',
        flowControl: 'none',
      });
      UI.logConsole(`Serial port opened at ${baudRate} baud.`, 'ok');
    } catch (err) {
      UI.logConsole(`Failed to open port: ${err.message}`, 'error');
      _port = null;
      return false;
    }

    _onLineCallback       = onLine;
    _onDisconnectCallback = onDisconnect;
    _lineBuffer           = '';

    // Listen for hardware disconnect events
    _port.addEventListener('disconnect', _handleHardwareDisconnect);

    // Start the read loop in background
    _readLoopActive = true;
    _startReadLoop();

    return true;
  }

  /**
   * Gracefully disconnect: cancel reader, close port, clean up state.
   */
  async function disconnect() {
    if (!_port) {
      UI.logConsole('No port is currently open.', 'warn');
      return;
    }

    _readLoopActive = false;

    // Cancel the reader to allow the port's readable stream to be released
    if (_reader) {
      try {
        await _reader.cancel();
      } catch (_) {
        // Ignore: reader may already be closed
      }
      _reader = null;
    }

    // Close the port
    try {
      await _port.close();
      UI.logConsole('Serial port closed successfully.', 'ok');
    } catch (err) {
      UI.logConsole(`Error closing port: ${err.message}`, 'warn');
    }

    _port.removeEventListener('disconnect', _handleHardwareDisconnect);
    _port           = null;
    _lineBuffer     = '';
    _onLineCallback = null;
  }

  /* ─────────────────────────────────────────────────────────
     READ LOOP
  ───────────────────────────────────────────────────────── */
  async function _startReadLoop() {
    if (!_port || !_port.readable) {
      UI.logConsole('Port is not readable. Aborting read loop.', 'error');
      return;
    }

    // Create a TextDecoder to convert Uint8Array bytes to strings
    const decoder = new TextDecoder('utf-8', { fatal: false });

    try {
      _reader = _port.readable.getReader();
      UI.logConsole('Read loop started.', 'info');

      while (_readLoopActive) {
        let result;
        try {
          result = await _reader.read();
        } catch (readErr) {
          if (_readLoopActive) {
            // Unexpected read error — treat as disconnect
            UI.logConsole(`Read error: ${readErr.message}`, 'error');
            _handleHardwareDisconnect();
          }
          break;
        }

        if (result.done) {
          // Stream closed cleanly
          break;
        }

        if (result.value && result.value.length > 0) {
          const chunk = decoder.decode(result.value, { stream: true });
          _processChunk(chunk);
        }
      }
    } catch (outerErr) {
      if (_readLoopActive) {
        UI.logConsole(`Read loop fatal: ${outerErr.message}`, 'error');
      }
    } finally {
      // Release the lock on the readable stream
      if (_reader) {
        try {
          _reader.releaseLock();
        } catch (_) { /* already released */ }
        _reader = null;
      }
    }
  }

  /**
   * Process an incoming raw text chunk.
   * Splits on CR, LF, or CRLF. Accumulates partial lines in _lineBuffer.
   */
  function _processChunk(chunk) {
    // Append chunk to buffer
    _lineBuffer += chunk;

    // Split on any combination of CR/LF
    const lines = _lineBuffer.split(/\r?\n|\r/);

    // All elements except the last one are complete lines
    // The last element is a partial line (may be empty string)
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (line.length > 0) {
        _dispatchLine(line);
      }
    }

    // Keep the remainder (partial line or empty string)
    _lineBuffer = lines[lines.length - 1];

    // Guard against buffer overrun (e.g., stream without newlines)
    const MAX_BUFFER_BYTES = 4096;
    if (_lineBuffer.length > MAX_BUFFER_BYTES) {
      UI.logConsole(`[SERIAL] Buffer overrun (${_lineBuffer.length} bytes) — flushing.`, 'warn');
      _lineBuffer = '';
    }
  }

  /**
   * Dispatch a single, complete line to the registered callback.
   * @param {string} line
   */
  function _dispatchLine(line) {
    if (typeof _onLineCallback === 'function') {
      try {
        _onLineCallback(line);
      } catch (cbErr) {
        UI.logConsole(`[SERIAL] Callback error: ${cbErr.message}`, 'error');
      }
    }
  }

  /* ─────────────────────────────────────────────────────────
     HARDWARE DISCONNECT HANDLER
  ───────────────────────────────────────────────────────── */
  function _handleHardwareDisconnect() {
    // Guard against duplicate calls
    if (!_port) return;

    UI.logConsole('[SERIAL] Hardware disconnect detected.', 'error');
    _readLoopActive = false;

    // Clean up port reference without trying to close (already closed by hardware)
    if (_reader) {
      try { _reader.releaseLock(); } catch (_) {}
      _reader = null;
    }
    _port           = null;
    _lineBuffer     = '';
    _onLineCallback = null;

    // Notify the application layer
    if (typeof _onDisconnectCallback === 'function') {
      try {
        _onDisconnectCallback();
      } catch (_) {}
    }
  }

  /* ─────────────────────────────────────────────────────────
     WRITE
  ───────────────────────────────────────────────────────── */
  
  /**
   * Write a string to the connected serial port.
   * @param {string} dataString 
   */
  async function write(dataString) {
    if (!_port || !_port.writable) {
      UI.logConsole('[SERIAL] Cannot write: port not open or not writable.', 'warn');
      return false;
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(dataString);
    const writer = _port.writable.getWriter();

    try {
      await writer.write(data);
      return true;
    } catch (err) {
      UI.logConsole(`[SERIAL] Write error: ${err.message}`, 'error');
      return false;
    } finally {
      writer.releaseLock();
    }
  }

  /* ─────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────── */
  function _describePort(port) {
    if (!port) return 'unknown';
    try {
      const info = port.getInfo();
      if (info && info.usbVendorId !== undefined) {
        return `USB VID:${info.usbVendorId.toString(16).toUpperCase()} PID:${info.usbProductId.toString(16).toUpperCase()}`;
      }
    } catch (_) {}
    return 'Serial Port';
  }

  function isConnected() {
    return _port !== null;
  }

  function getCurrentPort() {
    return _port;
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────── */
  return {
    isSupported,
    isConnected,
    getCurrentPort,
    connect,
    disconnect,
    write,
  };

})();
