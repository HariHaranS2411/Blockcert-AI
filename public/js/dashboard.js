/* ============================================================
   BlockCert AI - shared dashboard shell
   Sidebar construction, session guard, logout.
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  if (!B) return;

  /**
   * Build the dashboard sidebar.
   * items: [{ section, label, href, icon, id }]
   */
  function buildSidebar(opts) {
    const user = B.getUser();
    if (!user) return null;

    const dash = document.querySelector('.dash');
    if (!dash) return null;

    const sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    sidebar.id = 'dashSidebar';
    sidebar.setAttribute('aria-label', 'Dashboard navigation');

    const navHtml = opts.items
      .map((item) => {
        if (item.section) return `<div class="side-label">${B.escapeHtml(item.section)}</div>`;
        const active = item.id === opts.active ? 'active' : '';
        return `<a href="${item.href}" class="${active}"${item.id === opts.active ? ' aria-current="page"' : ''}><span class="sn-icon" aria-hidden="true">${item.icon}</span>${B.escapeHtml(item.label)}</a>`;
      })
      .join('');

    sidebar.innerHTML = `
      <div class="who">
        <div class="role">${B.escapeHtml(user.role)}</div>
        <div class="name">${B.escapeHtml(user.name)}</div>
        ${user.institution && user.institution.name ? `<div class="inst">${B.escapeHtml(user.institution.name)} ${B.statusBadge(user.institution.verification_status)}</div>` : ''}
      </div>
      <nav class="side-nav">${navHtml}</nav>
      <div class="side-footer">
        <div class="sidebar-promo" aria-hidden="false">
          <span class="sp-glyph">⬡</span>
          <div class="sp-title">Powered by Blockchain<br />&amp; AI Technology</div>
          <a class="btn btn-outline btn-sm" href="/how-it-works.html">Learn More →</a>
        </div>
        <button class="btn btn-outline btn-block btn-sm" type="button" id="sideLogout">Log out</button>
      </div>
    `;

    dash.insertBefore(sidebar, dash.firstChild);

    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    backdrop.id = 'sidebarBackdrop';
    document.body.appendChild(backdrop);

    const toggle = document.createElement('button');
    toggle.className = 'sidebar-toggle';
    toggle.type = 'button';
    toggle.innerHTML = '☰ Menu';
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      backdrop.classList.toggle('show');
    });
    backdrop.addEventListener('click', () => {
      sidebar.classList.remove('open');
      backdrop.classList.remove('show');
    });
    dash.querySelector('.dash-main').prepend(toggle);

    document.getElementById('sideLogout').addEventListener('click', () => {
      B.clearSession();
      B.toast('Logged out.');
      location.href = '/index.html';
    });

    return sidebar;
  }

  /** Guard: redirect anonymous visitors to login. */
  function guardRole(roles) {
    const user = B.getUser();
    if (!user || !B.isLoggedIn()) {
      localStorage.setItem('blockcert_redirect', location.pathname + location.search);
      location.href = '/login.html';
      return null;
    }
    if (roles && roles.length && !roles.includes(user.role)) {
      B.showAlert('This page is for ' + roles.join(' or ') + ' accounts. Redirecting to your dashboard…', 'warn');
      setTimeout(() => (location.href = B.dashboardUrl(user.role)), 1400);
      return null;
    }
    return user;
  }

  window.Dash = { buildSidebar, guardRole };
})();
