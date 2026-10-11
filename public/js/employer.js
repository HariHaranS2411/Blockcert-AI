/* ============================================================
   BlockCert AI - employer verification portal
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  const D = window.Dash;
  if (!B || !D) return;

  const user = D.guardRole(['EMPLOYER', 'ADMIN']);
  if (!user) return;

  D.buildSidebar({
    active: 'portal',
    items: [
      { section: 'Verification' },
      { id: 'portal', label: 'Verification Portal', href: '/employer-dashboard.html', icon: '✓' },
      { id: 'history', label: 'Verification History', href: '/verification-history.html', icon: '⏱' },
      { section: 'Public' },
      { id: 'verify', label: 'Quick verify', href: '/verify.html', icon: '◇' },
      { id: 'how', label: 'How it works', href: '/how-it-works.html', icon: 'ⓘ' },
    ],
  });

  /* tabs */
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab !== 'empQr') stopScanner();
    });
  });

  const resultArea = document.getElementById('empResult');

  function renderResult(result) {
    const cert = result.certificate;
    const facts = [];
    if (cert) {
      facts.push(['Certificate ID', cert.certificateId]);
      facts.push(['Institution', cert.institution]);
      facts.push(['Credential', cert.credential]);
      facts.push(['Issue date', B.fmtDate(cert.issueDate)]);
      facts.push(['Status', B.statusBadge(cert.status)]);
    }
    facts.push(['Final result', B.statusBadge(result.finalResult)]);
    if (result.issuer) facts.push(['Issuer', result.issuer.verified ? '✓ Verified' : '⚠ ' + result.issuer.message]);
    if (result.revocation && cert) facts.push(['Revocation', result.revocation.revoked ? '⊘ Revoked' : '✓ Clear']);
    facts.push(['Document checked', result.documentChecked ? 'Yes — SHA-256 compared' : 'No — record lookup only']);
    if (result.ai) facts.push(['AI analysis', result.ai.performed ? result.ai.message : (result.ai.message || 'Not performed')]);

    resultArea.innerHTML = `
      ${B.renderResultHero(result.finalResult, result.message)}
      <div class="panel mt-2"><div class="panel-body">
        ${result.note ? `<p class="small muted">${B.escapeHtml(result.note)}</p>` : ''}
        <div class="result-facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${B.escapeHtml(k)}</div><div class="v">${v}</div></div>`).join('')}</div>
        ${
          result.hash && result.hash.performed
            ? `<div class="check-grid mt-2">
                <div class="check-item ${result.hash.match ? 'pass' : 'fail'}"><span class="ci-glyph" aria-hidden="true">${result.hash.match ? '✓' : '✕'}</span><div><strong>${result.hash.match ? 'SHA-256 ✓ match' : 'SHA-256 ✕ mismatch'}</strong><span class="ci-note">${B.escapeHtml(result.hash.message)}</span></div></div>
                <div class="check-item ${result.blockchain.recordFound ? 'pass' : 'fail'}"><span class="ci-glyph" aria-hidden="true">${result.blockchain.recordFound ? '✓' : '✕'}</span><div><strong>Blockchain record</strong><span class="ci-note">${B.escapeHtml(result.blockchain.message)}</span></div></div>
               </div>`
            : ''
        }
        <p class="small muted mt-2 mb-0">Verified at ${B.fmtDateTime(result.verifiedAt)}</p>
      </div></div>
      ${result.technical ? B.technicalPanel(result.technical) : ''}
      <div class="btn-row mt-2">
        <button class="btn btn-outline btn-sm" type="button" id="empReportBtn">Download report (CSV)</button>
        <a class="btn btn-outline btn-sm" href="/verification-result.html?ref=${encodeURIComponent(result.certificate ? result.certificate.certificateId : '')}">Open result page</a>
      </div>
      <div class="disclaimer">AI provides a document-risk assessment. Blockchain verification confirms whether the document matches the official issuer record. AI results are not absolute proof of authenticity.</div>`;

    B.bindCopyButtons(resultArea);

    const reportBtn = document.getElementById('empReportBtn');
    if (reportBtn) {
      reportBtn.addEventListener('click', () => {
        B.downloadCsv('verification-' + (cert ? cert.certificateId : result.finalResult) + '.csv', [
          ['BlockCert AI Verification Report'],
          ['Generated', new Date().toISOString()],
          [],
          ['Certificate ID', cert ? cert.certificateId : 'Not found'],
          ['Institution', cert ? cert.institution : 'Not found'],
          ['Credential', cert ? cert.credential : 'Not found'],
          ['Final result', result.finalResult],
          ['Document checked', result.documentChecked ? 'Yes' : 'No'],
          ['Uploaded SHA-256', result.hash && result.hash.performed ? result.hash.uploadedHash : 'Not checked'],
          ['Registered SHA-256', result.hash && result.hash.performed ? result.hash.storedHash : 'Not checked'],
          ['Hash match', result.hash && result.hash.performed ? (result.hash.match ? 'MATCH' : 'MISMATCH') : 'Not checked'],
          ['Blockchain', result.blockchain.message || ''],
          ['Issuer verified', result.issuer ? (result.issuer.verified ? 'Yes' : 'No') : 'Not checked'],
          ['AI analysis', result.ai ? result.ai.message : 'Not performed'],
          ['Verified at', result.verifiedAt],
        ]);
        B.toast('Report downloaded.', 'success');
      });
    }

    resultArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
    loadHistory();
  }

  async function run(promise, busy) {
    resultArea.innerHTML = B.loadingState(busy || 'Checking blockchain…');
    try {
      const res = await promise;
      renderResult(res.data);
    } catch (err) {
      resultArea.innerHTML = B.errorState('Verification could not be completed', err.message);
    }
  }

  /* ID */
  document.getElementById('empIdForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('empCertId').value.trim().toUpperCase();
    if (!/^CERT-\d{4}-\d{6}$/.test(id)) {
      B.showAlert('Certificate ID must use the format CERT-YYYY-XXXXXX.', 'warn');
      return;
    }
    B.hideAlert();
    run(B.api('/api/verification/id', { method: 'POST', body: { certificateId: id } }));
  });

  /* Upload */
  const zone = document.getElementById('empZone');
  const input = document.getElementById('empFileInput');
  let file = null;
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragover', 'dragenter'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => { if (input.files[0]) setFile(input.files[0]); });

  function setFile(f) {
    if (!/\.(pdf|png|jpe?g)$/i.test(f.name)) {
      B.showAlert('Only PDF, PNG or JPG files can be verified.', 'warn');
      return;
    }
    file = f;
    document.getElementById('empFileName').hidden = false;
    document.getElementById('empFileName').textContent = f.name;
  }

  document.getElementById('empUploadForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!file) {
      B.showAlert('Choose a certificate document first.', 'warn');
      return;
    }
    const fd = new FormData();
    fd.append('document', file);
    run(B.api('/api/verification/upload', { method: 'POST', body: fd }), 'Uploading, hashing and checking blockchain…');
  });

  /* QR */
  const scannerBox = document.getElementById('empScannerBox');
  const scannerStatus = document.getElementById('empScannerStatus');
  const startScanBtn = document.getElementById('empStartScan');
  const stopScanBtn = document.getElementById('empStopScan');
  const scanCtx = {
    box: scannerBox,
    statusEl: scannerStatus,
    buttons: { start: startScanBtn, stop: stopScanBtn },
  };

  function stopScanner() {
    window.BlockQr.stop(scanCtx);
  }

  function handleQr(data) {
    if (!data) return;
    run(B.api('/api/verification/qr', { method: 'POST', body: { qrData: data } }));
  }

  startScanBtn.addEventListener('click', () => window.BlockQr.start({ ...scanCtx, onResult: handleQr }));
  stopScanBtn.addEventListener('click', stopScanner);
  document.getElementById('empPasteForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = document.getElementById('empPaste').value.trim();
    if (!value) { B.showAlert('Paste the QR content first.', 'warn'); return; }
    handleQr(value);
  });

  /* Bulk */
  const bulkZone = document.getElementById('empBulkZone');
  const bulkInput = document.getElementById('empBulkInput');
  let bulkFile = null;
  bulkZone.addEventListener('click', () => bulkInput.click());
  bulkZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bulkInput.click(); } });
  bulkInput.addEventListener('change', () => {
    if (bulkInput.files[0] && bulkInput.files[0].name.toLowerCase().endsWith('.csv')) {
      bulkFile = bulkInput.files[0];
      document.getElementById('empBulkFileName').hidden = false;
      document.getElementById('empBulkFileName').textContent = bulkFile.name;
    } else if (bulkInput.files[0]) {
      B.showAlert('Bulk verification requires a .csv file.', 'warn');
      bulkInput.value = '';
    }
  });

  document.getElementById('empBulkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!bulkFile) { B.showAlert('Choose a CSV file first.', 'warn'); return; }
    const btn = document.getElementById('empBulkBtn');
    B.setButtonBusy(btn, true, 'Verifying rows…');
    const fd = new FormData();
    fd.append('file', bulkFile);
    const out = document.getElementById('empBulkResults');
    try {
      const res = await B.api('/api/verification/bulk', { method: 'POST', body: fd });
      const d = res.data;
      const s = d.summary;
      out.innerHTML = `
        <div class="alert show ${s.TAMPERED || s.REVOKED ? 'alert-warn' : 'alert-success'}">${B.escapeHtml(res.message)}</div>
        <div class="stat-row">
          <div class="stat ok"><div class="label">Verified</div><div class="value">${s.VERIFIED}</div></div>
          <div class="stat warn"><div class="label">Suspicious</div><div class="value">${s.SUSPICIOUS}</div></div>
          <div class="stat bad"><div class="label">Tampered</div><div class="value">${s.TAMPERED}</div></div>
          <div class="stat"><div class="label">Revoked</div><div class="value">${s.REVOKED}</div></div>
          <div class="stat"><div class="label">Not found</div><div class="value">${s.NOT_FOUND}</div></div>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Row</th><th>Certificate</th><th>Result</th><th>Institution</th><th>Detail</th></tr></thead>
          <tbody>${d.results.map((r) => `<tr>
            <td>${r.row}</td>
            <td class="mono">${B.escapeHtml(r.certificateId)}</td>
            <td>${B.statusBadge(r.finalResult)}</td>
            <td>${B.escapeHtml(r.institution || '—')}</td>
            <td class="small">${B.escapeHtml(r.message || '')}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <div class="btn-row mt-2">
          <button class="btn btn-outline btn-sm" type="button" id="bulkReportBtn">Download summary (CSV)</button>
          <button class="btn btn-outline btn-sm" type="button" id="bulkPdfBtn">Download report (printable)</button>
        </div>`;

      document.getElementById('bulkReportBtn').addEventListener('click', () => {
        B.downloadCsv('bulk-verification-report.csv', [
          ['row', 'certificateId', 'finalResult', 'institution', 'certificateStatus', 'blockchainAvailable', 'message'],
          ...d.results.map((r) => [r.row, r.certificateId, r.finalResult, r.institution || '', r.status || '', r.blockchainAvailable ? 'Yes' : 'No', r.message || '']),
        ]);
      });
      document.getElementById('bulkPdfBtn').addEventListener('click', () => {
        const w = window.open('', '_blank');
        if (!w) { B.toast('Allow pop-ups to print the report.', 'error'); return; }
        w.document.write(`<!DOCTYPE html><html><head><title>Bulk verification report</title><style>
          body{font-family:system-ui,sans-serif;padding:24px;color:#0f172a}
          h1{font-size:20px}table{border-collapse:collapse;width:100%;font-size:13px}
          th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left}
          th{background:#f1f5f9}small{color:#64748b}</style></head><body>
          <h1>BlockCert AI — bulk verification report</h1>
          <small>Generated ${new Date().toLocaleString()}</small>
          <p>Verified ${s.VERIFIED} · Suspicious ${s.SUSPICIOUS} · Tampered ${s.TAMPERED} · Revoked ${s.REVOKED} · Not found ${s.NOT_FOUND}</p>
          <table><thead><tr><th>Row</th><th>Certificate</th><th>Result</th><th>Institution</th><th>Detail</th></tr></thead>
          <tbody>${d.results.map((r) => `<tr><td>${r.row}</td><td>${B.escapeHtml(r.certificateId)}</td><td>${B.escapeHtml(r.finalResult)}</td><td>${B.escapeHtml(r.institution || '')}</td><td>${B.escapeHtml(r.message || '')}</td></tr>`).join('')}</tbody></table>
          <p><small>AI provides a document-risk assessment. Blockchain verification confirms whether the document matches the official issuer record.</small></p>
          <script>window.print()<\/script></body></html>`);
      });

      bulkFile = null;
      bulkInput.value = '';
      document.getElementById('empBulkFileName').hidden = true;
      loadHistory();
    } catch (err) {
      out.innerHTML = `<div class="alert show alert-error">${B.escapeHtml(err.message)}</div>`;
    } finally {
      B.setButtonBusy(btn, false);
    }
  });

  /* history */
  async function loadHistory() {
    const area = document.getElementById('empHistory');
    try {
      const res = await B.api('/api/employer/history');
      const history = res.data.history;
      if (!history.length) {
        area.innerHTML = B.emptyState('No verification activity yet.', 'Verifications you perform appear here.', '⏱');
        return;
      }
      area.innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr><th>Certificate</th><th>Institution</th><th>Method</th><th>Result</th><th>When</th></tr></thead>
        <tbody>${history.map((h) => `<tr>
          <td class="mono">${B.escapeHtml(h.certificateRef)}</td>
          <td>${B.escapeHtml(h.institution || '—')}</td>
          <td>${B.escapeHtml(h.method)}</td>
          <td>${B.statusBadge(h.finalResult)}</td>
          <td>${B.fmtDateTime(h.createdAt)}</td>
        </tr>`).join('')}</tbody></table></div>`;
    } catch (err) {
      area.innerHTML = B.errorState('History unavailable', err.message);
    }
  }

  document.getElementById('exportCsvBtn').addEventListener('click', async () => {
    try {
      const res = await B.api('/api/employer/history');
      B.downloadCsv('verification-history.csv', [
        ['certificateId', 'institution', 'method', 'hashMatch', 'blockchainStatus', 'aiResult', 'finalResult', 'timestamp'],
        ...res.data.history.map((h) => [h.certificateRef, h.institution || '', h.method, h.hashMatch === null ? '' : h.hashMatch ? 'MATCH' : 'MISMATCH', h.blockchainStatus || '', h.aiResult || '', h.finalResult, h.createdAt]),
      ]);
      B.toast('History exported.', 'success');
    } catch (err) {
      B.toast('Export failed: ' + err.message, 'error');
    }
  });

  document.addEventListener('DOMContentLoaded', loadHistory);
})();
