/* ============================================================
   BlockCert AI - digital credential profile
   Public-safe data only: certificate ID, type, institution,
   issue date, verification status, verification URL.
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  if (!B) return;

  const area = document.getElementById('profileArea');
  const studentId = B.qs('student');

  area.innerHTML = B.loadingState('Loading credential profile…');

  function render(profile, isOwn) {
    if (!profile.credentials.length) {
      area.innerHTML = `
        <h1>Digital credential profile</h1>
        ${B.emptyState(
          isOwn ? 'No certificates have been issued to your account yet.' : 'No public credentials are available for this profile.',
          isOwn ? 'When an institution issues a credential to you, it will appear here.' : '',
          '◧'
        )}`;
      return;
    }

    area.innerHTML = `
      <div class="dash-head">
        <div>
          <h1 style="font-size:1.5rem">${B.escapeHtml(profile.holderName)}</h1>
          <p>Digital credential profile · ${profile.credentials.length} credential${profile.credentials.length === 1 ? '' : 's'}</p>
        </div>
        <div class="btn-row">
          <button class="btn btn-outline btn-sm" type="button" id="shareProfile">Share profile</button>
          ${isOwn ? '<a class="btn btn-outline btn-sm" href="/student-dashboard.html">My dashboard</a>' : ''}
        </div>
      </div>

      <div class="cert-cards">
        ${profile.credentials
          .map(
            (c) => `<article class="cert-card">
              <span class="cc-type">${B.escapeHtml(c.certificateType)}</span>
              <span class="cc-degree">${B.escapeHtml(c.credential)}</span>
              <span class="cc-meta">${B.escapeHtml(c.institution)} · ${B.fmtDate(c.issueDate)}</span>
              <span>${B.statusBadge(c.verificationStatus)}</span>
              <span class="cc-meta mono">${B.escapeHtml(c.certificateId)}</span>
              <div class="btn-row">
                <a class="btn btn-primary btn-sm" href="${B.escapeHtml(c.verificationUrl)}">Verify</a>
              </div>
            </article>`
          )
          .join('')}
      </div>

      <div class="disclaimer">This profile exposes only public-safe fields: certificate ID, type, institution, issue date, verification status and verification URL. No documents, emails or private records are shared.</div>`;

    const share = document.getElementById('shareProfile');
    if (share) {
      share.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(location.href);
          B.toast('Profile link copied.', 'success');
        } catch (_) {
          B.toast('Could not copy the link.', 'error');
        }
      });
    }
  }

  if (studentId) {
    // Public profile view - no login required, public-safe fields only.
    B.api('/api/students/' + encodeURIComponent(studentId) + '/public-profile')
      .then((res) => render(res.data.profile, false))
      .catch((err) => {
        area.innerHTML = B.errorState('Credential profile not available', err.message);
      });
  } else if (B.isLoggedIn() && B.getUser() && B.getUser().role === 'STUDENT') {
    B.api('/api/students/me/credentials')
      .then((res) => render(res.data.profile, true))
      .catch((err) => {
        if (err.status === 401) {
          location.href = '/login.html';
          return;
        }
        area.innerHTML = B.errorState('Credential profile unavailable', err.message);
      });
  } else if (B.isLoggedIn()) {
    // Signed-in non-student without a ?student param.
    const me = B.getUser();
    B.api('/api/students/' + encodeURIComponent(me.id) + '/public-profile')
      .then((res) => render(res.data.profile, false))
      .catch((err) => {
        area.innerHTML = B.errorState('Credential profile unavailable', err.message);
      });
  } else {
    area.innerHTML = B.emptyState(
      'No credential profile specified.',
      'Open this page from a shared profile link, or log in with a student account to view your own profile.',
      '◧'
    );
  }
})();
