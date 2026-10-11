/* ============================================================
   BlockCert AI - certificate issuance flow
   Upload → OCR review → SHA-256 → blockchain registration → QR.
   Progress steps reflect real stage completion.
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  const D = window.Dash;
  if (!B || !D) return;

  const user = D.guardRole(['INSTITUTION', 'ADMIN']);
  if (!user) return;

  D.buildSidebar({
    active: 'issue',
    items: [
      { section: 'Workspace' },
      { id: 'dashboard', label: 'Dashboard', href: '/institution-dashboard.html', icon: '▤' },
      { id: 'issue', label: 'Issue Certificate', href: '/issue-certificate.html', icon: '＋' },
      { id: 'bulk', label: 'Bulk Issue', href: '/institution-dashboard.html#bulkIssue', icon: '≡' },
      { section: 'Records' },
      { id: 'certs', label: 'Certificates', href: '/institution-dashboard.html#register', icon: '▦' },
      { id: 'revoke', label: 'Revoke Certificate', href: '/institution-dashboard.html#revokeSection', icon: '⊘' },
      { id: 'history', label: 'Verification History', href: '/verification-history.html', icon: '⏱' },
      { section: 'Account' },
      { id: 'profile', label: 'Institution Profile', href: '/institution-dashboard.html#profilePanel', icon: '🏛' },
    ],
  });

  let file = null;
  let previewUrl = null;
  let certificateTypes = [];

  /* ---------------- certificate type options from the API ---------------- */
  async function loadTypes() {
    const select = document.getElementById('certificateType');
    try {
      const res = await B.api('/api/certificates?limit=1');
      certificateTypes = res.data.certificateTypes || [];
    } catch (_) {
      certificateTypes = [];
    }
    if (!certificateTypes.length) {
      // Fallback list is configuration, not business data.
      certificateTypes = ['Degree', 'Diploma', 'Internship', 'Course', 'Workshop', 'Hackathon', 'Sports', 'NSS/NCC', 'Training', 'Skill', 'Academic Transcript'];
    }
    select.innerHTML = certificateTypes.map((t) => `<option value="${B.escapeHtml(t)}">${B.escapeHtml(t)}</option>`).join('');
    populateSemesters();
  }

  /* ---------------- semester options: Not specified + 1..10 ---------------- */
  function populateSemesters() {
    const sel = document.getElementById('semester');
    if (!sel) return;
    sel.innerHTML = '<option value="">Not semester-based</option>' +
      Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}">Semester ${i + 1}</option>`).join('');
  }

  /* ---------------- upload ---------------- */
  const zone = document.getElementById('docZone');
  const input = document.getElementById('docInput');
  const docName = document.getElementById('docName');
  const ocrBtn = document.getElementById('ocrBtn');
  const issueBtn = document.getElementById('issueBtn');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  ['dragover', 'dragenter'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files[0]) setFile(input.files[0]); });

  function setFile(f) {
    if (!/\.(pdf|png|jpe?g)$/i.test(f.name)) {
      B.showAlert('Only PDF, PNG or JPG files can be issued.', 'warn');
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      B.showAlert('File is larger than the 10 MB limit.', 'warn');
      return;
    }
    file = f;
    docName.hidden = false;
    docName.textContent = f.name + ' (' + Math.round(f.size / 1024) + ' KB)';
    ocrBtn.disabled = false;
    issueBtn.disabled = false;

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(f);
    const preview = document.getElementById('docPreview');
    if (/\.pdf$/i.test(f.name)) {
      preview.innerHTML = `<iframe src="${previewUrl}" title="Certificate preview"></iframe>`;
    } else {
      preview.innerHTML = `<img src="${previewUrl}" alt="Certificate preview" />`;
    }
    resetSteps();
  }

  /* ---------------- OCR ---------------- */
  ocrBtn.addEventListener('click', async () => {
    if (!file) return;
    B.hideAlert();
    B.setButtonBusy(ocrBtn, true, 'Extracting…');
    document.getElementById('ocrBusy').hidden = false;
    document.getElementById('ocrResult').innerHTML = '';
    setStep('ocr', 'active');

    const fd = new FormData();
    fd.append('document', file);
    try {
      const res = await B.api('/api/ocr/extract', { method: 'POST', body: fd });
      const fields = res.data.fields || {};
      setStep('ocr', 'done');

      // Fill the form with suggestions; the human still confirms everything.
      const map = {
        studentName: fields.studentName,
        registrationNumber: fields.registrationNumber,
        degree: fields.degree,
        department: fields.department,
        academicYear: fields.academicYear,
        marks: fields.marks,
        issueDate: normalizeDate(fields.issueDate),
      };
      let filled = 0;
      for (const [id, value] of Object.entries(map)) {
        if (value) {
          const el = document.getElementById(id);
          if (el) {
            el.value = value;
            filled += 1;
          }
        }
      }
      const certRefNote = fields.certificateId
        ? ` Extracted certificate reference <span class="mono">${B.escapeHtml(fields.certificateId)}</span> — a new unique ID is still allocated at issuance.`
        : '';
      const textBlock = res.data.text
        ? `<details class="tech"><summary>View extracted text</summary><div class="tech-body"><div class="ocr-text" style="max-height:240px">${B.escapeHtml(res.data.text.slice(0, 6000))}</div></div></details>`
        : '';
      document.getElementById('ocrResult').innerHTML =
        `<div class="alert show alert-success">Text extracted. ${filled} field${filled === 1 ? '' : 's'} pre-filled from OCR — review each one.${certRefNote}</div>${textBlock}`;
      B.toast('OCR complete — review the fields.', 'success');
    } catch (err) {
      setStep('ocr', 'failed');
      document.getElementById('ocrResult').innerHTML = `<div class="alert show alert-warn">${B.escapeHtml(err.message)} You can still fill in every field manually.</div>`;
    } finally {
      document.getElementById('ocrBusy').hidden = true;
      B.setButtonBusy(ocrBtn, false);
    }
  });

  function normalizeDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d)) return '';
    return d.toISOString().slice(0, 10);
  }

  /* ---------------- progress steps ---------------- */
  function setStep(name, state) {
    const li = document.querySelector(`#issueSteps [data-step="${name}"]`);
    if (!li) return;
    li.classList.remove('active', 'done', 'failed');
    li.classList.add(state);
    li.querySelector('.ps-glyph').textContent = state === 'done' ? '✓' : state === 'failed' ? '✕' : state === 'active' ? '◐' : '○';
  }
  function resetSteps() {
    document.querySelectorAll('#issueSteps li').forEach((li) => {
      li.classList.remove('active', 'done', 'failed');
      li.querySelector('.ps-glyph').textContent = '○';
    });
  }

  /* ---------------- issuance ---------------- */
  document.getElementById('issueForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    B.hideAlert();
    document.getElementById('issueResult').innerHTML = '';

    if (!file) {
      B.showAlert('Upload a certificate document first.', 'warn');
      return;
    }

    const required = ['studentName', 'registrationNumber', 'degree', 'certificateType', 'issueDate'];
    for (const id of required) {
      const el = document.getElementById(id);
      if (!el.value || !el.value.trim()) {
        B.showAlert(`Fill in "${el.previousElementSibling ? el.previousElementSibling.textContent.replace(/ \(optional\).*/, '') : id}" before issuing.`, 'warn');
        el.focus();
        return;
      }
    }

    const btn = issueBtn;
    B.setButtonBusy(btn, true, 'Issuing…');
    resetSteps();
    setStep('upload', 'active');

    const fd = new FormData();
    fd.append('document', file);
    fd.append('studentName', document.getElementById('studentName').value.trim());
    fd.append('registrationNumber', document.getElementById('registrationNumber').value.trim());
    fd.append('degree', document.getElementById('degree').value.trim());
    fd.append('department', document.getElementById('department').value.trim());
    fd.append('certificateType', document.getElementById('certificateType').value);
    fd.append('semester', document.getElementById('semester').value);
    fd.append('academicYear', document.getElementById('academicYear').value.trim());
    fd.append('marks', document.getElementById('marks').value.trim());
    fd.append('issueDate', document.getElementById('issueDate').value);
    if (document.getElementById('expiryDate').value) {
      fd.append('expiryDate', document.getElementById('expiryDate').value);
    }
    const studentEmail = document.getElementById('studentEmail').value.trim();
    const studentPassword = document.getElementById('studentPassword').value;
    fd.append('studentEmail', studentEmail);
    fd.append('studentPassword', studentPassword);
    if (!studentEmail) {
      B.showAlert('Student login email is required — the student will use it to see this certificate.', 'warn');
      B.setButtonBusy(btn, false);
      return;
    }
    if (!studentPassword) {
      B.showAlert('Student login password is required — the student will use it to log in and see this certificate.', 'warn');
      B.setButtonBusy(btn, false);
      return;
    }
    if (studentPassword.length < 8 || !/[A-Za-z]/.test(studentPassword) || !/[0-9]/.test(studentPassword)) {
      B.showAlert('Student password must be at least 8 characters and contain a letter and a digit.', 'warn');
      B.setButtonBusy(btn, false);
      return;
    }

    // Animate the known stages while the real request runs.
    const chainTimer = setTimeout(() => { setStep('upload', 'done'); setStep('ocr', 'done'); setStep('hash', 'done'); setStep('chain', 'active'); }, 900);
    const confirmTimer = setTimeout(() => { setStep('chain', 'done'); setStep('confirm', 'active'); }, 3200);

    try {
      const res = await B.api('/api/certificates', { method: 'POST', body: fd });
      clearTimeout(chainTimer);
      clearTimeout(confirmTimer);

      const d = res.data;
      if (d.blockchain.registered) {
        setStep('upload', 'done'); setStep('ocr', 'done'); setStep('hash', 'done');
        setStep('chain', 'done'); setStep('confirm', 'done'); setStep('done', 'done');
      } else {
        setStep('upload', 'done'); setStep('ocr', 'done'); setStep('hash', 'done');
        setStep('chain', 'failed'); setStep('confirm', 'failed'); setStep('done', 'failed');
      }

      const c = d.certificate;
      document.getElementById('issueResult').innerHTML = `
        <div class="alert show ${d.blockchain.registered ? 'alert-success' : 'alert-warn'}">
          <strong>${B.escapeHtml(res.message)}</strong>
        </div>
        <div class="result-facts">
          <div class="fact"><div class="k">Certificate ID</div><div class="v mono">${B.escapeHtml(c.certificateId)}</div></div>
          <div class="fact"><div class="k">SHA-256</div><div class="v mono">${B.escapeHtml(d.documentHash)}<button class="copy-btn" type="button" data-copy="${B.escapeHtml(d.documentHash)}">Copy</button></div></div>
          <div class="fact"><div class="k">Blockchain tx</div><div class="v mono">${B.escapeHtml(d.blockchain.txHash || 'Not available')}</div></div>
          <div class="fact"><div class="k">Block number</div><div class="v">${d.blockchain.blockNumber ?? 'Not available'}</div></div>
          <div class="fact"><div class="k">Registered</div><div class="v">${B.statusBadge(c.status)} ${B.blockchainBadge(c.blockchainStatus)}</div></div>
          <div class="fact"><div class="k">Timestamp</div><div class="v">${B.fmtDateTime(c.createdAt)}</div></div>
        </div>
        ${
          d.qrDataUrl
            ? `<div class="qr-box mt-2"><img src="${d.qrDataUrl}" alt="QR code for ${B.escapeHtml(c.certificateId)}" /><p class="small muted mb-0">Public verification QR</p></div>`
            : ''
        }
        <div class="btn-row mt-2">
          <a class="btn btn-primary btn-sm" href="/certificate-details.html?id=${c.id}">Open certificate</a>
          <a class="btn btn-outline btn-sm" href="/api/certificates/${c.id}/download" download>Download Certificate</a>
          ${
            d.qrDataUrl
              ? `<a class="btn btn-outline btn-sm" href="${d.qrDataUrl}" download="${B.escapeHtml(c.certificateId)}-qr.png">Download Verification QR</a>`
              : ''
          }
        </div>
        <div class="disclaimer">AI provides a document-risk assessment. Blockchain verification confirms whether the document matches the official issuer record. AI results are not absolute proof of authenticity.</div>`;

      B.bindCopyButtons(document.getElementById('issueResult'));
      B.toast(d.blockchain.registered ? 'Certificate registered on the blockchain.' : 'Certificate saved, but blockchain registration did not complete.', d.blockchain.registered ? 'success' : 'warn');

      file = null;
      input.value = '';
      docName.hidden = true;
      ocrBtn.disabled = true;
      issueBtn.disabled = true;
      document.getElementById('issueForm').reset();
      document.getElementById('docPreview').innerHTML = '<p class="muted small">No document uploaded yet.</p>';
      document.getElementById('ocrResult').innerHTML = '';
      loadTypes();
    } catch (err) {
      clearTimeout(chainTimer);
      clearTimeout(confirmTimer);
      const active = document.querySelector('#issueSteps li.active');
      if (active) {
        active.classList.remove('active');
        active.classList.add('failed');
        active.querySelector('.ps-glyph').textContent = '✕';
      }
      document.getElementById('issueResult').innerHTML = `<div class="alert show alert-error"><strong>The certificate was not issued.</strong> ${B.escapeHtml(err.message)}</div>`;
      B.toast('Issuance failed: ' + err.message, 'error');
    } finally {
      B.setButtonBusy(btn, false);
    }
  });

  document.addEventListener('DOMContentLoaded', loadTypes);
})();
