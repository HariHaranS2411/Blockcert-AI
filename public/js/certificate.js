/* ============================================================
   BlockCert AI - certificate details page
   Full authorized detail view: status, chain info, AI analyses,
   revocation history, verification log, QR.
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  if (!B) return;

  const body = document.getElementById('pageBody');
  const id = B.qs('id');

  if (!B.isLoggedIn()) {
    localStorage.setItem('blockcert_redirect', '/certificate-details.html?id=' + encodeURIComponent(id || ''));
    location.href = '/login.html';
    return;
  }

  body.innerHTML = B.loadingState('Loading certificate…');

  function render(data) {
    const c = data.certificate;
    const revocation = data.revocations && data.revocations[0];

    body.innerHTML = `
      <div class="dash-head">
        <div>
          <h1 style="font-size:1.6rem">${B.escapeHtml(c.certificateId)}</h1>
          <p>${B.escapeHtml(data.institution.name)} · ${B.escapeHtml(c.degree)}</p>
        </div>
        <div class="btn-row">
          <a class="btn btn-outline btn-sm" href="${location.href.includes('institution') ? '/institution-dashboard.html' : '/student-dashboard.html'}">Back</a>
          <a class="btn btn-primary btn-sm" href="/api/certificates/${c.id}/download">Download document</a>
          <a class="btn btn-outline btn-sm" href="/verify.html?id=${encodeURIComponent(c.certificateId)}">Verify publicly</a>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>Status</h2>
          <span>${B.statusBadge(c.status)} ${B.blockchainBadge(c.blockchainStatus)}</span>
        </div>
        <div class="panel-body">
          <div class="result-facts">
            <div class="fact"><div class="k">Certificate type</div><div class="v">${B.escapeHtml(c.certificateType)}</div></div>
            <div class="fact"><div class="k">Student</div><div class="v">${B.escapeHtml(c.studentName)}</div></div>
            <div class="fact"><div class="k">Register number</div><div class="v">${B.escapeHtml(c.registrationNumber)}</div></div>
            <div class="fact"><div class="k">Department</div><div class="v">${B.escapeHtml(c.department || '—')}</div></div>
            <div class="fact"><div class="k">Issue date</div><div class="v">${B.fmtDate(c.issueDate)}</div></div>
            <div class="fact"><div class="k">Expiry date</div><div class="v">${c.expiryDate ? B.fmtDate(c.expiryDate) : '—'}</div></div>
            ${c.academicYear ? `<div class="fact"><div class="k">Academic year</div><div class="v">${B.escapeHtml(c.academicYear)}</div></div>` : ''}
            ${c.marks ? `<div class="fact"><div class="k">Marks / CGPA</div><div class="v">${B.escapeHtml(c.marks)}</div></div>` : ''}
            <div class="fact"><div class="k">Institution approval</div><div class="v">${B.statusBadge(data.institution.verificationStatus)}</div></div>
          </div>

          <div class="btn-row mt-2">
            <button class="btn btn-outline btn-sm" type="button" id="runAiBtn">Run AI analysis on this document</button>
            <a class="btn btn-outline btn-sm" href="/ai-analysis.html?certificateId=${encodeURIComponent(c.certificateId)}">Open AI analysis</a>
          </div>

          ${B.technicalPanel({
            documentSha256: c.documentHash,
            blockchainTxHash: c.blockchainTxHash,
            blockNumber: c.blockNumber,
            contractAddress: null,
            issuerWallet: null,
            network: null,
            registeredAt: c.createdAt,
            blockchainStatus: c.blockchainStatus,
          })}
        </div>
      </div>

      ${
        revocation
          ? `<div class="panel mt-2"><div class="panel-head"><h2>Revocation</h2><span class="badge badge-revoked"><span aria-hidden="true">⊘</span> Revoked</span></div>
             <div class="panel-body">
               <p><strong>Reason:</strong> ${B.escapeHtml(revocation.reason)}</p>
               <p class="small muted mb-0">Revoked ${B.fmtDateTime(revocation.revoked_at)} by ${B.escapeHtml(revocation.revoked_by_name || 'unknown')} · tx ${B.escapeHtml(revocation.blockchain_tx_hash || 'Not available')} · The blockchain record has not been deleted.</p>
             </div></div>`
          : ''
      }

      <div class="panel mt-2">
        <div class="panel-head"><h2>AI analyses</h2></div>
        <div class="panel-body" id="aiArea"></div>
      </div>

      <div class="panel mt-2">
        <div class="panel-head"><h2>Verification log</h2></div>
        <div class="panel-body" id="verifArea"></div>
      </div>

      ${
        data.qrDataUrl
          ? `<div class="qr-box mt-2"><img src="${data.qrDataUrl}" alt="QR code for ${B.escapeHtml(c.certificateId)}" />
             <p class="small muted">Contains only the public URL: <span class="mono">${B.escapeHtml(data.verificationUrl)}</span></p></div>`
          : ''
      }

      <div id="aiRunResult" class="mt-2"></div>
    `;

    B.bindCopyButtons(body);

    const aiArea = document.getElementById('aiArea');
    if (!data.aiAnalyses.length) {
      aiArea.innerHTML = B.emptyState('AI analysis has not been performed.', 'Use "Run AI analysis on this document" to request a real analysis.', '◉');
    } else {
      aiArea.innerHTML = data.aiAnalyses
        .map((a) =>
          a.status === 'unavailable'
            ? `<div class="check-item warning" style="margin-bottom:.5rem"><span class="ci-glyph" aria-hidden="true">⚠</span>
               <div><strong>AI analysis is currently unavailable.</strong><span class="ci-note">${B.escapeHtml(a.unavailableReason || '')} · ${B.fmtDateTime(a.createdAt)}</span></div></div>`
            : `<div style="margin-bottom:.9rem">
               <div class="btn-row" style="justify-content:space-between"><strong>${B.escapeHtml(a.classification)} — ${a.riskScore}/100</strong><span class="small muted">${B.fmtDateTime(a.createdAt)} · ${B.escapeHtml(a.model || '')}</span></div>
               ${B.renderRiskMeter(a.riskScore, a.riskScore < 31 ? 'low' : a.riskScore < 71 ? 'medium' : 'high')}
               ${a.findings && a.findings.checks ? B.renderCheckGrid({ performed: true, checks: a.findings.checks }) : ''}
               ${a.findings && a.findings.findings && a.findings.findings.length ? '<ul class="small">' + a.findings.findings.map((f) => '<li>' + B.escapeHtml(f) + '</li>').join('') + '</ul>' : ''}
             </div>`
        )
        .join('');
    }

    const verifArea = document.getElementById('verifArea');
    verifArea.innerHTML = data.verifications.length
      ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>#</th><th>Method</th><th>Hash</th><th>Result</th><th>When</th></tr></thead>
          <tbody>${data.verifications
            .map(
              (v) => `<tr>
                <td>${v.id}</td>
                <td>${B.escapeHtml(v.verification_method)}</td>
                <td>${v.hash_match === null ? '<span class="muted">Not checked</span>' : v.hash_match ? '<span class="badge badge-ok"><span aria-hidden="true">✓</span> Match</span>' : '<span class="badge badge-bad"><span aria-hidden="true">✕</span> Mismatch</span>'}</td>
                <td>${B.statusBadge(v.final_result)}</td>
                <td>${B.fmtDateTime(v.created_at)}</td>
              </tr>`
            )
            .join('')}</tbody></table></div>`
      : B.emptyState('No verification activity yet.', 'Verifications of this certificate appear here.', '⏱');

    // run AI
    const runBtn = document.getElementById('runAiBtn');
    runBtn.addEventListener('click', () => {
      const out = document.getElementById('aiRunResult');
      out.innerHTML = `<div class="alert show alert-info">Requesting analysis… The document will be re-uploaded for analysis.</div>`;
      // Download the document client-side, then post it to the AI endpoint.
      // The stored document requires auth: send the Bearer token.
      fetch('/api/certificates/' + c.id + '/download', { headers: { Authorization: 'Bearer ' + B.getToken() } })
        .then((r) => {
          if (!r.ok) throw new Error('Could not read the stored document.');
          return r.blob();
        })
        .then((blob) => {
          const fd = new FormData();
          fd.append('document', blob, 'document');
          fd.append('certificateId', c.certificateId);
          return B.api('/api/ai/analyze', { method: 'POST', body: fd });
        })
        .then((res) => {
          out.innerHTML = `<div class="alert show alert-success">${B.escapeHtml(res.message)}</div>
            <div class="panel"><div class="panel-body">
              ${B.renderRiskMeter(res.data.riskScore, res.data.band.band)}
              ${B.renderCheckGrid({ performed: true, checks: res.data.checks })}
              <div class="disclaimer">${B.escapeHtml(res.data.disclaimer)}</div>
            </div></div>`;
          load();
        })
        .catch((err) => {
          out.innerHTML = `<div class="alert show alert-error">${B.escapeHtml(err.message)}</div>`;
        });
    });
  }

  async function load() {
    if (!id) {
      body.innerHTML = B.errorState('No certificate selected', 'Open a certificate from your dashboard.');
      return;
    }
    try {
      const res = await B.api('/api/certificates/' + encodeURIComponent(id));
      render(res.data);
    } catch (err) {
      if (err.status === 401) return;
      body.innerHTML = B.errorState('Certificate unavailable', err.message);
    }
  }

  document.addEventListener('DOMContentLoaded', load);
})();
