/* ============================================================
   BlockCert AI - common frontend module
   API client, session helpers, partial loading, toasts,
   status rendering. No business data is ever hardcoded here.
   ============================================================ */
(function () {
  'use strict';

  const TOKEN_KEY = 'blockcert_token';
  const USER_KEY = 'blockcert_user';

  /* ---------------- session ---------------- */
  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }
  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function isLoggedIn() {
    return Boolean(getToken());
  }

  const DASH_BY_ROLE = {
    INSTITUTION: '/institution-dashboard.html',
    STUDENT: '/student-dashboard.html',
    EMPLOYER: '/employer-dashboard.html',
    ADMIN: '/admin-dashboard.html',
  };
  function dashboardUrl(role) {
    return DASH_BY_ROLE[role] || '/index.html';
  }

  /** Redirect to login preserving the intended destination. */
  function requireLogin() {
    if (isLoggedIn()) return true;
    localStorage.setItem('blockcert_redirect', location.pathname + location.search);
    location.href = '/login.html';
    return false;
  }

  /* ---------------- API client ---------------- */
  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    let body = options.body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(path, { method: options.method || 'GET', headers, body });
    } catch (_) {
      const err = new Error('Network error: the server could not be reached.');
      err.friendly = true;
      throw err;
    }

    let payload = null;
    try {
      payload = await res.json();
    } catch (_) {
      payload = null;
    }

    if (res.status === 401 && isLoggedIn() && !path.includes('/auth/login')) {
      clearSession();
    }

    if (!res.ok || (payload && payload.success === false)) {
      const err = new Error((payload && payload.message) || `Request failed (${res.status}).`);
      err.status = res.status;
      err.data = payload ? payload.data : null;
      err.friendly = true;
      throw err;
    }
    return payload;
  }

  /* ---------------- alerts & toasts ---------------- */
  function showAlert(message, type = 'info', containerId = 'pageAlert') {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.className = 'alert show alert-' + type;
    el.textContent = message;
    if (type === 'success' || type === 'info') {
      setTimeout(() => {
        el.classList.remove('show');
      }, 7000);
    }
  }
  function hideAlert(containerId = 'pageAlert') {
    const el = document.getElementById(containerId);
    if (el) el.classList.remove('show');
  }

  function toast(message, type = '') {
    let root = document.getElementById('toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toast-root';
      document.body.appendChild(root);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 320);
    }, 4200);
  }

  /* ---------------- partials ---------------- */
  async function loadPartial(name, targetId) {
    try {
      const res = await fetch('/partials/' + name + '.html');
      if (!res.ok) return;
      const html = await res.text();
      const target = document.getElementById(targetId);
      if (target) {
        target.innerHTML = html;
        target.dispatchEvent(new CustomEvent('partial:loaded', { detail: name }));
      }
    } catch (_) {
      /* partial unavailable - page still works without it */
    }
  }

  function initNavbar() {
    const toggle = document.getElementById('navToggle');
    const links = document.getElementById('navLinks');
    if (toggle && links) {
      toggle.addEventListener('click', () => {
        const open = links.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
      });
    }

    const user = getUser();
    const path = location.pathname.replace('.html', '') || '/';

    document.querySelectorAll('[data-nav]').forEach((a) => {
      const target = a.getAttribute('data-nav');
      if (target === path || (target !== '/' && path.startsWith(target))) a.classList.add('active');
    });

    const authLink = document.getElementById('navAuthLink');
    const userLink = document.getElementById('navUserLink');
    const dashLink = document.getElementById('navDashLink');
    const dashAnchor = document.getElementById('navDashAnchor');

    if (isLoggedIn() && user) {
      if (authLink) authLink.hidden = true;
      if (userLink) userLink.hidden = false;
      if (dashLink && dashAnchor) {
        dashLink.hidden = false;
        dashAnchor.textContent = user.role === 'ADMIN' ? 'Admin' : user.role === 'STUDENT' ? 'My credentials' : 'Dashboard';
        dashAnchor.href = dashboardUrl(user.role);
      }
      const chip = document.getElementById('navUserChip');
      const avatar = document.getElementById('navUserAvatar');
      const chipName = document.getElementById('navUserName');
      const chipRole = document.getElementById('navUserRole');
      if (chip && avatar && chipName && chipRole) {
        const initials = user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
        avatar.textContent = initials;
        chipName.textContent = user.name;
        chipRole.textContent = user.role.charAt(0) + user.role.slice(1).toLowerCase();
        chip.href = dashboardUrl(user.role);
      }
      const logoutBtn = document.getElementById('navLogoutBtn');
      if (logoutBtn) {
        logoutBtn.onclick = () => {
          clearSession();
          toast('Logged out.');
          location.href = '/index.html';
        };
      }
      // Bell shows a dot only when this user's verification history really
      // contains suspicious/tampered results (never a fake notification).
      const bellDot = document.getElementById('navBellDot');
      if (bellDot) {
        api('/api/dashboard').then((res) => {
          const v = res.data && res.data.verifications;
          if (v && Number(v.suspicious) > 0) bellDot.hidden = false;
        }).catch(() => {
          api('/api/students/me/history').then((res) => {
            const rows = (res.data && res.data.history) || [];
            if (rows.some((h) => h.final_result === 'SUSPICIOUS' || h.final_result === 'TAMPERED')) bellDot.hidden = false;
          }).catch(() => {});
        });
      }
    }
  }

  /* ---------------- rendering helpers ---------------- */
  const STATUS_META = {
    VERIFIED: { cls: 'badge-ok', glyph: '✓', label: 'Verified' },
    ACTIVE: { cls: 'badge-ok', glyph: '✓', label: 'Active' },
    SUSPICIOUS: { cls: 'badge-warn', glyph: '⚠', label: 'Suspicious' },
    TAMPERED: { cls: 'badge-bad', glyph: '✕', label: 'Tampered' },
    REVOKED: { cls: 'badge-revoked', glyph: '⊘', label: 'Revoked' },
    NOT_FOUND: { cls: 'badge-neutral', glyph: '—', label: 'Not Found' },
    ERROR: { cls: 'badge-bad', glyph: '✕', label: 'Error' },
    REGISTERED: { cls: 'badge-ok', glyph: '✓', label: 'Registered' },
    PENDING: { cls: 'badge-warn', glyph: '◐', label: 'Pending' },
    FAILED: { cls: 'badge-bad', glyph: '✕', label: 'Failed' },
    NOT_CONFIGURED: { cls: 'badge-neutral', glyph: '—', label: 'Not configured' },
    APPROVED: { cls: 'badge-ok', glyph: '✓', label: 'Approved' },
    REJECTED: { cls: 'badge-bad', glyph: '✕', label: 'Rejected' },
    SUSPENDED: { cls: 'badge-revoked', glyph: '⊘', label: 'Suspended' },
    SENSITIVE: { cls: 'badge-neutral', glyph: '—', label: '—' },
  };

  function statusBadge(status) {
    const meta = STATUS_META[status] || { cls: 'badge-neutral', glyph: '•', label: status || 'Unknown' };
    return `<span class="badge ${meta.cls}"><span aria-hidden="true">${meta.glyph}</span> ${escapeHtml(meta.label)}</span>`;
  }

  function blockchainBadge(blockchainStatus) {
    if (blockchainStatus === 'registered') return statusBadge('REGISTERED');
    if (blockchainStatus === 'pending') return `<span class="badge badge-warn"><span aria-hidden="true">◐</span> Awaiting chain</span>`;
    if (blockchainStatus === 'failed') return `<span class="badge badge-bad"><span aria-hidden="true">✕</span> Chain failed</span>`;
    if (blockchainStatus === 'not_configured') return `<span class="badge badge-neutral"><span aria-hidden="true">—</span> Chain unavailable</span>`;
    return `<span class="badge badge-neutral"><span aria-hidden="true">—</span> ${escapeHtml(blockchainStatus || 'Unknown')}</span>`;
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d)) return escapeHtml(value);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d)) return escapeHtml(value);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function emptyState(title, message, icon = '◇') {
    return `<div class="state"><span class="state-icon" aria-hidden="true">${icon}</span><h3>${escapeHtml(title)}</h3>${
      message ? `<p>${escapeHtml(message)}</p>` : ''}</div>`;
  }

  function errorState(title, message) {
    return `<div class="state"><span class="state-icon" aria-hidden="true">⚠</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(
      message || ''
    )}</p></div>`;
  }

  function loadingState(message) {
    return `<div class="loading-row" role="status"><span class="spinner" aria-hidden="true"></span> ${escapeHtml(message)}</div>`;
  }

  function setButtonBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      btn.dataset.originalHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${escapeHtml(label || 'Working...')}`;
    } else {
      btn.disabled = false;
      if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
    }
  }

  /* ---------------- technical details renderer ---------------- */
  function technicalPanel(tech) {
    if (!tech) return '';
    const rows = [
      ['SHA-256 fingerprint', tech.documentSha256],
      ['Blockchain tx hash', tech.blockchainTxHash],
      ['Block number', tech.blockNumber],
      ['Contract address', tech.contractAddress],
      ['Issuer wallet', tech.issuerWallet],
      ['Network endpoint', tech.network],
      ['Registered at', tech.registeredAt ? fmtDateTime(tech.registeredAt) : 'Not available'],
      ['Chain status', tech.blockchainStatus],
    ];
    const body = rows
      .map(([k, v]) => {
        const val = v || 'Not available';
        const isCopyable = k === 'SHA-256 fingerprint' || k === 'Blockchain tx hash';
        return `<div class="tech-row"><span class="tk">${escapeHtml(k)}</span><span class="tv">${escapeHtml(val)}${
          isCopyable && val !== 'Not available'
            ? `<button class="copy-btn" type="button" data-copy="${escapeHtml(val)}">Copy</button>`
            : ''
        }</span></div>`;
      })
      .join('');
    return `<details class="tech">
      <summary>View Technical Details</summary>
      <div class="tech-body">${body}</div>
    </details>`;
  }

  function bindCopyButtons(root) {
    (root || document).querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(btn.getAttribute('data-copy'));
          const original = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => (btn.textContent = original), 1500);
        } catch (_) {
          toast('Could not copy to clipboard.', 'error');
        }
      });
    });
  }

  /* ---------------- result rendering ---------------- */
  const RESULT_META = {
    VERIFIED: { cls: 'result-verified', glyph: '✓', title: 'Certificate Verified' },
    TAMPERED: { cls: 'result-tampered', glyph: '✕', title: 'Verification Failed — Tampered' },
    SUSPICIOUS: { cls: 'result-suspicious', glyph: '⚠', title: 'Requires Review — Suspicious' },
    REVOKED: { cls: 'result-revoked', glyph: '⊘', title: 'Certificate Revoked' },
    NOT_FOUND: { cls: 'result-notfound', glyph: '—', title: 'Certificate Not Found' },
  };

  function renderResultHero(finalResult, message) {
    const meta = RESULT_META[finalResult] || RESULT_META.NOT_FOUND;
    return `<div class="result-hero ${meta.cls}" role="status">
      <span class="glyph" aria-hidden="true">${meta.glyph}</span>
      <div><h1>${escapeHtml(meta.title)}</h1><p>${escapeHtml(message || '')}</p></div>
    </div>`;
  }

  function renderCheckGrid(ai) {
    if (!ai || !ai.performed || !ai.checks || ai.checks.length === 0) {
      return `<div class="state"><span class="state-icon" aria-hidden="true">ⓘ</span><h3>AI analysis not performed</h3><p>${escapeHtml(
        (ai && ai.message) || 'AI analysis has not been performed.'
      )}</p></div>`;
    }
    const glyphs = { pass: '✓', warning: '⚠', fail: '✕', insufficient: '—' };
    const items = ai.checks
      .map(
        (c) => `<div class="check-item ${escapeHtml(c.status)}">
          <span class="ci-glyph" aria-hidden="true">${glyphs[c.status] || '—'}</span>
          <div><strong>${escapeHtml(c.name)}</strong>${c.note ? `<span class="ci-note">${escapeHtml(c.note)}</span>` : ''}</div>
        </div>`
      )
      .join('');
    return `<div class="check-grid">${items}</div>`;
  }

  function renderRiskMeter(riskScore, band) {
    const b = band || (riskScore < 31 ? 'low' : riskScore < 71 ? 'medium' : 'high');
    const label = b === 'low' ? 'Likely Authentic' : b === 'medium' ? 'Suspicious' : 'Likely Tampered';
    return `<div>
      <div class="risk-meter" role="meter" aria-valuenow="${riskScore}" aria-valuemin="0" aria-valuemax="100" aria-label="AI risk score">
        <div class="fill ${b}" style="width:${Math.max(2, Math.min(100, riskScore))}%"></div>
      </div>
      <div class="risk-legend"><span>0 · Authentic</span><strong>${riskScore}/100 · ${escapeHtml(label)}</strong><span>100 · Tampered</span></div>
    </div>`;
  }

  /* ---------------- misc ---------------- */
  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  function debounce(fn, ms = 300) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsv(filename, rows) {
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function initReveal() {
    const els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
  }

  /**
   * Certificate documents are download-protected by requireAuth. A plain
   * <a href="/api/certificates/N/download"> navigates WITHOUT the Bearer
   * header and lands on a 401 JSON response. Intercept such links globally:
   * fetch privately with the token, then hand the blob to the browser's
   * normal save flow. Works for links rendered after load too (event
   * delegation on document).
   */
  async function authedDownload(a) {
    const url = a.getAttribute('href') || '';
    try {
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        toast((payload && payload.message) || 'Download failed (' + res.status + ').', 'error');
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
      const a2 = document.createElement('a');
      a2.href = URL.createObjectURL(blob);
      a2.download = match ? decodeURIComponent(match[1].replace(/"/g, '')) : 'certificate';
      document.body.appendChild(a2);
      a2.click();
      a2.remove();
      setTimeout(() => URL.revokeObjectURL(a2.href), 4000);
    } catch (_) {
      toast('Download failed: network error.', 'error');
    }
  }

  /** Bootstrap: load partials, then wire nav + globals. */
  async function boot() {
    await Promise.all([loadPartial('navbar', 'partial-navbar'), loadPartial('alerts', 'partial-alerts'), loadPartial('footer', 'partial-footer')]);
    initNavbar();
    initReveal();

    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href*="/download"]');
      if (link && link.origin === location.origin && isLoggedIn()) {
        e.preventDefault();
        authedDownload(link);
        return;
      }
      const copy = e.target.closest('[data-copy]');
      if (copy) bindCopyButtons(document);
    });
  }

  window.BlockCert = {
    api,
    getToken,
    getUser,
    setSession,
    clearSession,
    isLoggedIn,
    requireLogin,
    dashboardUrl,
    showAlert,
    hideAlert,
    toast,
    statusBadge,
    blockchainBadge,
    escapeHtml,
    fmtDate,
    fmtDateTime,
    emptyState,
    errorState,
    loadingState,
    setButtonBusy,
    technicalPanel,
    bindCopyButtons,
    renderResultHero,
    renderCheckGrid,
    renderRiskMeter,
    qs,
    debounce,
    downloadCsv,
    loadPartial,
    STATUS_META,
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
