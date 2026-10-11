/* ============================================================
   BlockCert AI - auth pages (login / signup)
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  if (!B) return;

  /* If already logged in, go to the dashboard. */
  function redirectIfLoggedIn() {
    const user = B.getUser();
    if (user && B.isLoggedIn()) location.href = B.dashboardUrl(user.role);
  }

  /* ---------------- LOGIN ---------------- */
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    redirectIfLoggedIn();
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      B.hideAlert();
      const btn = document.getElementById('loginBtn');
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;

      if (!email || !password) {
        B.showAlert('Enter your email and password.', 'warn');
        return;
      }

      B.setButtonBusy(btn, true, 'Logging in…');
      try {
        const res = await B.api('/api/auth/login', { method: 'POST', body: { email, password } });
        B.setSession(res.data.token, res.data.user);
        B.toast('Welcome back, ' + res.data.user.name + '.', 'success');

        const redirect = localStorage.getItem('blockcert_redirect');
        localStorage.removeItem('blockcert_redirect');
        location.href = redirect || B.dashboardUrl(res.data.user.role);
      } catch (err) {
        B.showAlert(err.message, 'error');
        B.setButtonBusy(btn, false);
      }
    });
  }

  /* ---------------- SIGNUP ---------------- */
  const signupForm = document.getElementById('signupForm');
  if (signupForm) {
    redirectIfLoggedIn();

    const roleInputs = signupForm.querySelectorAll('input[name="role"]');
    const instFields = document.getElementById('institutionFields');
    const studentRegField = document.getElementById('studentRegField');
    const regLabel = studentRegField.querySelector('label');
    const regHint = document.getElementById('regHint');
    const regOptional = document.getElementById('regOptional');

    function applyRoleUi() {
      const role = signupForm.querySelector('input[name="role"]:checked').value;
      instFields.hidden = role !== 'INSTITUTION';
      document.getElementById('institutionName').required = role === 'INSTITUTION';
      studentRegField.hidden = role === 'INSTITUTION';
      if (role === 'STUDENT') {
        regLabel.innerHTML = 'Registration / roll number <span class="muted" id="regOptional">(optional)</span>';
        regHint.textContent = 'If your institution issued certificates with this number, they will be linked to your account automatically.';
      } else if (role === 'EMPLOYER') {
        regLabel.innerHTML = 'Registration / roll number <span class="muted">(optional)</span>';
        regHint.textContent = 'Optional professional registration number.';
      }
    }
    roleInputs.forEach((input) => input.addEventListener('change', applyRoleUi));
    applyRoleUi();

    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      B.hideAlert();
      const btn = document.getElementById('signupBtn');

      const role = signupForm.querySelector('input[name="role"]:checked').value;
      const body = {
        name: document.getElementById('name').value.trim(),
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value,
        role,
      };
      if (role === 'INSTITUTION') {
        body.institutionName = document.getElementById('institutionName').value.trim();
        body.website = document.getElementById('website').value.trim() || undefined;
        body.address = document.getElementById('address').value.trim() || undefined;
      }
      const regNumber = document.getElementById('registrationNumber').value.trim();
      if (regNumber) body.registrationNumber = regNumber;

      if (!body.name || !body.email || !body.password) {
        B.showAlert('Fill in name, email and password.', 'warn');
        return;
      }
      if (body.role === 'INSTITUTION' && !body.institutionName) {
        B.showAlert('Institution name is required for institution accounts.', 'warn');
        return;
      }

      B.setButtonBusy(btn, true, 'Creating account…');
      try {
        const res = await B.api('/api/auth/register', { method: 'POST', body });
        B.setSession(res.data.token, res.data.user);
        B.toast(res.message, 'success');
        const redirect = localStorage.getItem('blockcert_redirect');
        localStorage.removeItem('blockcert_redirect');
        location.href = redirect || B.dashboardUrl(res.data.user.role);
      } catch (err) {
        B.showAlert(err.message, 'error');
        B.setButtonBusy(btn, false);
      }
    });
  }
  /* ---------------- FORGOT PASSWORD ---------------- */
  const forgotForm = document.getElementById('forgotForm');
  if (forgotForm) {
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      B.hideAlert();
      const btn = document.getElementById('forgotBtn');
      const email = document.getElementById('email').value.trim();
      if (!email) {
        B.showAlert('Enter the email address of your account.', 'warn');
        return;
      }
      B.setButtonBusy(btn, true, 'Submitting…');
      try {
        const res = await B.api('/api/auth/forgot-password', { method: 'POST', body: { email } });
        B.showAlert(res.message, 'info');
      } catch (err) {
        // Honest error state: the server reports the real (unavailable) condition.
        B.showAlert(err.message, 'warn');
      } finally {
        B.setButtonBusy(btn, false);
      }
    });
  }
})();
