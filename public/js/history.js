/* ============================================================
   BlockCert AI - verification history page
   Real events only, scoped by the server to the caller's role.
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  if (!B) return;

  if (!B.isLoggedIn()) {
    localStorage.setItem('blockcert_redirect', '/verification-history.html');
    location.href = '/login.html';
    return;
  }

  let page = 1;
  let lastRows = [];

  const area = document.getElementById('historyArea');
  const pager = document.getElementById('historyPager');
  const summaryRow = document.getElementById('summaryRow');

  async function load() {
    area.innerHTML = B.loadingState('Loading verification history…');
    const params = new URLSearchParams({ page: String(page), limit: '25' });
    const ref = document.getElementById('refFilter').value.trim();
    const result = document.getElementById('resultFilter').value;
    if (ref) params.set('certificateId', ref);
    if (result) params.set('result', result);

    try {
      const res = await B.api('/api/verification/history?' + params.toString());
      const d = res.data;
      lastRows = d.history;

      const s = d.summary;
      summaryRow.innerHTML = `
        <div class="stat"><div class="label">Total events</div><div class="value">${s.total}</div></div>
        <div class="stat ok"><div class="label">Verified</div><div class="value">${s.verified}</div></div>
        <div class="stat warn"><div class="label">Suspicious</div><div class="value">${s.suspicious}</div></div>
        <div class="stat bad"><div class="label">Tampered</div><div class="value">${s.tampered}</div></div>
        <div class="stat"><div class="label">Revoked</div><div class="value">${s.revoked}</div></div>
        <div class="stat"><div class="label">Not found</div><div class="value">${s.notFound}</div></div>`;

      if (!d.history.length) {
        area.innerHTML = B.emptyState(
          'No verification activity yet.',
          ref || result ? 'No events match this filter.' : 'Verifications you perform are recorded here with real results.',
          '⏱'
        );
        pager.innerHTML = '';
        return;
      }

      area.innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr>
          <th>Certificate</th><th>Verifier</th><th>Method</th><th>Hash</th><th>Blockchain</th><th>AI</th><th>Result</th><th>When</th>
        </tr></thead>
        <tbody>${d.history
          .map(
            (h) => `<tr>
              <td class="mono">${B.escapeHtml(h.certificateRef)}</td>
              <td>${B.escapeHtml(h.verifier)}</td>
              <td>${B.escapeHtml(h.method)}</td>
              <td>${
                h.hashMatch === null
                  ? '<span class="muted small">Not checked</span>'
                  : h.hashMatch
                    ? '<span class="badge badge-ok"><span aria-hidden="true">✓</span> Match</span>'
                    : '<span class="badge badge-bad"><span aria-hidden="true">✕</span> Mismatch</span>'
              }</td>
              <td>${B.escapeHtml(h.blockchainStatus || '—')}</td>
              <td>${B.escapeHtml(h.aiResult || '—')}</td>
              <td>${B.statusBadge(h.finalResult)}</td>
              <td>${B.fmtDateTime(h.createdAt)}</td>
            </tr>`
          )
          .join('')}</tbody></table></div>`;

      pager.innerHTML = `
        <span>Page ${d.pagination.page} of ${Math.max(1, d.pagination.pages)} · ${d.pagination.total} event${d.pagination.total === 1 ? '' : 's'}</span>
        <span class="btn-row">
          <button class="btn btn-outline btn-sm" type="button" id="prevPage" ${d.pagination.page <= 1 ? 'disabled' : ''}>Previous</button>
          <button class="btn btn-outline btn-sm" type="button" id="nextPage" ${d.pagination.page >= d.pagination.pages ? 'disabled' : ''}>Next</button>
        </span>`;
      const prev = document.getElementById('prevPage');
      const next = document.getElementById('nextPage');
      if (prev) prev.onclick = () => { page -= 1; load(); };
      if (next) next.onclick = () => { page += 1; load(); };
    } catch (err) {
      if (err.status === 401) {
        location.href = '/login.html';
        return;
      }
      area.innerHTML = B.errorState('History unavailable', err.message);
      summaryRow.innerHTML = '';
    }
  }

  document.getElementById('refFilter').addEventListener(
    'input',
    B.debounce(() => { page = 1; load(); }, 350)
  );
  document.getElementById('resultFilter').addEventListener('change', () => { page = 1; load(); });

  document.getElementById('exportBtn').addEventListener('click', () => {
    if (!lastRows.length) {
      B.toast('There is nothing to export yet.', 'warn');
      return;
    }
    B.downloadCsv('verification-history.csv', [
      ['certificateId', 'verifier', 'method', 'hashResult', 'blockchainStatus', 'aiResult', 'finalResult', 'timestamp'],
      ...lastRows.map((h) => [
        h.certificateRef,
        h.verifier,
        h.method,
        h.hashMatch === null ? 'NOT_CHECKED' : h.hashMatch ? 'MATCH' : 'MISMATCH',
        h.blockchainStatus || '',
        h.aiResult || '',
        h.finalResult,
        h.createdAt,
      ]),
    ]);
    B.toast('History exported.', 'success');
  });

  document.addEventListener('DOMContentLoaded', load);
})();
