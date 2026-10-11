/* ============================================================
   BlockCert AI - public verification page
   ID / upload / QR methods, all backed by real API calls.
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  if (!B) return;

  const resultArea = document.getElementById('resultArea');
  let selectedFile = null;

  /* ---------------- tabs ---------------- */
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab !== 'byQr') stopScanner();
    });
  });

  /* ---------------- result rendering ---------------- */
  function renderResult(result) {
    if (!result) {
      resultArea.innerHTML = B.errorState('Verification failed', 'The server did not return a result.');
      return;
    }

    const cert = result.certificate;
    const facts = [];
    if (cert) {
      facts.push(['Certificate ID', cert.certificateId]);
      facts.push(['Institution', cert.institution]);
      facts.push(['Credential', cert.credential + (cert.department ? ' · ' + cert.department : '')]);
      facts.push(['Issued', B.fmtDate(cert.issueDate)]);
      facts.push(['Certificate type', cert.certificateType]);
      facts.push(['Status', B.statusBadge(cert.status)]);
    }

    // check grid: blockchain / hash / issuer / revocation / AI
    const checks = [];
    if (result.blockchain && result.blockchain.available) {
      checks.push({
        status: result.blockchain.recordFound ? 'pass' : 'fail',
        name: result.blockchain.recordFound ? 'Blockchain ✓ record found' : 'Blockchain ✕ no record',
        note:
          (result.blockchain.recordFound && result.blockchain.timestampIso
            ? 'Registered ' + B.fmtDateTime(result.blockchain.timestampIso) + '. '
            : '') + result.blockchain.message,
      });
    } else if (result.blockchain && result.blockchain.message && result.certificate) {
      checks.push({ status: 'warning', name: 'Blockchain', note: result.blockchain.message });
    }

    if (result.hash && result.hash.performed) {
      checks.push({
        status: result.hash.match ? 'pass' : 'fail',
        name: result.hash.match ? 'SHA-256 ✓ match' : 'SHA-256 ✕ mismatch',
        note: result.hash.message,
      });
    }
    if (result.issuer) {
      checks.push({
        status: result.issuer.verified ? 'pass' : 'warning',
        name: result.issuer.verified ? 'Issuer ✓ verified' : 'Issuer ⚠ not fully verified',
        note: result.issuer.message,
      });
    }
    if (result.revocation && result.certificate) {
      checks.push({
        status: result.revocation.revoked ? 'fail' : 'pass',
        name: result.revocation.revoked ? 'Revocation status' : 'Revocation status',
        note: (result.revocation.revoked ? '⊘ ' : '✓ ') + result.revocation.message,
      });
    }
    if (result.ai && result.ai.performed) {
      const band = result.riskSummary ? result.riskSummary.band : 'low';
      checks.push({
        status: band === 'high' ? 'fail' : band === 'medium' ? 'warning' : 'pass',
        name: 'AI risk ' + result.ai.riskScore + '/100 (' + result.ai.classification + ')',
        note: result.ai.message,
      });
    }

    const aiBlock = result.ai && result.ai.performed
      ? `<div class="panel mt-2"><div class="panel-head"><h2>AI document-risk assessment</h2><span class="badge badge-${
          result.riskSummary && result.riskSummary.band === 'low' ? 'ok' : result.riskSummary && result.riskSummary.band === 'medium' ? 'warn' : 'bad'
        }"><span aria-hidden="true">◉</span> ${B.escapeHtml(result.ai.classification)}</span></div>
         <div class="panel-body">
           ${B.renderRiskMeter(result.ai.riskScore, result.riskSummary ? result.riskSummary.band : null)}
           <div class="mt-2">${B.renderCheckGrid(result.ai)}</div>
           ${result.ai.findings && result.ai.findings.length ? '<h3 class="mt-2">Findings</h3><ul>' + result.ai.findings.map((f) => '<li>' + B.escapeHtml(f) + '</li>').join('') + '</ul>' : ''}
         </div></div>`
      : `<div class="panel mt-2"><div class="panel-head"><h2>AI document-risk assessment</h2></div>
         <div class="panel-body"><p class="muted mb-0">${B.escapeHtml((result.ai && result.ai.message) || 'AI analysis has not been performed.')}</p></div></div>`;

    const actions = `
      <div class="btn-row mt-2">
        <button class="btn btn-outline btn-sm" type="button" id="downloadReportBtn">Download Report</button>
        <button class="btn btn-outline btn-sm" type="button" id="shareBtn">Share Verification</button>
      </div>`;

    resultArea.innerHTML = `
      ${B.renderResultHero(result.finalResult, result.message)}
      <div class="panel mt-2"><div class="panel-body">
        ${result.note ? `<p class="small muted">${B.escapeHtml(result.note)}</p>` : ''}
        ${facts.length ? `<div class="result-facts">${facts
          .map(([k, v]) => `<div class="fact"><div class="k">${B.escapeHtml(k)}</div><div class="v">${v}</div></div>`)
          .join('')}</div>` : ''}
        <h3 class="mt-2">Verification checks</h3>
        <div class="check-grid">
          ${checks
            .map(
              (c) => `<div class="check-item ${c.status}"><span class="ci-glyph" aria-hidden="true">${
                c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '⚠'
              }</span><div><strong>${B.escapeHtml(c.name)}</strong>${c.note ? `<span class="ci-note">${B.escapeHtml(c.note)}</span>` : ''}</div></div>`
            )
            .join('')}
        </div>
        <p class="small muted mt-2 mb-0">Verified at ${B.fmtDateTime(result.verifiedAt)}${result.documentChecked ? ' · document provided' : ' · record lookup only (no document provided)'}${result.verificationId ? ' · record #' + result.verificationId : ''}</p>
      </div></div>
      ${aiBlock}
      ${result.technical ? B.technicalPanel(result.technical) : ''}
      ${actions}
      <div class="disclaimer">AI provides a document-risk assessment. Blockchain verification confirms whether the document matches the official issuer record. AI results are not absolute proof of authenticity.</div>
    `;

    B.bindCopyButtons(resultArea);

    const shareBtn = document.getElementById('shareBtn');
    if (shareBtn && cert) {
      shareBtn.addEventListener('click', async () => {
        const url = location.origin + '/verify.html?id=' + encodeURIComponent(cert.certificateId);
        try {
          if (navigator.share) {
            await navigator.share({ title: 'BlockCert verification', url });
          } else {
            await navigator.clipboard.writeText(url);
            B.toast('Verification link copied.', 'success');
          }
        } catch (_) {
          /* user dismissed */
        }
      });
    }

    const reportBtn = document.getElementById('downloadReportBtn');
    if (reportBtn && result.certificate) {
      reportBtn.addEventListener('click', () => downloadReport(result));
    }

    resultArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function downloadReport(result) {
    const rows = [
      ['BlockCert AI Verification Report'],
      ['Generated', new Date().toISOString()],
      [],
      ['Certificate ID', result.certificate.certificateId],
      ['Institution', result.certificate.institution],
      ['Credential', result.certificate.credential],
      ['Certificate type', result.certificate.certificateType],
      ['Issue date', result.certificate.issueDate],
      ['Final result', result.finalResult],
      ['Document checked', result.documentChecked ? 'Yes' : 'No'],
      ['SHA-256 uploaded', result.hash && result.hash.performed ? result.hash.uploadedHash : 'Not checked'],
      ['SHA-256 registered', result.hash && result.hash.performed ? result.hash.storedHash : 'Not checked'],
      ['Hash match', result.hash && result.hash.performed ? (result.hash.match ? 'MATCH' : 'MISMATCH') : 'Not checked'],
      ['Blockchain record', result.blockchain.message || ''],
      ['Issuer verified', result.issuer ? (result.issuer.verified ? 'Yes' : 'No') : 'Not checked'],
      ['Revocation', result.revocation ? result.revocation.message : 'Not checked'],
      ['AI analysis', result.ai && result.ai.performed ? result.ai.message + ' (provider: ' + result.ai.provider + ', model: ' + result.ai.model + ')' : (result.ai ? result.ai.message : 'Not performed')],
      ['Verification timestamp', result.verifiedAt],
      [],
      ['Disclaimer', 'AI provides a document-risk assessment. Blockchain verification confirms whether the document matches the official issuer record. AI results are not absolute proof of authenticity.'],
    ];
    B.downloadCsv('verification-report-' + result.certificate.certificateId + '.csv', rows);
    B.toast('Verification report downloaded.', 'success');
  }

  async function runVerification(promise, busyMsg) {
    resultArea.innerHTML = B.loadingState(busyMsg || 'Checking blockchain…');
    try {
      const res = await promise;
      renderResult(res.data);
    } catch (err) {
      resultArea.innerHTML = B.errorState('Verification could not be completed', err.message);
    }
  }

  /* ---------------- by ID ---------------- */
  const idForm = document.getElementById('idForm');
  idForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('certificateId').value.trim().toUpperCase();
    if (!/^CERT-\d{4}-\d{6}$/.test(id)) {
      B.showAlert('Certificate ID must use the format CERT-YYYY-XXXXXX.', 'warn');
      return;
    }
    B.hideAlert();
    runVerification(B.api('/api/verification/id', { method: 'POST', body: { certificateId: id } }), 'Checking database and blockchain…');
  });

  /* ---------------- by upload ---------------- */
  const uploadZone = document.getElementById('uploadZone');
  const uploadInput = document.getElementById('uploadInput');
  const uploadName = document.getElementById('uploadFileName');

  uploadZone.addEventListener('click', () => uploadInput.click());
  uploadZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      uploadInput.click();
    }
  });
  ['dragover', 'dragenter'].forEach((ev) =>
    uploadZone.addEventListener(ev, (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    uploadZone.addEventListener(ev, (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
    })
  );
  uploadZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });
  uploadInput.addEventListener('change', () => {
    if (uploadInput.files[0]) setFile(uploadInput.files[0]);
  });

  function setFile(file) {
    const okExt = /\.(pdf|png|jpe?g)$/i.test(file.name);
    if (!okExt) {
      B.showAlert('Only PDF, PNG or JPG files can be verified.', 'warn');
      return;
    }
    selectedFile = file;
    uploadName.hidden = false;
    uploadName.textContent = file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
  }

  const uploadForm = document.getElementById('uploadForm');
  const busyRow = document.getElementById('uploadBusy');
  const busyText = document.getElementById('uploadBusyText');

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    B.hideAlert();
    if (!selectedFile) {
      B.showAlert('Choose a certificate document to verify.', 'warn');
      return;
    }
    const id = document.getElementById('certificateIdUpload').value.trim().toUpperCase();
    if (id && !/^CERT-\d{4}-\d{6}$/.test(id)) {
      B.showAlert('Certificate ID must use the format CERT-YYYY-XXXXXX.', 'warn');
      return;
    }

    const btn = document.getElementById('uploadBtn');
    B.setButtonBusy(btn, true, 'Verifying…');
    busyRow.hidden = false;
    const stages = ['Uploading document…', 'Calculating SHA-256…', 'Checking blockchain…', 'Analyzing document…'];
    let i = 0;
    busyText.textContent = stages[0];
    const timer = setInterval(() => {
      i = Math.min(i + 1, stages.length - 1);
      busyText.textContent = stages[i];
    }, 1600);

    const fd = new FormData();
    fd.append('document', selectedFile);
    if (id) fd.append('certificateId', id);

    try {
      const res = await B.api('/api/verification/upload', { method: 'POST', body: fd });
      renderResult(res.data);
    } catch (err) {
      resultArea.innerHTML = B.errorState('Verification could not be completed', err.message);
    } finally {
      clearInterval(timer);
      busyRow.hidden = true;
      B.setButtonBusy(btn, false);
    }
  });

  /* ---------------- by QR ---------------- */
  const startBtn = document.getElementById('startScanBtn');
  const stopBtn = document.getElementById('stopScanBtn');
  const scannerBox = document.getElementById('scannerBox');
  const scannerStatus = document.getElementById('scannerStatus');
  const scanCtx = { box: scannerBox, statusEl: scannerStatus, buttons: { start: startBtn, stop: stopBtn } };

  function stopScanner() {
    window.BlockQr.stop(scanCtx);
  }

  startBtn.addEventListener('click', () => window.BlockQr.start({ ...scanCtx, onResult: handleQrData }));
  stopBtn.addEventListener('click', stopScanner);

  function handleQrData(data) {
    if (!data) return;
    runVerification(B.api('/api/verification/qr', { method: 'POST', body: { qrData: data } }), 'Running blockchain lookup…');
  }

  document.getElementById('qrPasteForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = document.getElementById('qrPaste').value.trim();
    if (!value) {
      B.showAlert('Paste the QR content or a certificate ID first.', 'warn');
      return;
    }
    handleQrData(value);
  });

  /* ---------------- deep link: /verify.html?id=CERT-... ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
    const id = B.qs('id');
    if (id) {
      document.getElementById('certificateId').value = id.toUpperCase();
      runVerification(B.api('/api/verification/id', { method: 'POST', body: { certificateId: id.toUpperCase() } }), 'Checking database and blockchain…');
    }
  });
})();
