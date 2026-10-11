/* ============================================================
   BlockCert AI - shared QR scanner helper
   Camera scanning via the vendored qr-scanner library, with an
   honest fallback when the camera is unavailable (paste the QR
   content instead). Never fakes a scan result.
   ============================================================ */
(function () {
  'use strict';

  let scanner = null;

  /**
   * Start scanning into `box`. statusEl is restored on stop/failure.
   * onResult(rawValue) fires once per successful decode (scanner stops first).
   * buttons: { start, stop } elements toggled around the camera session.
   */
  async function start({ box, statusEl, onResult, buttons }) {
    if (!box || !statusEl) return;
    statusEl.textContent = 'Loading camera scanner…';
    try {
      const module = await import('/vendor/qr-scanner/qr-scanner.min.js');
      const QrScanner = module.default || window.QrScanner;
      box.innerHTML = '';
      const video = document.createElement('video');
      box.appendChild(video);
      scanner = new QrScanner(
        video,
        (value) => {
          stop({ box, statusEl, buttons });
          onResult(typeof value === 'string' ? value : value.data);
        },
        { highlightScanRegion: true }
      );
      await scanner.start();
      if (buttons) {
        if (buttons.stop) buttons.stop.hidden = false;
        if (buttons.start) buttons.start.hidden = true;
      }
    } catch (err) {
      scanner = null;
      box.innerHTML = '';
      box.appendChild(statusEl);
      statusEl.textContent = 'Camera scanning is unavailable: ' + (err && err.message ? err.message : err) + '. Paste the QR content below instead.';
      if (buttons) {
        if (buttons.start) buttons.start.hidden = false;
        if (buttons.stop) buttons.stop.hidden = true;
      }
    }
  }

  function stop({ box, statusEl, buttons }) {
    if (scanner) {
      try {
        scanner.stop();
        scanner.destroy();
      } catch (_) {
        /* already stopped */
      }
      scanner = null;
    }
    if (box && statusEl && !box.contains(statusEl)) {
      box.innerHTML = '';
      box.appendChild(statusEl);
      statusEl.textContent = 'Camera not started.';
    }
    if (buttons) {
      if (buttons.stop) buttons.stop.hidden = true;
      if (buttons.start) buttons.start.hidden = false;
    }
  }

  /** Validate that scanned/pasted content is a BlockCert verification payload. */
  function parsePayload(raw) {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (/^CERT-\d{4}-\d{6}$/.test(trimmed)) return trimmed;
    try {
      const url = new URL(trimmed);
      const id = url.searchParams.get('id');
      if (id && /^CERT-\d{4}-\d{6}$/i.test(id)) return id.toUpperCase();
    } catch (_) {
      /* not a URL */
    }
    return null;
  }

  window.BlockQr = { start, stop, parsePayload };
})();
