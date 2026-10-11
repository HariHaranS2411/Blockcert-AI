/* ============================================================
   BlockCert AI - admin dashboard
   Real counts, institution approvals, users, audit logs.
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  const D = window.Dash;
  if (!B || !D) return;

  const user = D.guardRole(['ADMIN']);
  if (!user) return;

  D.buildSidebar({
    active: 'dashboard',
    items: [
      { section: 'System' },
      { id: 'dashboard', label: 'Dashboard', href: '/admin-dashboard.html', icon: '▤' },
      { id: 'institutions', label: 'Institutions', href: '#tab-admInstitutions', icon: '🏛' },
      { id: 'users', label: 'Users', href: '#tab-admUsers', icon: '👤' },
      { section: 'Records' },
      { id: 'certs', label: 'Certificates', href: '#tab-admCertificates', icon: '▦' },
      { id: 'verifs', label: 'Verifications', href: '#tab-admVerifications', icon: '✓' },
      { id: 'audit', label: 'Audit Logs', href: '#tab-admAudit', icon: '⏱' },
      { section: 'Public' },
      { id: 'verify', label: 'Verify a certificate', href: '/verify.html', icon: '◇' },
    ],
  });

  function activateTab(name) {
    const panel = document.getElementById('tab-' + name);
    if (!panel) return false;
    document.querySelectorAll('.tab').forEach((t) => {
      const match = t.dataset.tab === name;
      t.classList.toggle('active', match);
      t.setAttribute('aria-selected', String(match));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    panel.classList.add('active');
    return true;
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  /* Sidebar links like #tab-admUsers activate the matching tab, not just the hash. */
  function activateFromHash() {
    const m = location.hash.match(/^#tab-(.+)$/);
    if (m) activateTab(m[1]);
  }
  window.addEventListener('hashchange', activateFromHash);
  activateFromHash();

  async function loadDashboard() {
    const chips = document.getElementById('healthChips');
    const stats = document.getElementById('statRow');
    stats.innerHTML = B.loadingState('Loading real system counts…');

    try {
      const res = await B.api('/api/admin/dashboard');
      const d = res.data;
      const h = d.systemHealth;

      chips.innerHTML = `
        <span class="chip ${h.database.connected ? 'ok' : 'down'}"><span class="dot"></span>Database ${h.database.connected ? 'connected' : 'unavailable'}</span>
        <span class="chip ${h.blockchain.connected ? (h.blockchain.configured ? 'ok' : 'warn') : 'down'}"><span class="dot"></span>Blockchain ${
        h.blockchain.connected ? (h.blockchain.configured ? 'connected' : 'no contract configured') : 'unavailable'
      }</span>
        <span class="chip ${h.ai.configured ? 'ok' : 'warn'}"><span class="dot"></span>AI ${h.ai.configured ? 'configured' : 'unavailable'}</span>`;

      stats.innerHTML = `
        <div class="stat info"><div class="label">Users</div><div class="value">${d.users.total}</div><div class="sub">${d.users.students} students · ${d.users.institutionUsers} institutions · ${d.users.employers} employers</div></div>
        <div class="stat info"><div class="label">Institutions</div><div class="value">${d.institutions.total}</div><div class="sub">${d.institutions.approved} approved · ${d.institutions.pending} pending</div></div>
        <div class="stat info"><div class="label">Certificates</div><div class="value">${d.certificates.total}</div><div class="sub">${d.certificates.active} active · ${d.certificates.revoked} revoked</div></div>
        <div class="stat info"><div class="label">Verifications</div><div class="value">${d.verifications.total}</div><div class="sub">${d.verifications.verified} verified · ${d.verifications.suspicious} suspicious</div></div>
        <div class="stat warn"><div class="label">Suspicious</div><div class="value">${d.verifications.suspicious}</div><div class="sub">${d.verifications.tampered} tampered</div></div>
        <div class="stat bad"><div class="label">Revoked</div><div class="value">${d.revocations.total}</div><div class="sub">${d.certificates.revoked} revoked certificates</div></div>
        <div class="stat ${d.certificates.failedBlockchain ? 'bad' : ''}"><div class="label">Failed chain ops</div><div class="value">${d.certificates.failedBlockchain}</div><div class="sub">${d.certificates.pendingBlockchain} pending</div></div>
        <div class="stat"><div class="label">Audit logs</div><div class="value">${d.auditLogs.total}</div><div class="sub">real events only</div></div>`;

      if (!h.blockchain.connected || !h.blockchain.configured) {
        B.showAlert(h.blockchain.message || 'Blockchain verification is currently unavailable.', 'warn');
      }
    } catch (err) {
      stats.innerHTML = B.errorState('Dashboard unavailable', err.message);
    }
  }

  async function loadInstitutions() {
    const area = document.getElementById('instArea');
    area.innerHTML = B.loadingState('Loading institutions…');
    try {
      const res = await B.api('/api/admin/institutions');
      const rows = res.data.institutions;
      if (!rows.length) {
        area.innerHTML = B.emptyState('No institutions have registered yet.', 'Institutions appear here when they register.', '🏛');
        return;
      }
      area.innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Official email</th><th>Status</th><th>Certificates</th><th>Users</th><th>Registered</th><th>Actions</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
              <td>${B.escapeHtml(r.name)}</td>
              <td>${B.escapeHtml(r.official_email)}</td>
              <td>${B.statusBadge(r.verification_status)}</td>
              <td>${r.certificate_count}</td>
              <td>${r.user_count}</td>
              <td>${B.fmtDate(r.created_at)}</td>
              <td class="actions">
                ${r.verification_status !== 'APPROVED' ? `<button class="btn btn-outline btn-sm" data-inst="${r.id}" data-act="approve">Approve</button>` : ''}
                ${r.verification_status !== 'SUSPENDED' ? `<button class="btn btn-outline btn-sm" data-inst="${r.id}" data-act="suspend">Suspend</button>` : ''}
                ${r.verification_status !== 'REJECTED' ? `<button class="btn btn-outline btn-sm" data-inst="${r.id}" data-act="reject">Reject</button>` : ''}
              </td>
            </tr>`
          )
          .join('')}</tbody></table></div>`;

      area.querySelectorAll('[data-inst]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          B.setButtonBusy(btn, true, 'Saving…');
          try {
            const res = await B.api(`/api/admin/institutions/${btn.dataset.inst}/${btn.dataset.act}`, { method: 'PATCH', body: {} });
            B.toast(res.message, 'success');
            loadInstitutions();
            loadDashboard();
          } catch (err) {
            B.toast(err.message, 'error');
            B.setButtonBusy(btn, false);
          }
        });
      });
    } catch (err) {
      area.innerHTML = B.errorState('Could not load institutions', err.message);
    }
  }

  async function loadUsers() {
    const area = document.getElementById('usersArea');
    area.innerHTML = B.loadingState('Loading users…');
    try {
      const res = await B.api('/api/admin/users');
      const rows = res.data.users;
      if (!rows.length) {
        area.innerHTML = B.emptyState('No users have registered yet.', 'Registered accounts appear here.', '👤');
        return;
      }
      area.innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Institution</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
              <td>${B.escapeHtml(r.name)}</td>
              <td>${B.escapeHtml(r.email)}</td>
              <td>${B.escapeHtml(r.role)}</td>
              <td>${B.escapeHtml(r.institution_name || '—')}</td>
              <td>${r.is_active ? '<span class="badge badge-ok"><span aria-hidden="true">✓</span> Active</span>' : '<span class="badge badge-revoked"><span aria-hidden="true">⊘</span> Suspended</span>'}</td>
              <td>${B.fmtDate(r.created_at)}</td>
              <td class="actions">${
                r.role !== 'ADMIN'
                  ? `<button class="btn btn-outline btn-sm" data-user="${r.id}" data-act="${r.is_active ? 'suspend' : 'activate'}">${r.is_active ? 'Suspend' : 'Activate'}</button>`
                  : '<span class="muted small">—</span>'
              }</td>
            </tr>`
          )
          .join('')}</tbody></table></div>`;

      area.querySelectorAll('[data-user]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          B.setButtonBusy(btn, true, 'Saving…');
          try {
            const res = await B.api(`/api/admin/users/${btn.dataset.user}/${btn.dataset.act}`, { method: 'PATCH', body: {} });
            B.toast(res.message, 'success');
            loadUsers();
          } catch (err) {
            B.toast(err.message, 'error');
            B.setButtonBusy(btn, false);
          }
        });
      });
    } catch (err) {
      area.innerHTML = B.errorState('Could not load users', err.message);
    }
  }

  async function loadCertificates() {
    const area = document.getElementById('certsArea');
    area.innerHTML = B.loadingState('Loading certificates…');
    try {
      const res = await B.api('/api/admin/certificates');
      const rows = res.data.certificates;
      if (!rows.length) {
        area.innerHTML = B.emptyState('No certificates have been issued yet.', 'Issued certificates appear here.', '▦');
        return;
      }
      area.innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr><th>Certificate</th><th>Institution</th><th>Credential</th><th>Status</th><th>Chain</th><th>Issued</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
              <td><a class="mono" href="/certificate-details.html?id=${r.id}">${B.escapeHtml(r.certificate_id)}</a></td>
              <td>${B.escapeHtml(r.institution_name)}</td>
              <td>${B.escapeHtml(r.degree)}</td>
              <td>${B.statusBadge(r.status)}</td>
              <td>${B.blockchainBadge(r.blockchain_status)}</td>
              <td>${B.fmtDate(r.created_at)}</td>
            </tr>`
          )
          .join('')}</tbody></table></div>`;
    } catch (err) {
      area.innerHTML = B.errorState('Could not load certificates', err.message);
    }
  }

  async function loadVerifications() {
    const area = document.getElementById('verifsArea');
    area.innerHTML = B.loadingState('Loading verifications…');
    try {
      const res = await B.api('/api/admin/verifications');
      const rows = res.data.verifications;
      if (!rows.length) {
        area.innerHTML = B.emptyState('No verification activity yet.', 'Verification events appear here.', '✓');
        return;
      }
      area.innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr><th>Reference</th><th>Institution</th><th>Method</th><th>Result</th><th>AI</th><th>Verifier</th><th>When</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
              <td class="mono">${B.escapeHtml(r.certificate_ref)}</td>
              <td>${B.escapeHtml(r.institution_name || '—')}</td>
              <td>${B.escapeHtml(r.verification_method)}</td>
              <td>${B.statusBadge(r.final_result)}</td>
              <td>${B.escapeHtml(r.ai_result || '—')}</td>
              <td>${B.escapeHtml(r.verifier_name || 'Public')}</td>
              <td>${B.fmtDateTime(r.created_at)}</td>
            </tr>`
          )
          .join('')}</tbody></table></div>`;
    } catch (err) {
      area.innerHTML = B.errorState('Could not load verifications', err.message);
    }
  }

  async function loadAudit() {
    const area = document.getElementById('auditArea');
    area.innerHTML = B.loadingState('Loading audit logs…');
    try {
      const res = await B.api('/api/admin/audit-logs');
      const rows = res.data.logs;
      if (!rows.length) {
        area.innerHTML = B.emptyState('No audit events recorded yet.', 'Real events (login, issuance, revocation, admin actions) appear here.', '⏱');
        return;
      }
      area.innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Reference</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
              <td>${B.fmtDateTime(r.created_at)}</td>
              <td>${B.escapeHtml(r.actor_name || 'system')}</td>
              <td><span class="badge badge-info">${B.escapeHtml(r.action)}</span></td>
              <td>${B.escapeHtml(r.entity)}</td>
              <td class="mono">${B.escapeHtml(r.entity_ref || '—')}</td>
            </tr>`
          )
          .join('')}</tbody></table></div>`;
    } catch (err) {
      area.innerHTML = B.errorState('Could not load audit logs', err.message);
    }
  }

  document.getElementById('refreshBtn').addEventListener('click', () => {
    loadDashboard();
    loadInstitutions();
    loadUsers();
    loadCertificates();
    loadVerifications();
    loadAudit();
  });

  document.addEventListener('DOMContentLoaded', () => {
    loadDashboard();
    loadInstitutions();
    loadUsers();
    loadCertificates();
    loadVerifications();
    loadAudit();
  });
})();
