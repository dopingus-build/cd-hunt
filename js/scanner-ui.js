/**
 * @fileoverview Lazily loaded Phase 3a Opt-In Camera Scanner UI (`window.DiskCrate.scannerUI`).
 * Handles opt-in download confirmation, Engine Manager (download/delete/wipe),
 * live getUserMedia viewfinder + camera switching + torch toggle, Web Worker frame telemetry,
 * strict resource teardown on close/background, and always-available manual code fallback.
 */
(function (root) {
  'use strict';

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function createScannerUI(initOpts) {
    const baseOpts = initOpts || {};
    let modalCreated = false;
    let isOpen = false;
    let currentContext = {};
    let activeManager = null;
    let activeManifest = null;
    let activeWorker = null;
    let activeStream = null;
    let activeVideoTrack = null;
    let torchEnabled = false;
    let facingMode = 'environment';
    let sampleTimer = null;
    let squareReticle = false;
    let activePanel = 'gate';
    let lifecycleBound = false;

    function getEl(id) {
      return typeof document !== 'undefined' ? document.getElementById(id) : null;
    }

    function stopCameraOnly() {
      if (sampleTimer !== null) {
        clearInterval(sampleTimer);
        sampleTimer = null;
      }
      if (activeStream && typeof activeStream.getTracks === 'function') {
        activeStream.getTracks().forEach(function (track) {
          try { track.stop(); } catch (e) {}
        });
      }
      activeStream = null;
      activeVideoTrack = null;
      torchEnabled = false;

      const videoEl = getEl('scannerVideo');
      if (videoEl) {
        try { videoEl.srcObject = null; } catch (e) {}
      }
      const torchBtn = getEl('scannerTorchBtn');
      if (torchBtn) {
        torchBtn.classList.add('hidden');
        torchBtn.textContent = 'Torch: Off';
      }
    }

    function teardownWorkerAndCamera() {
      stopCameraOnly();
      if (activeWorker) {
        try {
          if (typeof activeWorker.postMessage === 'function') {
            activeWorker.postMessage({ type: 'shutdown' });
          }
        } catch (e) {}
        try {
          if (typeof activeWorker.terminate === 'function') {
            activeWorker.terminate();
          }
        } catch (e) {}
        activeWorker = null;
      }
    }

    function showPanel(panelName) {
      activePanel = panelName;
      const map = {
        gate: 'scannerGatePanel',
        viewfinder: 'scannerViewfinderPanel',
        manager: 'scannerManagerPanel'
      };
      Object.keys(map).forEach(function (k) {
        const el = getEl(map[k]);
        if (el) el.classList.toggle('hidden', k !== panelName);
      });
    }

    function setHudStatus(text) {
      const el = getEl('scannerHudStatus');
      if (el) el.textContent = text;
    }

    function setCamError(msg) {
      const el = getEl('scannerCamError');
      if (!el) return;
      if (msg) {
        el.textContent = msg;
        el.classList.remove('hidden');
      } else {
        el.textContent = '';
        el.classList.add('hidden');
      }
    }

    async function refreshManagerPanel() {
      const managerMod =
        currentContext.scannerManager ||
        (root && root.DiskCrate && root.DiskCrate.scannerManager) ||
        null;
      const fmt = managerMod ? managerMod.formatBytes : function (b) { return b + ' B'; };
      const status = activeManager ? await activeManager.getPackStatus(activeManifest) : { packs: [], installedBytes: 0 };

      const listEl = getEl('scannerManagerPacksList');
      if (listEl) {
        if (!status.packs || status.packs.length === 0) {
          listEl.innerHTML = '<div class="preset-sub">Unable to load manifest online. Download packs while connected or wipe cache.</div>';
        } else {
          listEl.innerHTML = status.packs.map(function (p) {
            const stateBadge = p.installed
              ? '<span class="tag-sky" style="background:rgba(16,185,129,0.16); color:#6ee7b7;">Verified · ' + escHtml(fmt(p.cachedBytes)) + '</span>'
              : p.available
                ? '<span class="scanner-stage-badge">' + escHtml(fmt(p.totalBytes)) + '</span>'
                : '<span class="scanner-stage-badge planned">Stage ' + escHtml(p.stage) + ' Planned</span>';

            const actionBtn = !p.available
              ? '<button type="button" class="btn" disabled>Coming in ' + escHtml(p.stage) + '</button>'
              : p.installed
                ? '<button type="button" class="btn" data-scanner-del="' + escHtml(p.id) + '">Remove</button>'
                : '<button type="button" class="btn btn-primary" data-scanner-dl="' + escHtml(p.id) + '">Download (' + escHtml(fmt(p.totalBytes)) + ')</button>';

            return (
              '<div class="scanner-pack-item" data-pack-id="' + escHtml(p.id) + '">' +
                '<div class="scanner-pack-info">' +
                  '<div class="scanner-pack-title">' +
                    '<span>' + escHtml(p.title) + '</span>' +
                    stateBadge +
                  '</div>' +
                  '<div class="scanner-pack-desc">' + escHtml(p.description) + '</div>' +
                '</div>' +
                '<div style="display:flex; gap:6px;">' + actionBtn + '</div>' +
              '</div>'
            );
          }).join('');
        }
      }

      const footEl = getEl('scannerCacheFootprint');
      if (footEl) {
        footEl.textContent = 'Offline Scanner Cache: ' + fmt(status.installedBytes || 0);
      }

      if (managerMod && typeof managerMod.detectCapabilities === 'function') {
        const caps = await managerMod.detectCapabilities(currentContext.globalObj || root);
        const capsEl = getEl('scannerCapsText');
        if (capsEl) {
          capsEl.textContent =
            'Camera: ' + (caps.getUserMedia ? 'Supported' : 'Unavailable') +
            ' · EAN-13 Native: ' + (caps.nativeEan13 ? 'Yes (0 MB)' : 'Planned Fallback') +
            ' · WASM Worker: ' + (caps.Worker && caps.WebAssembly ? 'Ready' : 'Unsupported');
        }
      }
    }

    async function initScannerWorkerFromCache() {
      if (!activeManager || !activeManifest) return false;
      if (activeWorker) return true;

      const reqPack = (activeManifest.packs || []).find(function (p) { return p && p.required && p.available !== false; });
      const wasmFile = reqPack && Array.isArray(reqPack.files) ? reqPack.files[0] : null;
      if (!wasmFile) return false;

      const wasmBytes = await activeManager.readCachedFileBytes(wasmFile.path, wasmFile.sha256);
      if (!wasmBytes) return false;

      const WorkerCtor = currentContext.WorkerCtor || (root && root.Worker);
      if (typeof WorkerCtor !== 'function') {
        setHudStatus('Worker API unavailable — manual code lookup active');
        return false;
      }

      const managerMod =
        currentContext.scannerManager ||
        (root && root.DiskCrate && root.DiskCrate.scannerManager) ||
        null;
      const caps = managerMod && typeof managerMod.detectCapabilities === 'function'
        ? await managerMod.detectCapabilities(currentContext.globalObj || root)
        : { nativeEan13: false };

      const workerUrl = currentContext.workerUrl || './js/scanner-worker.js';
      const worker = new WorkerCtor(workerUrl);
      activeWorker = worker;

      return new Promise(function (resolve) {
        let settled = false;
        function finish(ok) {
          if (settled) return;
          settled = true;
          resolve(ok);
        }

        worker.onmessage = function (ev) {
          const msg = ev && ev.data ? ev.data : {};
          if (msg.type === 'ready') {
            setHudStatus('WASM Shell v' + (msg.engineVersion || 1) + ' Ready (ping ' + (msg.ping || 301) + ')');
            finish(true);
          } else if (msg.type === 'frame-result') {
            const cntEl = getEl('scannerFrameCounter');
            if (cntEl) cntEl.textContent = String(msg.framesProcessed || 0) + ' frames';
            setHudStatus(
              'WASM Live · ' + (msg.hint || 'ready') + ' (luma ' + (msg.luma !== undefined ? msg.luma : 0) + ')'
            );
          } else if (msg.type === 'error') {
            setHudStatus('Worker Error: ' + (msg.error || 'Unknown error'));
            finish(false);
          }
        };

        worker.onerror = function (err) {
          setHudStatus('Worker Failed: ' + (err && err.message ? err.message : 'Load error'));
          finish(false);
        };

        // Pass ArrayBuffer copy safely into isolated Web Worker
        const byteCopy = new Uint8Array(wasmBytes.slice(0));
        worker.postMessage({
          type: 'init',
          wasmBytes: byteCopy,
          nativeEan13: !!caps.nativeEan13
        });
      });
    }

    async function enterViewfinderSafely() {
      showPanel('viewfinder');
      try {
        await initScannerWorkerFromCache();
        await startCamera();
      } catch (err) {
        teardownWorkerAndCamera();
        showPanel('gate');
        const gateErr = getEl('scannerGateError');
        if (gateErr) {
          gateErr.textContent =
            (err && err.message ? err.message : 'Cached scanner asset corrupted') +
            ' — click Download & Enable Scanner to repair.';
          gateErr.classList.remove('hidden');
        }
      }
    }

    function startFrameSamplingLoop() {
      if (sampleTimer !== null) clearInterval(sampleTimer);
      sampleTimer = setInterval(function () {
        if (!isOpen || activePanel !== 'viewfinder' || !activeWorker) return;
        const videoEl = getEl('scannerVideo');
        if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) return;

        let sampleLuma = 128;
        const canvasEl = getEl('scannerCanvas');
        if (canvasEl && typeof canvasEl.getContext === 'function') {
          try {
            const w = 64;
            const h = 48;
            canvasEl.width = w;
            canvasEl.height = h;
            const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(videoEl, 0, 0, w, h);
              const imgData = ctx.getImageData(0, 0, w, h);
              const data = imgData && imgData.data;
              if (data && data.length >= 4) {
                let sum = 0;
                let n = 0;
                for (let i = 0; i + 2 < data.length; i += 16) {
                  sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                  n++;
                }
                if (n > 0) sampleLuma = sum / n;
              }
            }
          } catch (e) {
            // Keep default luma on synthetic video contexts without canvas 2d
          }
        }

        activeWorker.postMessage({
          type: 'frame',
          width: videoEl.videoWidth,
          height: videoEl.videoHeight,
          timestamp: Date.now(),
          sampleLuma: sampleLuma
        });
      }, 333);
    }

    async function startCamera() {
      stopCameraOnly();
      setCamError('');

      const nav = currentContext.navigatorImpl || (root && root.navigator) || null;
      const md = nav && nav.mediaDevices;
      if (!md || typeof md.getUserMedia !== 'function') {
        setCamError('Camera API unavailable here — enter barcode or catalog # below.');
        return false;
      }

      try {
        const stream = await md.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });

        if (!isOpen || activePanel !== 'viewfinder') {
          if (stream && typeof stream.getTracks === 'function') {
            stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
          }
          return false;
        }

        activeStream = stream;
        const tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
        activeVideoTrack = tracks[0] || null;

        const videoEl = getEl('scannerVideo');
        if (videoEl) {
          videoEl.srcObject = stream;
          if (typeof videoEl.play === 'function') {
            try { await videoEl.play(); } catch (e) {}
          }
        }

        const torchBtn = getEl('scannerTorchBtn');
        if (torchBtn && activeVideoTrack && typeof activeVideoTrack.getCapabilities === 'function') {
          try {
            const trackCaps = activeVideoTrack.getCapabilities() || {};
            torchBtn.classList.toggle('hidden', !trackCaps.torch);
          } catch (e) {
            torchBtn.classList.add('hidden');
          }
        }

        startFrameSamplingLoop();
        return true;
      } catch (err) {
        const errName = (err && err.name) || '';
        const errMsg = errName === 'NotAllowedError'
          ? 'Camera permission denied. Allow camera access or use manual lookup below.'
          : 'No live camera detected (' + ((err && err.message) || errName || 'unavailable') + ') — use manual lookup below.';
        setCamError(errMsg);
        return false;
      }
    }

    async function toggleTorch() {
      if (!activeVideoTrack || typeof activeVideoTrack.applyConstraints !== 'function') return;
      const next = !torchEnabled;
      try {
        await activeVideoTrack.applyConstraints({ advanced: [{ torch: next }] });
        torchEnabled = next;
        const torchBtn = getEl('scannerTorchBtn');
        if (torchBtn) torchBtn.textContent = torchEnabled ? 'Torch: On' : 'Torch: Off';
      } catch (e) {
        if (typeof currentContext.showToast === 'function') {
          currentContext.showToast('Torch unavailable on this camera');
        }
      }
    }

    async function handleConfirmDownload() {
      const btn = getEl('scannerConfirmDownloadBtn');
      const statusEl = getEl('scannerGateError');
      if (statusEl) {
        statusEl.textContent = '';
        statusEl.classList.add('hidden');
      }
      if (btn) btn.disabled = true;
      try {
        if (!activeManifest) {
          activeManifest = await activeManager.fetchManifest();
        }
        const dlRes = await activeManager.downloadAllAvailablePacks(activeManifest);
        if (!dlRes.ok) {
          if (statusEl) {
            statusEl.textContent = dlRes.error || 'Download failed';
            statusEl.classList.remove('hidden');
          }
          return;
        }
        if (typeof currentContext.showToast === 'function') {
          currentContext.showToast('Scanner runtime verified & cached offline');
        }
        showPanel('viewfinder');
        await initScannerWorkerFromCache();
        await startCamera();
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    function runManualLookup() {
      const inputEl = getEl('scannerManualInput');
      const resultEl = getEl('scannerManualResult');
      if (!inputEl || !resultEl) return;
      const code = inputEl.value.trim();
      if (!code) {
        resultEl.innerHTML = '';
        resultEl.classList.add('hidden');
        return;
      }

      const match =
        typeof currentContext.lookupCodeLocally === 'function'
          ? currentContext.lookupCodeLocally(code)
          : { status: 'unknown', code: code };

      resultEl.classList.remove('hidden');
      if (match.status === 'owned') {
        resultEl.innerHTML =
          '<div class="scanner-match-card">' +
            '<div>' +
              '<span class="tag-sky" style="background:rgba(16,185,129,0.16); color:#6ee7b7;">Already Owned</span> ' +
              '<strong>' + escHtml(match.owned.artist + ' — ' + match.owned.title) + '</strong> ' +
              '<span class="preset-sub">(' + escHtml(match.owned.catNo) + ')</span>' +
            '</div>' +
            '<button type="button" class="btn" data-scanner-jump="owned" data-target-id="' + escHtml(match.owned.id) + '">View in Collection</button>' +
          '</div>';
      } else if (match.status === 'hunt') {
        resultEl.innerHTML =
          '<div class="scanner-match-card">' +
            '<div>' +
              '<span class="tag-sky">On Hunt List</span> ' +
              '<strong>' + escHtml(match.hunt.artist + ' — ' + match.hunt.title) + '</strong> ' +
              '<span class="preset-sub">' + escHtml([match.hunt.regCatNo || match.hunt.catalog, match.hunt.price, match.hunt.filing].filter(Boolean).join(' · ')) + '</span>' +
            '</div>' +
            '<button type="button" class="btn btn-primary" data-scanner-jump="hunt" data-target-id="' + escHtml(match.hunt.id) + '">Open in Hunt</button>' +
          '</div>';
      } else {
        resultEl.innerHTML =
          '<div class="scanner-match-card">' +
            '<div>' +
              '<span class="scanner-stage-badge planned">Not in Local DB</span> ' +
              '<span>No Hunt or Owned match for <code>' + escHtml(code) + '</code></span>' +
            '</div>' +
            '<button type="button" class="btn btn-primary" data-scanner-add="' + escHtml(code) + '">+ Add to Collection</button>' +
          '</div>';
      }
    }

    function ensureModalDom() {
      if (modalCreated || typeof document === 'undefined') return;
      modalCreated = true;

      let backdrop = getEl('scannerModal');
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'scannerModal';
        backdrop.className = 'modal-backdrop';
        backdrop.setAttribute('role', 'dialog');
        backdrop.setAttribute('aria-modal', 'true');
        backdrop.setAttribute('aria-label', 'Camera Scanner');
        backdrop.innerHTML =
          '<div class="scanner-dialog">' +
            '<div class="scanner-header">' +
              '<div class="scanner-title-group">' +
                '<h2 class="scanner-title">Disk Crate Scanner</h2>' +
                '<span class="scanner-stage-badge">Stage 3a Opt-In</span>' +
              '</div>' +
              '<div class="scanner-btn-group">' +
                '<button id="scannerViewManagerBtn" type="button" class="btn">Engine Manager</button>' +
                '<button id="closeScannerModalBtn" type="button" class="btn">Close ✕</button>' +
              '</div>' +
            '</div>' +

            '<!-- Opt-In Download Confirmation Gate -->' +
            '<section id="scannerGatePanel" class="scanner-panel">' +
              '<div class="scanner-gate-card">' +
                '<strong style="font-size:14px;">Download Opt-In WASM Scanner Runtime?</strong>' +
                '<p style="margin:0; font-size:12.5px; color:var(--text-muted);">' +
                  'Disk Crate loads 0 bytes of scanner runtime on startup. Confirm below to download and SHA-256 verify the local runtime pack into isolated Cache Storage so scanning works offline.' +
                '</p>' +
                '<div class="scanner-gate-meta">' +
                  '<span id="scannerGateSizeText">Estimated download: checking manifest...</span>' +
                  '<span>· Zero effect on Hunt or Owned databases · 1-click Wipe anytime</span>' +
                '</div>' +
                '<div id="scannerGateError" class="scanner-error-banner hidden"></div>' +
                '<div class="scanner-btn-group">' +
                  '<button id="scannerConfirmDownloadBtn" type="button" class="btn btn-primary">Download &amp; Enable Scanner</button>' +
                  '<button id="scannerOpenManagerBtn" type="button" class="btn">Manage Packs</button>' +
                  '<button id="scannerCancelGateBtn" type="button" class="btn">Cancel</button>' +
                '</div>' +
              '</div>' +
            '</section>' +

            '<!-- Continuous Live Viewfinder -->' +
            '<section id="scannerViewfinderPanel" class="scanner-panel hidden">' +
              '<div class="scanner-viewfinder-wrap">' +
                '<video id="scannerVideo" autoplay playsinline muted></video>' +
                '<div id="scannerReticle" class="scanner-reticle">' +
                  '<span id="scannerReticleLabel" class="scanner-reticle-label">Align Barcode / Spine CatNo</span>' +
                '</div>' +
                '<canvas id="scannerCanvas" style="display:none;"></canvas>' +
              '</div>' +
              '<div class="scanner-hud-bar">' +
                '<span id="scannerHudStatus" class="scanner-hud-status">Initializing WASM Worker...</span>' +
                '<span id="scannerFrameCounter" class="count-mono">0 frames</span>' +
              '</div>' +
              '<div id="scannerCamError" class="scanner-error-banner hidden"></div>' +
              '<div class="scanner-controls-row">' +
                '<div class="scanner-btn-group">' +
                  '<button id="scannerStartCamBtn" type="button" class="btn btn-primary">Restart Camera</button>' +
                  '<button id="scannerSwitchCamBtn" type="button" class="btn">Switch Camera</button>' +
                  '<button id="scannerTorchBtn" type="button" class="btn hidden">Torch: Off</button>' +
                '</div>' +
                '<button id="scannerGuideToggleBtn" type="button" class="btn">Guide: Barcode / Spine</button>' +
              '</div>' +
            '</section>' +

            '<!-- Engine Manager -->' +
            '<section id="scannerManagerPanel" class="scanner-panel hidden">' +
              '<div id="scannerCapsText" class="preset-sub"></div>' +
              '<div id="scannerCacheFootprint" class="count-mono" style="font-size:12px;">Offline Scanner Cache: 0 B</div>' +
              '<div id="scannerManagerPacksList" class="scanner-pack-list"></div>' +
              '<div class="scanner-controls-row">' +
                '<div class="scanner-btn-group">' +
                  '<button id="scannerPreDownloadAllBtn" type="button" class="btn btn-primary">Pre-Download Available</button>' +
                  '<button id="scannerBackToScanBtn" type="button" class="btn">← Back to Scanner</button>' +
                '</div>' +
                '<button id="scannerWipeBtn" type="button" class="btn" style="color:#fda4af;">Wipe Scanner Engine &amp; Cache</button>' +
              '</div>' +
            '</section>' +

            '<!-- Always-Available Manual Fallback / Offline Lookup -->' +
            '<div class="scanner-manual-box">' +
              '<label for="scannerManualInput" style="font-size:11.5px; font-weight:700; color:var(--text-muted);">' +
                'Manual / Keyboard Barcode or Catalog # Lookup (Hunt + Owned DB)' +
              '</label>' +
              '<div class="scanner-manual-row">' +
                '<input id="scannerManualInput" class="drawer-input" type="text" placeholder="e.g. 4547366611397 or CPCA-1004" />' +
                '<button id="scannerManualSubmitBtn" type="button" class="btn">Lookup Code</button>' +
              '</div>' +
              '<div id="scannerManualResult" class="hidden"></div>' +
            '</div>' +
          '</div>';
        document.body.appendChild(backdrop);
      }

      const closeBtn = getEl('closeScannerModalBtn');
      const cancelGateBtn = getEl('scannerCancelGateBtn');
      if (closeBtn) closeBtn.addEventListener('click', close);
      if (cancelGateBtn) cancelGateBtn.addEventListener('click', close);

      backdrop.addEventListener('click', function (e) {
        if (e && e.target === backdrop) close();
      });

      const confirmBtn = getEl('scannerConfirmDownloadBtn');
      if (confirmBtn) confirmBtn.addEventListener('click', handleConfirmDownload);

      const openMgrBtn = getEl('scannerOpenManagerBtn');
      const topMgrBtn = getEl('scannerViewManagerBtn');
      function openManagerView() {
        stopCameraOnly();
        showPanel('manager');
        refreshManagerPanel();
      }
      if (openMgrBtn) openMgrBtn.addEventListener('click', openManagerView);
      if (topMgrBtn) topMgrBtn.addEventListener('click', openManagerView);

      const backToScanBtn = getEl('scannerBackToScanBtn');
      if (backToScanBtn) {
        backToScanBtn.addEventListener('click', async function () {
          const st = activeManager ? await activeManager.getPackStatus(activeManifest) : { ready: false };
          if (st.ready) {
            await enterViewfinderSafely();
          } else {
            showPanel('gate');
          }
        });
      }

      const startCamBtn = getEl('scannerStartCamBtn');
      if (startCamBtn) startCamBtn.addEventListener('click', startCamera);

      const switchCamBtn = getEl('scannerSwitchCamBtn');
      if (switchCamBtn) {
        switchCamBtn.addEventListener('click', function () {
          facingMode = facingMode === 'environment' ? 'user' : 'environment';
          startCamera();
        });
      }

      const torchBtn = getEl('scannerTorchBtn');
      if (torchBtn) torchBtn.addEventListener('click', toggleTorch);

      const guideBtn = getEl('scannerGuideToggleBtn');
      if (guideBtn) {
        guideBtn.addEventListener('click', function () {
          squareReticle = !squareReticle;
          const ret = getEl('scannerReticle');
          const lbl = getEl('scannerReticleLabel');
          if (ret) ret.classList.toggle('scanner-reticle--square', squareReticle);
          if (lbl) lbl.textContent = squareReticle ? 'Align Front Cover (Square Guide)' : 'Align Barcode / Spine CatNo';
          guideBtn.textContent = squareReticle ? 'Guide: Square Cover' : 'Guide: Barcode / Spine';
        });
      }

      const preDlBtn = getEl('scannerPreDownloadAllBtn');
      if (preDlBtn) {
        preDlBtn.addEventListener('click', async function () {
          if (!activeManager) return;
          const res = await activeManager.downloadAllAvailablePacks(activeManifest);
          if (!res.ok && typeof currentContext.showToast === 'function') {
            currentContext.showToast(res.error || 'Pack download failed');
          } else if (res.ok && typeof currentContext.showToast === 'function') {
            currentContext.showToast('Scanner packs verified & cached');
          }
          await refreshManagerPanel();
        });
      }

      const wipeBtn = getEl('scannerWipeBtn');
      if (wipeBtn) {
        wipeBtn.addEventListener('click', async function () {
          if (!activeManager) return;
          await activeManager.wipeAll({ onBeforeWipe: teardownWorkerAndCamera });
          setHudStatus('Scanner Wiped (0 KB cached)');
          await refreshManagerPanel();
          if (typeof currentContext.showToast === 'function') {
            currentContext.showToast('Wiped Scanner Engine & Cache');
          }
        });
      }

      const packsList = getEl('scannerManagerPacksList');
      if (packsList) {
        packsList.addEventListener('click', async function (e) {
          const rawTarget = e && e.target;
          const t = rawTarget && typeof rawTarget.closest === 'function'
            ? rawTarget.closest('[data-scanner-dl], [data-scanner-del]')
            : rawTarget;
          if (!t || !activeManager || typeof t.getAttribute !== 'function') return;
          const dlId = t.getAttribute('data-scanner-dl');
          const delId = t.getAttribute('data-scanner-del');
          if (dlId) {
            const res = await activeManager.downloadPack(dlId, activeManifest);
            if (!res.ok && typeof currentContext.showToast === 'function') {
              currentContext.showToast(res.error || 'Pack download failed');
            }
            await refreshManagerPanel();
          } else if (delId) {
            if (delId === 'engine-shell') teardownWorkerAndCamera();
            await activeManager.deletePack(delId, activeManifest);
            await refreshManagerPanel();
          }
        });
      }

      const manualBtn = getEl('scannerManualSubmitBtn');
      const manualInput = getEl('scannerManualInput');
      if (manualBtn) manualBtn.addEventListener('click', runManualLookup);
      if (manualInput) {
        manualInput.addEventListener('keydown', function (e) {
          if (e && e.key === 'Enter') {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            runManualLookup();
          }
        });
      }

      const manualResult = getEl('scannerManualResult');
      if (manualResult) {
        manualResult.addEventListener('click', function (e) {
          const btn = e && e.target && (typeof e.target.closest === 'function'
            ? e.target.closest('[data-scanner-jump], [data-scanner-add]')
            : e.target);
          if (!btn || typeof btn.getAttribute !== 'function') return;
          const jumpMode = btn.getAttribute('data-scanner-jump');
          const targetId = btn.getAttribute('data-target-id');
          const addCode = btn.getAttribute('data-scanner-add');
          if (jumpMode && targetId && typeof currentContext.onJumpToItem === 'function') {
            close();
            currentContext.onJumpToItem(jumpMode, targetId);
          } else if (addCode && typeof currentContext.openAddReleaseWithCode === 'function') {
            close();
            currentContext.openAddReleaseWithCode(addCode);
          }
        });
      }

      if (!lifecycleBound && typeof document !== 'undefined') {
        lifecycleBound = true;
        document.addEventListener('keydown', function (e) {
          if (isOpen && e && e.key === 'Escape') close();
        });
        document.addEventListener('visibilitychange', function () {
          if (isOpen && document.visibilityState === 'hidden') {
            close();
          }
        });
        if (root && typeof root.addEventListener === 'function') {
          root.addEventListener('pagehide', function () {
            if (isOpen) close();
          });
        }
      }
    }

    async function open(opts) {
      currentContext = Object.assign({}, baseOpts, opts || {});
      ensureModalDom();

      const managerMod =
        currentContext.scannerManager ||
        (root && root.DiskCrate && root.DiskCrate.scannerManager) ||
        null;
      if (!managerMod) {
        throw new Error('scanner-manager.js must load before scanner-ui.js');
      }

      activeManager =
        currentContext.manager ||
        managerMod.createScannerManager({
          baseUrl: currentContext.baseUrl,
          locationSearch: currentContext.locationSearch,
          config: currentContext.config,
          locationHref: currentContext.locationHref,
          fetchImpl: currentContext.fetchImpl,
          cachesImpl: currentContext.cachesImpl,
          cryptoImpl: currentContext.cryptoImpl,
          storage: currentContext.storage,
          db: currentContext.db
        });

      const modal = getEl('scannerModal');
      if (modal) modal.classList.add('open');
      isOpen = true;

      const gateErr = getEl('scannerGateError');
      if (gateErr) gateErr.classList.add('hidden');
      const manRes = getEl('scannerManualResult');
      if (manRes) manRes.classList.add('hidden');

      try {
        activeManifest = await activeManager.fetchManifest();
      } catch (err) {
        activeManifest = null;
      }

      const status = await activeManager.getPackStatus(activeManifest);
      const sizeEl = getEl('scannerGateSizeText');
      if (sizeEl) {
        if (activeManifest) {
          sizeEl.textContent =
            'Required pack download: ' + managerMod.formatBytes(status.requiredBytes) +
            ' (' + status.packs.filter(function (p) { return p.required; }).length + ' pack, SHA-256 verified)';
        } else {
          sizeEl.textContent = 'Manifest unreachable offline — manual code lookup below works 100% offline.';
        }
      }

      if (status.ready) {
        await enterViewfinderSafely();
      } else {
        showPanel('gate');
      }
    }

    function close() {
      isOpen = false;
      teardownWorkerAndCamera();
      const modal = getEl('scannerModal');
      if (modal) modal.classList.remove('open');
    }

    return {
      open: open,
      close: close,
      isOpen: function () { return isOpen; },
      getActiveWorker: function () { return activeWorker; },
      getManager: function () { return activeManager; }
    };
  }

  const defaultInstance = createScannerUI();
  const exported = {
    createScannerUI: createScannerUI,
    open: defaultInstance.open,
    close: defaultInstance.close,
    isOpen: defaultInstance.isOpen,
    getActiveWorker: defaultInstance.getActiveWorker,
    getManager: defaultInstance.getManager
  };

  if (root) {
    root.DiskCrate = root.DiskCrate || root.CDHunt || {};
    root.DiskCrate.scannerUI = exported;
    root.CDHunt = root.DiskCrate;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
