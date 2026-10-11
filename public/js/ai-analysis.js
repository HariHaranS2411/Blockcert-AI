/* ============================================================
   BlockCert AI - AI analysis page
   Shows real analyses for a certificate, or an honest
   "unavailable / not performed" state.
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  if (!B) return;

  const area = document.getElementById('aiArea');
  const certificateId = B.qs('certificateId');

  area.innerHTML = B.loadingState('Loading AI analyses…');

  if (!certificateId) {
    area.innerHTML = B.emptyState('No certificate specified', 'Open this page from a certificate record.', '◉');
    return;
  }

  B.api('/api/ai/' + encodeURIComponent(certificateId))
    .then((res) => {
      const d = res.data;
      const header = `
        <div class="dash-head">
          <div>
            <h1 style="font-size:1.5rem">AI analysis — <span class="mono">${B.escapeHtml(certificateId)}</span></h1>
            <p>What can I do here? Review the document-risk assessment produced by a real AI provider for this certificate.</p>
          </div>
          <div class="btn-row">
            <a class="btn btn-outline btn-sm" href="/certificate-details.html?id=${encodeURIComponent(B.qs('cid') || '')}">Back to certificate</a>
            <a class="btn btn-primary btn-sm" href="/verify.html?id=${encodeURIComponent(certificateId)}">Run full verification</a>
          </div>
        </div>`;

      if (!d.analyses.length) {
        area.innerHTML = header + B.emptyState(d.emptyState || 'AI analysis has not been performed.', 'Request an analysis from the certificate details page.', '◉');
        return;
      }

      const blocks = d.analyses
        .map((a) => {
          if (a.status === 'unavailable') {
            return `<div class="panel"><div class="panel-head"><h2>Analysis</h2><span class="badge badge-warn"><span aria-hidden="true">⚠</span> Unavailable</span></div>
              <div class="panel-body"><p class="mb-0">AI analysis is currently unavailable. ${B.escapeHtml(a.unavailableReason || '')}</p>
              <p class="small muted mb-0">${B.fmtDateTime(a.createdAt)}</p></div></div>`;
          }
          const band = a.riskScore < (d.thresholds ? d.thresholds.suspicious : 31) ? 'low' : a.riskScore < (d.thresholds ? d.thresholds.tampered : 71) ? 'medium' : 'high';
          return `<div class="panel"><div class="panel-head">
              <h2>${B.escapeHtml(a.classification)}</h2>
              <span class="badge badge-${band === 'low' ? 'ok' : band === 'medium' ? 'warn' : 'bad'}"><span aria-hidden="true">◉</span> ${a.riskScore}/100</span>
            </div>
            <div class="panel-body">
              ${B.renderRiskMeter(a.riskScore, band)}
              ${a.findings && a.findings.checks ? '<div class="mt-2">' + B.renderCheckGrid({ performed: true, checks: a.findings.checks }) + '</div>' : ''}
              ${a.findings && a.findings.findings && a.findings.findings.length ? '<h3 class="mt-2">Findings</h3><ul>' + a.findings.findings.map((f) => '<li>' + B.escapeHtml(f) + '</li>').join('') + '</ul>' : ''}
              <p class="small muted mb-0">Provider ${B.escapeHtml(a.provider || '—')} · model ${B.escapeHtml(a.model || '—')} · ${B.fmtDateTime(a.createdAt)}</p>
            </div></div>`;
        })
        .join('');

      area.innerHTML =
        header +
        blocks +
        `<div class="disclaimer">${B.escapeHtml(
          d.disclaimer ||
            'AI provides a document-risk assessment. Blockchain verification confirms whether the document matches the official issuer record. AI results are not absolute proof of authenticity.'
        )}</div>`;
    })
    .catch((err) => {
      if (err.status === 401) {
        localStorage.setItem('blockcert_redirect', location.pathname + location.search);
        location.href = '/login.html';
        return;
      }
      area.innerHTML = B.errorState('AI analysis unavailable', err.message);
    });
})();
