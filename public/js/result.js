/* ============================================================
   BlockCert AI - verification result page
   Renders a fresh verification run for ?id=CERT-...
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  if (!B) return;

  const area = document.getElementById('resultArea');
  const id = B.qs('ref') || B.qs('id');

  if (!id) {
    area.innerHTML = B.emptyState('No certificate specified', 'Open this page from a verification link or the Verify page.', '◇');
    return;
  }

  area.innerHTML = B.loadingState('Checking database and blockchain…');

  B.api('/api/verification/id', { method: 'POST', body: { certificateId: id.toUpperCase() } })
    .then((res) => {
      const r = res.data;
      const cert = r.certificate;
      const facts = [];
      if (cert) {
        facts.push(['Certificate ID', cert.certificateId]);
        facts.push(['Institution', cert.institution]);
        facts.push(['Credential', cert.credential]);
        facts.push(['Certificate type', cert.certificateType]);
        facts.push(['Issue date', B.fmtDate(cert.issueDate)]);
        facts.push(['Status', B.statusBadge(cert.status)]);
      }
      facts.push(['Final result', B.statusBadge(r.finalResult)]);

      area.innerHTML = `
        ${B.renderResultHero(r.finalResult, r.message)}
        <div class="panel mt-2"><div class="panel-body">
          ${r.note ? `<p class="small muted">${B.escapeHtml(r.note)}</p>` : ''}
          <div class="result-facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${B.escapeHtml(k)}</div><div class="v">${v}</div></div>`).join('')}</div>
          <div class="check-grid mt-2">
            <div class="check-item ${r.blockchain.available && r.blockchain.recordFound ? 'pass' : 'fail'}">
              <span class="ci-glyph" aria-hidden="true">${r.blockchain.available && r.blockchain.recordFound ? '✓' : '✕'}</span>
              <div><strong>Blockchain record</strong><span class="ci-note">${B.escapeHtml(r.blockchain.message || '')}</span></div>
            </div>
            <div class="check-item ${r.issuer && r.issuer.verified ? 'pass' : 'warning'}">
              <span class="ci-glyph" aria-hidden="true">${r.issuer && r.issuer.verified ? '✓' : '⚠'}</span>
              <div><strong>Issuer</strong><span class="ci-note">${B.escapeHtml(r.issuer ? r.issuer.message : 'Not checked')}</span></div>
            </div>
            <div class="check-item ${r.revocation && r.revocation.revoked ? 'fail' : 'pass'}">
              <span class="ci-glyph" aria-hidden="true">${r.revocation && r.revocation.revoked ? '⊘' : '✓'}</span>
              <div><strong>Revocation status</strong><span class="ci-note">${B.escapeHtml(r.revocation ? r.revocation.message : 'Not checked')}</span></div>
            </div>
            <div class="check-item insufficient">
              <span class="ci-glyph" aria-hidden="true">—</span>
              <div><strong>Document hash</strong><span class="ci-note">${B.escapeHtml(r.hash.message)}</span></div>
            </div>
          </div>
          <p class="small muted mt-2 mb-0">Verified at ${B.fmtDateTime(r.verifiedAt)} · verification record #${r.verificationId}</p>
        </div></div>
        ${r.technical ? B.technicalPanel(r.technical) : ''}
        <div class="btn-row mt-2">
          <button class="btn btn-outline btn-sm" type="button" id="shareBtn">Share Verification</button>
          <a class="btn btn-outline btn-sm" href="/verify.html">Verify a document instead</a>
        </div>
        <div class="disclaimer">AI provides a document-risk assessment. Blockchain verification confirms whether the document matches the official issuer record. AI results are not absolute proof of authenticity.</div>`;

      B.bindCopyButtons(area);
      document.getElementById('shareBtn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(location.href);
          B.toast('Link copied.', 'success');
        } catch (_) {
          B.toast('Could not copy the link.', 'error');
        }
      });
    })
    .catch((err) => {
      area.innerHTML = B.errorState('Verification could not be completed', err.message);
    });
})();
