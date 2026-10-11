/* ============================================================
   BlockCert AI - institution dashboard
   Stats, register search, revoke, bulk issuance, profile.
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  const D = window.Dash;
  if (!B || !D) return;

  const user = D.guardRole(['INSTITUTION', 'ADMIN']);
  if (!user) return;

  let currentPage = 1;
  let searchTimer = null;

  D.buildSidebar({
    active: 'dashboard',
    items: [
      { section: 'Workspace' },
      { id: 'dashboard', label: 'Dashboard', href: '/institution-dashboard.html', icon: '▤' },
      { id: 'issue', label: 'Issue Certificate', href: '/issue-certificate.html', icon: '＋' },
      { id: 'bulk', label: 'Bulk Issue', href: '#bulkIssue', icon: '≡' },
      { section: 'Records' },
      { id: 'certs', label: 'Certificates', href: '#register', icon: '▦' },
      { id: 'revoke', label: 'Revoke Certificate', href: '#revokeSection', icon: '⊘' },
      { id: 'history', label: 'Verification History', href: '/verification-history.html', icon: '⏱' },
      { section: 'Account' },
      { id: 'profile', label: 'Institution Profile', href: '#profilePanel', icon: '🏛' },
      { id: 'verify', label: 'Verify a certificate', href: '/verify.html', icon: '✓' },
    ],
  });

  /* ---------------- stats ---------------- */
  async function loadStats() {
    try {
      const res = await B.api('/api/dashboard');
      const d = res.data;

      if (d.institution && d.institution.verification_status !== 'APPROVED') {
        document.getElementById('instStatusBanner').innerHTML =
          `<div class="alert show alert-warn">Your institution is <strong>${B.escapeHtml(d.institution.verification_status)}</strong>. Certificates can be issued, but verifications will report the issuer as not fully approved until an administrator approves it.</div>`;
      }

      const c = d.certificates;
      const v = d.verifications;
      document.getElementById('statRow').innerHTML = `
        <div class="stat info"><div class="label">Certificates</div><div class="value">${c.total}</div><div class="sub">${c.registered} registered on-chain</div></div>
        <div class="stat ok"><div class="label">Active</div><div class="value">${c.active}</div><div class="sub">${c.revoked} revoked</div></div>
        <div class="stat"><div class="label">Verification requests</div><div class="value">${v.total}</div><div class="sub">on your certificates</div></div>
        <div class="stat warn"><div class="label">Needs review</div><div class="value">${v.suspicious}</div><div class="sub">${v.tampered} tampered</div></div>
      `;

      document.getElementById('recentCertsBody').innerHTML = d.recentCertificates.length
        ? `<ul class="timeline">${d.recentCertificates
            .map(
              (c2) => `<li><span class="tl-dot" aria-hidden="true"></span><div>
                <a href="/certificate-details.html?id=${c2.id}"><strong>${B.escapeHtml(c2.certificate_id)}</strong></a>
                <div class="small muted">${B.escapeHtml(c2.degree)} · ${B.escapeHtml(c2.certificate_type)} · ${B.statusBadge(c2.status)} ${B.blockchainBadge(c2.blockchain_status)}</div>
                <span class="tl-time">${B.fmtDateTime(c2.created_at)}</span>
              </div></li>`
            )
            .join('')}</ul>`
        : B.emptyState('No certificates have been issued yet.', 'Start with Issue Certificate.', '▦');

      document.getElementById('recentVerifications').innerHTML = d.recentVerifications.length
        ? `<ul class="timeline">${d.recentVerifications
            .map(
              (v2) => `<li><span class="tl-dot" aria-hidden="true"></span><div>
                <strong>${B.escapeHtml(v2.certificate_ref)}</strong> ${B.statusBadge(v2.final_result)}
                <div class="small muted">${B.escapeHtml(v2.verification_method)}</div>
                <span class="tl-time">${B.fmtDateTime(v2.created_at)}</span>
              </div></li>`
            )
            .join('')}</ul>`
        : B.emptyState('No verification activity yet.', 'Verifications performed on your certificates appear here.', '⏱');
    } catch (err) {
      document.getElementById('statRow').innerHTML = B.errorState('Statistics unavailable', err.message);
    }
  }

  /* ---------------- certificate register ---------------- */
  async function loadCertificates() {
    const body = document.getElementById('certTableBody');
    const pager = document.getElementById('certPager');
    body.innerHTML = `<tr><td colspan="8">${B.loadingState('Loading certificates…')}</td></tr>`;

    const q = document.getElementById('searchInput').value.trim();
    const status = document.getElementById('statusFilter').value;
    try {
      const params = new URLSearchParams({ page: String(currentPage), limit: '10' });
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      const res = await B.api('/api/certificates?' + params.toString());
      const { certificates, pagination } = res.data;

      if (!certificates.length) {
        body.innerHTML = `<tr><td colspan="8">${B.emptyState(
          q || status ? 'No certificates match this search.' : 'No certificates have been issued yet.',
          q || status ? 'Try a different search or clear the filters.' : 'Use Issue Certificate to register the first credential.',
          '▦'
        )}</td></tr>`;
        pager.innerHTML = '';
        return;
      }

      body.innerHTML = certificates
        .map(
          (c) => `<tr>
            <td><a href="/certificate-details.html?id=${c.id}" class="mono">${B.escapeHtml(c.certificateId)}</a></td>
            <td>${B.escapeHtml(c.degree)}</td>
            <td>${B.escapeHtml(c.certificateType)}</td>
            <td>${B.escapeHtml(c.studentName)}</td>
            <td>${B.statusBadge(c.status)}</td>
            <td>${B.blockchainBadge(c.blockchainStatus)}</td>
            <td>${B.fmtDate(c.issueDate)}</td>
            <td class="actions">
              <a class="btn btn-outline btn-sm" href="/certificate-details.html?id=${c.id}">View</a>
              ${
                c.status !== 'REVOKED'
                  ? `<button class="btn btn-outline btn-sm" type="button" data-revoke="${c.id}" data-certid="${B.escapeHtml(c.certificateId)}">Revoke</button>`
                  : ''
              }
            </td>
          </tr>`
        )
        .join('');

      pager.innerHTML = `
        <span>Page ${pagination.page} of ${Math.max(1, pagination.pages)} · ${pagination.total} certificate${pagination.total === 1 ? '' : 's'}</span>
        <span class="btn-row">
          <button class="btn btn-outline btn-sm" type="button" id="prevPage" ${pagination.page <= 1 ? 'disabled' : ''}>Previous</button>
          <button class="btn btn-outline btn-sm" type="button" id="nextPage" ${pagination.page >= pagination.pages ? 'disabled' : ''}>Next</button>
        </span>`;

      const prev = document.getElementById('prevPage');
      const next = document.getElementById('nextPage');
      if (prev) prev.onclick = () => { currentPage -= 1; loadCertificates(); };
      if (next) next.onclick = () => { currentPage += 1; loadCertificates(); };

      body.querySelectorAll('[data-revoke]').forEach((btn) => {
        btn.addEventListener('click', () => openRevokeDialog(btn.dataset.certid));
      });
    } catch (err) {
      body.innerHTML = `<tr><td colspan="8">${B.errorState('Could not load certificates', err.message)}</td></tr>`;
    }
  }

  document.getElementById('searchInput').addEventListener(
    'input',
    B.debounce(() => {
      currentPage = 1;
      loadCertificates();
    }, 350)
  );
  document.getElementById('statusFilter').addEventListener('change', () => {
    currentPage = 1;
    loadCertificates();
  });
  document.getElementById('refreshBtn').addEventListener('click', () => {
    loadStats();
    loadCertificates();
  });

  /* ---------------- revocation dialog ---------------- */
  const modal = document.getElementById('revokeModal');
  let pendingRevokeId = null;

  function openRevokeDialog(certId) {
    pendingRevokeId = certId;
    const reason = document.getElementById('revokeReason').value.trim();
    document.getElementById('revokeModalCertId').textContent = certId;
    document.getElementById('revokeModalReason').textContent = reason || '(no reason entered yet — close this dialog and add one)';
    modal.classList.add('open');
    document.getElementById('revokeConfirm').focus();
  }
  function closeRevokeDialog() {
    modal.classList.remove('open');
    pendingRevokeId = null;
  }
  document.getElementById('revokeCancel').addEventListener('click', closeRevokeDialog);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeRevokeDialog();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeRevokeDialog();
  });

  document.getElementById('revokeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    B.hideAlert();
    const certId = document.getElementById('revokeCertId').value.trim().toUpperCase();
    const reason = document.getElementById('revokeReason').value.trim();
    if (!/^CERT-\d{4}-\d{6}$/.test(certId)) {
      B.showAlert('Certificate ID must use the format CERT-YYYY-XXXXXX.', 'warn');
      return;
    }
    if (reason.length < 5) {
      B.showAlert('Enter a revocation reason of at least 5 characters.', 'warn');
      return;
    }
    openRevokeDialog(certId);
  });

  document.getElementById('revokeConfirm').addEventListener('click', async () => {
    if (!pendingRevokeId) return;
    const btn = document.getElementById('revokeConfirm');
    const reason = document.getElementById('revokeReason').value.trim();
    B.setButtonBusy(btn, true, 'Revoking on-chain…');
    try {
      // resolve the numeric id from the certificate id
      const lookup = await B.api('/api/certificates?limit=100&q=' + encodeURIComponent(pendingRevokeId));
      const row = lookup.data.certificates.find((c) => c.certificateId === pendingRevokeId);
      if (!row) throw new Error('Certificate not found in your register.');

      const res = await B.api(`/api/certificates/${row.id}/revoke`, { method: 'POST', body: { reason } });
      B.toast(res.message, 'success');
      document.getElementById('revokeResult').innerHTML = `<div class="alert show alert-success">${B.escapeHtml(res.message)}
        <div class="small mono mt-1">tx: ${B.escapeHtml(res.data.txHash || 'Not available')} · block: ${res.data.blockNumber ?? 'Not available'}</div></div>`;
      closeRevokeDialog();
      document.getElementById('revokeForm').reset();
      loadStats();
      loadCertificates();
    } catch (err) {
      document.getElementById('revokeResult').innerHTML = `<div class="alert show alert-error">${B.escapeHtml(err.message)}</div>`;
      closeRevokeDialog();
    } finally {
      B.setButtonBusy(btn, false);
    }
  });

  /* ---------------- bulk issuance ---------------- */
  function bulkStatusBadge(status) {
    if (status === 'issued') return '<span class="badge badge-ok"><span aria-hidden="true">✓</span> Issued &amp; registered</span>';
    if (status === 'issued_not_registered') return '<span class="badge badge-warn"><span aria-hidden="true">⚠</span> Saved, chain pending</span>';
    return '<span class="badge badge-bad"><span aria-hidden="true">✕</span> Failed</span>';
  }

  const bulkZone = document.getElementById('bulkZone');
  const bulkInput = document.getElementById('bulkInput');
  const bulkDocsZone = document.getElementById('bulkDocsZone');
  const bulkDocsInput = document.getElementById('bulkDocsInput');
  let bulkFile = null;
  let bulkDocs = [];

  bulkZone.addEventListener('click', () => bulkInput.click());
  bulkZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bulkInput.click(); }
  });
  ['dragover', 'dragenter'].forEach((ev) => bulkZone.addEventListener(ev, (e) => { e.preventDefault(); bulkZone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => bulkZone.addEventListener(ev, (e) => { e.preventDefault(); bulkZone.classList.remove('dragover'); }));
  bulkZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const f = e.dataTransfer.files[0];
      if (f.name.toLowerCase().endsWith('.csv')) {
        const dt = new DataTransfer(); dt.items.add(f); bulkInput.files = dt.files;
        bulkInput.dispatchEvent(new Event('change'));
      } else {
        B.showAlert('The first drop must be the issuance CSV.', 'warn');
      }
    }
  });
  bulkInput.addEventListener('change', () => {
    if (bulkInput.files[0] && bulkInput.files[0].name.toLowerCase().endsWith('.csv')) {
      bulkFile = bulkInput.files[0];
      document.getElementById('bulkFileName').hidden = false;
      document.getElementById('bulkFileName').textContent = bulkFile.name;
    } else if (bulkInput.files[0]) {
      B.showAlert('Bulk issuance requires a .csv file.', 'warn');
      bulkInput.value = '';
    }
  });

  function refreshDocsLabel() {
    const el = document.getElementById('bulkDocsName');
    if (bulkDocs.length) {
      el.hidden = false;
      el.textContent = bulkDocs.length + ' document' + (bulkDocs.length === 1 ? '' : 's') + ' attached: ' + bulkDocs.map((f) => f.name).join(', ');
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }
  bulkDocsZone.addEventListener('click', () => bulkDocsInput.click());
  bulkDocsZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bulkDocsInput.click(); }
  });
  ['dragover', 'dragenter'].forEach((ev) => bulkDocsZone.addEventListener(ev, (e) => { e.preventDefault(); bulkDocsZone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => bulkDocsZone.addEventListener(ev, (e) => { e.preventDefault(); bulkDocsZone.classList.remove('dragover'); }));
  bulkDocsZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      bulkDocs = Array.from(e.dataTransfer.files).filter((f) => /\.(pdf|png|jpe?g)$/i.test(f.name));
      refreshDocsLabel();
    }
  });
  bulkDocsInput.addEventListener('change', () => {
    bulkDocs = Array.from(bulkDocsInput.files || []);
    refreshDocsLabel();
  });

  document.getElementById('bulkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    B.hideAlert();
    if (!bulkFile) {
      B.showAlert('Choose a CSV file first.', 'warn');
      return;
    }
    const btn = document.getElementById('bulkBtn');
    B.setButtonBusy(btn, true, 'Processing rows…');
    const fd = new FormData();
    fd.append('file', bulkFile);
    for (const doc of bulkDocs) fd.append('documents', doc);
    try {
      const res = await B.api('/api/certificates/bulk', { method: 'POST', body: fd });
      const d = res.data;
      document.getElementById('bulkResults').innerHTML = `
        <div class="alert show ${d.failed ? 'alert-warn' : 'alert-success'}">${B.escapeHtml(res.message)}</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Row</th><th>Register no.</th><th>Result</th><th>Certificate</th><th>Detail</th></tr></thead>
          <tbody>${d.results
            .map(
              (r) => `<tr>
                <td>${r.row}</td>
                <td>${B.escapeHtml(r.registerNumber || '')}</td>
                <td>${bulkStatusBadge(r.status)}</td>
                <td class="mono">${B.escapeHtml(r.certificateId || '—')}</td>
                <td class="small">${B.escapeHtml(r.error || (r.blockchain ? (r.blockchain.registered ? 'Registered · tx ' + r.blockchain.txHash + ' · block ' + r.blockchain.blockNumber : r.blockchain.reason) : ''))}</td>
              </tr>`
            )
            .join('')}</tbody>
        </table></div>`;
      bulkFile = null;
      bulkDocs = [];
      bulkInput.value = '';
      bulkDocsInput.value = '';
      document.getElementById('bulkFileName').hidden = true;
      refreshDocsLabel();
      loadStats();
      loadCertificates();
    } catch (err) {
      document.getElementById('bulkResults').innerHTML = `<div class="alert show alert-error">${B.escapeHtml(err.message)}</div>`;
    } finally {
      B.setButtonBusy(btn, false);
    }
  });

  /* ---------------- profile ---------------- */
  async function loadProfile() {
    const el = document.getElementById('profileBody');
    el.innerHTML = B.loadingState('Loading profile…');
    try {
      const me = await B.api('/api/auth/me');
      const inst = me.data.user.institution;
      if (!inst) {
        el.innerHTML = B.emptyState('No institution profile is linked to this account.', 'Register an institution profile to issue certificates.', '🏛');
        return;
      }
      el.innerHTML = `
        <div class="alert" id="profileAlert" role="alert"></div>
        <form id="profileForm">
          <div class="form-grid">
            <div class="field"><label for="pName">Institution name</label><input type="text" id="pName" value="${B.escapeHtml(inst.name)}" required /></div>
            <div class="field"><label for="pReg">Registration number</label><input type="text" id="pReg" value="${B.escapeHtml(inst.registration_number || '')}" /></div>
            <div class="field"><label for="pEmail">Official email</label><input type="email" id="pEmail" value="${B.escapeHtml(inst.official_email)}" required /></div>
            <div class="field"><label for="pWebsite">Website</label><input type="url" id="pWebsite" value="${B.escapeHtml(inst.website || '')}" placeholder="https://" /></div>
            <div class="field"><label for="pWallet">Issuance wallet address</label><input type="text" id="pWallet" value="${B.escapeHtml(inst.wallet_address || '')}" placeholder="0x…" /><p class="hint">Optional. Used to cross-check the on-chain issuer address.</p></div>
            <div class="field"><label for="pStatus">Approval status</label><input type="text" id="pStatus" value="${B.escapeHtml(inst.verification_status)}" disabled /></div>
            <div class="field full"><label for="pAddress">Address</label><textarea id="pAddress" rows="2">${B.escapeHtml(inst.address || '')}</textarea></div>
          </div>
          <button class="btn btn-primary" type="submit">Save profile</button>
        </form>`;

      document.getElementById('profileForm').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = ev.target.querySelector('button[type="submit"]');
        B.setButtonBusy(btn, true, 'Saving…');
        try {
          const res = await B.api('/api/institutions/' + inst.id, {
            method: 'PUT',
            body: {
              name: document.getElementById('pName').value.trim(),
              registrationNumber: document.getElementById('pReg').value.trim() || null,
              officialEmail: document.getElementById('pEmail').value.trim(),
              website: document.getElementById('pWebsite').value.trim() || null,
              walletAddress: document.getElementById('pWallet').value.trim() || null,
              address: document.getElementById('pAddress').value.trim() || null,
            },
          });
          B.toast(res.message, 'success');
        } catch (err) {
          B.showAlert(err.message, 'error', 'profileAlert');
        } finally {
          B.setButtonBusy(btn, false);
        }
      });
    } catch (err) {
      el.innerHTML = B.errorState('Profile unavailable', err.message);
    }
  }

  /* Sidebar anchors (#register, #bulkIssue, #revokeSection, #profilePanel):
     scroll after async data loads have settled the layout, leaving room for
     the sticky navbar. */
  function scrollToHash() {
    if (!location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - 84;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }
  window.addEventListener('hashchange', scrollToHash);

  document.addEventListener('DOMContentLoaded', () => {
    Promise.all([loadStats(), loadCertificates(), loadProfile()]).then(scrollToHash).catch(scrollToHash);
  });
})();
