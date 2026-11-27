/**
 * @fileoverview Dedicated single-threaded WASM Web Worker for Disk Crate Phase 3a scanner.
 * Instantiates the verified `engine-shell.wasm` module without SharedArrayBuffer/COOP/COEP,
 * processes camera frame luminance telemetry, and releases heap memory cleanly on `shutdown`.
 * Exports `createScannerWorkerCore` for deterministic Node tests.
 */
(function (workerGlobal) {
  'use strict';

  function computeMeanLuma(payload) {
    if (payload && typeof payload.sampleLuma === 'number' && Number.isFinite(payload.sampleLuma)) {
      return Math.max(0, Math.min(255, payload.sampleLuma));
    }
    const pixels = payload && payload.pixels;
    if (!pixels || typeof pixels.length !== 'number' || pixels.length < 4) {
      return 128;
    }
    let total = 0;
    let count = 0;
    // Step by 4 RGBA channels (subsample every pixel cleanly for tiny thumbnails)
    for (let i = 0; i + 2 < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      total += 0.299 * r + 0.587 * g + 0.114 * b;
      count++;
    }
    return count > 0 ? total / count : 128;
  }

  function classifyFrameHint(luma) {
    if (luma < 45) return 'low-light';
    if (luma > 235) return 'glare';
    return 'ready';
  }

  function createScannerWorkerCore() {
    let wasmInstance = null;
    let ready = false;
    let framesProcessed = 0;

    async function handleMessage(msg) {
      const data = msg && typeof msg === 'object' ? msg : {};

      if (data.type === 'init') {
        const rawBytes = data.wasmBytes;
        const bytes =
          rawBytes instanceof Uint8Array
            ? rawBytes
            : ArrayBuffer.isView(rawBytes)
              ? new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)
              : rawBytes && typeof rawBytes.byteLength === 'number'
                ? new Uint8Array(rawBytes)
                : null;
        if (!bytes || bytes.byteLength === 0) {
          return { type: 'error', error: 'Missing engine-shell.wasm bytes for worker init' };
        }
        const instantiated = await WebAssembly.instantiate(bytes);
        wasmInstance = instantiated && instantiated.instance ? instantiated.instance : instantiated;
        const exportsObj = (wasmInstance && wasmInstance.exports) || {};
        const pingVal = typeof exportsObj.ping === 'function' ? exportsObj.ping() : 0;
        const verVal = typeof exportsObj.version === 'function' ? exportsObj.version() : 0;
        if (pingVal !== 301) {
          wasmInstance = null;
          ready = false;
          return { type: 'error', error: 'Unexpected WASM ping response: ' + pingVal };
        }
        ready = true;
        framesProcessed = 0;
        return {
          type: 'ready',
          stage: '3a',
          engineVersion: verVal,
          ping: pingVal,
          nativeEan13: !!data.nativeEan13,
          memoryMode: 'single-threaded-wasm'
        };
      }

      if (data.type === 'frame') {
        if (!ready) {
          return { type: 'error', error: 'Scanner worker not initialized' };
        }
        framesProcessed++;
        const luma = computeMeanLuma(data);
        return {
          type: 'frame-result',
          timestamp: data.timestamp || Date.now(),
          framesProcessed: framesProcessed,
          luma: Math.round(luma),
          hint: classifyFrameHint(luma),
          matches: []
        };
      }

      if (data.type === 'shutdown') {
        wasmInstance = null;
        ready = false;
        framesProcessed = 0;
        return { type: 'stopped' };
      }

      return { type: 'error', error: 'Unknown worker message type: ' + String(data.type) };
    }

    return {
      handleMessage: handleMessage,
      isReady: function () { return ready; },
      getFramesProcessed: function () { return framesProcessed; }
    };
  }

  // Bind Web Worker runtime loop only when executing inside a DedicatedWorkerGlobalScope
  if (
    workerGlobal &&
    typeof workerGlobal.postMessage === 'function' &&
    typeof workerGlobal.window === 'undefined' &&
    typeof module === 'undefined'
  ) {
    const core = createScannerWorkerCore();
    workerGlobal.onmessage = function (ev) {
      Promise.resolve(core.handleMessage(ev && ev.data))
        .then(function (reply) {
          if (reply) workerGlobal.postMessage(reply);
        })
        .catch(function (err) {
          workerGlobal.postMessage({
            type: 'error',
            error: err && err.message ? err.message : String(err)
          });
        });
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createScannerWorkerCore: createScannerWorkerCore,
      computeMeanLuma: computeMeanLuma,
      classifyFrameHint: classifyFrameHint
    };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : null);
