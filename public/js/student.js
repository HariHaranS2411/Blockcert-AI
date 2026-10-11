/* ============================================================
   BlockCert AI - student dashboard (dark console layout)
   Only the student's own certificates (server-enforced).
   Every widget renders real API data or an honest empty state.
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;
  const D = window.Dash;
  if (!B || !D) return;

  const user = D.guardRole(['STUDENT']);
  if (!user) return;

  D.buildSidebar({
    active: 'dashboard',
    items: [
      { section: 'Workspace' },
      { id: 'dashboard', label: 'Dashboard', href: '/student-dashboard.html', icon: '▤' },
      { id: 'certs', label: 'My Certificates', href: '/student-dashboard.html#recentCerts', icon: '▦' },
      { id: 'verify', label: 'Verify Certificate', href: '/verify.html', icon: '✓' },
      { id: 'history', label: 'Verification History', href: '/verification-history.html', icon: '⏱' },
      { section: 'Account' },
      { id: 'profile', label: 'Digital Credentials', href: '/credential-profile.html', icon: '◧' },
      { id: 'how', label: 'Settings & Help', href: '/about.html', icon: 'ⓘ' },
    ],
  });

  /* personalised hero (real account name, first name only) */
  const heroTitle = document.getElementById('heroTitle');
  if (heroTitle && user.name) {
    const first = user.name.trim().split(/\s+/)[0];
    heroTitle.textContent = 'Welcome back, ' + first + '! 👋';
  }

  function donut(percent) {
    const r = 52;
    const c = 2 * Math.PI * r;
    const filled = Math.max(0, Math.min(100, percent)) / 100 * c;
    return `<svg width="132" height="132" viewBox="0 0 132 132" aria-hidden="true">
      <circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--gray-bg)" stroke-width="12" />
      <circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--green)" stroke-width="12"
        stroke-linecap="round" stroke-dasharray="${filled.toFixed(1)} ${(c - filled).toFixed(1)}" />
    </svg>`;
  }

  function last7Days() {
    const days = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      days.push({ key: d.toISOString().slice(0, 10), label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), count: 0 });
    }
    return days;
  }

  function renderSummary(certificates, stats, history) {
    const total = stats.total || 0;
    const active = stats.active || 0;
    const revoked = stats.revoked || 0;
    const pending = certificates.filter((c) => c.blockchainStatus && c.blockchainStatus !== 'registered').length;
    const suspicious = (history || []).filter((h) => h.final_result === 'SUSPICIOUS' || h.final_result === 'TAMPERED').length;
    const percent = total ? Math.round((active / total) * 100) : 0;

    document.getElementById('summaryBody').innerHTML = `
      <div class="donut-wrap">
        ${donut(percent)}
        <div class="donut-center"><div><div class="dc-value">${percent}%</div><div class="dc-label">Verified</div></div></div>
      </div>
      <div class="summary-legend">
        <div class="legend-row"><span class="lr-dot ok"></span>Verified<span class="lr-count">${active}</span></div>
        <div class="legend-row"><span class="lr-dot warn"></span>Awaiting chain<span class="lr-count">${pending}</span></div>
        <div class="legend-row"><span class="lr-dot info"></span>Suspicious activity<span class="lr-count">${suspicious}</span></div>
        <div class="legend-row"><span class="lr-dot bad"></span>Revoked<span class="lr-count">${revoked}</span></div>
      </div>`;
    document.getElementById('summaryTotal').textContent = total;
  }

  function renderRecent(certificates) {
    const certArea = document.getElementById('certArea');
    if (!certificates.length) {
      certArea.innerHTML = `<div class="panel-body">${B.emptyState(
        'No certificates have been issued to your account yet.',
        'When an institution issues a credential to you, it will appear here.',
        '▦'
      )}</div>`;
      return;
    }
    const rows = certificates.slice(0, 6).map((c) => `
      <tr class="recent-row">
        <td><span class="rr-id"><span class="rr-icon" aria-hidden="true">▤</span><a class="mono" href="/certificate-details.html?id=${c.id}">${B.escapeHtml(c.certificateId)}</a></span></td>
        <td>${B.escapeHtml(c.degree)}</td>
        <td>${B.escapeHtml(c.institution)}</td>
        <td>${B.fmtDate(c.issueDate)}</td>
        <td>${B.statusBadge(c.status)}</td>
        <td class="actions">
          <a class="btn btn-outline btn-sm" href="/certificate-details.html?id=${c.id}">View</a>
          <a class="btn btn-outline btn-sm" href="/api/certificates/${c.id}/download">Download</a>
        </td>
      </tr>`).join('');
    certArea.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Certificate ID</th><th>Degree / Type</th><th>Institution</th><th>Issue Date</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function renderHistory(history) {
    const historyArea = document.getElementById('historyArea');
    if (!history.length) {
      historyArea.innerHTML = B.emptyState('No verification activity yet.', 'Verifications performed on your certificates appear here.', '⏱');
      return;
    }
    historyArea.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>Certificate</th><th>Method</th><th>Result</th><th>When</th></tr></thead>
      <tbody>${history.slice(0, 6).map((h) =>
        `<tr><td class="mono">${B.escapeHtml(h.certificate_ref)}</td><td>${B.escapeHtml(h.verification_method)}</td><td>${B.statusBadge(h.final_result)}</td><td>${B.fmtDateTime(h.created_at)}</td></tr>`
      ).join('')}</tbody></table></div>`;
  }

  function renderActivityChart(history) {
    const el = document.getElementById('activityChart');
    const days = last7Days();
    for (const h of history || []) {
      const key = String(h.created_at || '').slice(0, 10);
      const day = days.find((d) => d.key === key);
      if (day) day.count += 1;
    }
    const max = Math.max(...days.map((d) => d.count), 1);
    const allZero = days.every((d) => d.count === 0);
    if (allZero) {
      el.innerHTML = B.emptyState('No verification activity yet.', 'A daily chart appears here once your certificates are checked.', '📈');
      return;
    }
    el.innerHTML = `<div class="activity-chart">${days.map((d) => `
      <div class="ac-col" title="${d.label}: ${d.count} verification${d.count === 1 ? '' : 's'}">
        <div class="ac-bar ${d.count === 0 ? 'zero' : ''}" style="height:${Math.round((d.count / max) * 100)}%"></div>
        <div class="ac-day">${d.label}</div>
      </div>`).join('')}</div>`;
  }

  function renderAiCard(health) {
    const el = document.getElementById('aiCard');
    const configured = health && health.ai && health.ai.configured;
    el.innerHTML = `
      <div class="ai-status-row">
        <div class="ai-ring">
          <svg width="74" height="74" viewBox="0 0 74 74" aria-hidden="true">
            <circle cx="37" cy="37" r="30" fill="none" stroke="var(--gray-bg)" stroke-width="8" />
            <circle cx="37" cy="37" r="30" fill="none" stroke="${configured ? 'var(--green)' : 'var(--amber)'}" stroke-width="8"
              stroke-linecap="round" stroke-dasharray="${configured ? 188.5 : 47} 200" transform="rotate(-90 37 37)" />
          </svg>
        </div>
        <p>${configured
          ? 'AI analysis is configured on this server. Open the AI analysis page to review document risk assessments.'
          : 'AI analysis is currently unavailable on this server (no API key configured). No risk score will be shown until it is configured.'}</p>
      </div>
      <a class="btn btn-outline btn-sm mt-2" href="/ai-analysis.html">Learn More →</a>`;
  }

  function renderChainCard(health) {
    const chain = (health && health.blockchain) || {};
    const statusEl = document.getElementById('chainStatus');
    const el = document.getElementById('chainCard');
    const connected = chain.connected === true && chain.configured === true;
    statusEl.innerHTML = connected
      ? '<span class="chain-connected"><span aria-hidden="true">●</span>Connected</span>'
      : `<span class="chain-disconnected"><span aria-hidden="true">●</span>${chain.connected ? 'No contract' : 'Unavailable'}</span>`;
    const addr = chain.contractAddress ? chain.contractAddress.slice(0, 8) + '…' + chain.contractAddress.slice(-4) : 'Not configured';
    el.innerHTML = `
      <div class="chain-row"><span class="cr-icon" aria-hidden="true">⬡</span><span class="cr-text"><span class="cr-k">Chain ID ${chain.chainId ?? '—'}</span><span class="cr-s">Network</span></span></div>
      <div class="chain-row"><span class="cr-icon" aria-hidden="true">▦</span><span class="cr-text"><span class="cr-k">${chain.blockNumber ?? '—'}</span><span class="cr-s">Last Block</span></span></div>
      <div class="chain-row"><span class="cr-icon" aria-hidden="true">⌸</span><span class="cr-text"><span class="cr-k mono">${addr}</span><span class="cr-s">Contract Address</span></span></div>`;
  }

  async function load() {
    const certArea = document.getElementById('certArea');
    const historyArea = document.getElementById('historyArea');
    certArea.innerHTML = `<div class="panel-body">${B.loadingState('Loading certificates…')}</div>`;
    historyArea.innerHTML = B.loadingState('Loading verification activity…');

    let certificates = [];
    let stats = { total: 0, active: 0, revoked: 0 };
    let history = [];

    try {
      const res = await B.api('/api/students/me/certificates');
      certificates = res.data.certificates || [];
      stats = res.data.stats || stats;
      renderRecent(certificates);
    } catch (err) {
      document.getElementById('summaryBody').innerHTML = '';
      document.getElementById('summaryTotal').textContent = '—';
      certArea.innerHTML = `<div class="panel-body">${B.errorState('Could not load your certificates', err.message)}</div>`;
    }

    try {
      const res = await B.api('/api/students/me/history');
      history = res.data.history || [];
      renderHistory(history);
      renderActivityChart(history);
    } catch (err) {
      historyArea.innerHTML = B.errorState('History unavailable', err.message);
      document.getElementById('activityChart').innerHTML = '';
    }

    renderSummary(certificates, stats, history);

    try {
      const health = await fetch('/api/health').then((r) => r.json());
      const h = health && health.data ? health.data : null;
      renderAiCard(h);
      renderChainCard(h);
    } catch (_) {
      renderAiCard(null);
      renderChainCard(null);
    }
  }

  /* ---------------- AI resume maker ----------------
     Step 1: questionnaire (personal info, education, skills, projects,
     experience [skippable for freshers], certifications, career preferences).
     Step 2: build the resume from those answers + real platform
     certificates. Nothing is invented by AI; it can only polish wording. */

  const RESUME_SECTIONS = [
    { id: 'personal', title: '1. Personal Information', purpose: 'Creates the resume header and contact section.',
      fields: [
        ['fullName', 'Full name', 'text'], ['email', 'Email address', 'email'], ['mobile', 'Mobile number', 'text'],
        ['cityState', 'City and state', 'text'], ['linkedinUrl', 'LinkedIn profile URL', 'url'],
        ['portfolioUrl', 'GitHub or portfolio URL (optional)', 'url'],
      ] },
    { id: 'education', title: '2. Educational Details', purpose: 'Shows your academic qualifications. Platform-verified certificates are added automatically.',
      fields: [
        ['collegeName', 'College or university name', 'text'], ['degreeDept', 'Degree and department', 'text'],
        ['currentYearSem', 'Current year or semester', 'text'], ['graduationYear', 'Graduation year', 'text'],
        ['cgpa', 'CGPA or percentage', 'text'], ['school12', 'Previous school (12th) (optional)', 'text'],
        ['marks12', '12th marks / percentage (optional)', 'text'], ['school10', 'Previous school (10th) (optional)', 'text'],
        ['marks10', '10th marks / percentage (optional)', 'text'], ['coursework', 'Relevant coursework (optional, comma separated)', 'text'],
      ] },
    { id: 'skills', title: '3. Technical and Soft Skills', purpose: 'Helps the AI pick skills relevant to a job or internship.',
      fields: [
        ['technicalSkills', 'Programming languages, frameworks, databases (comma separated)', 'list'],
        ['tools', 'Tools and platforms (comma separated)', 'list'],
        ['softSkills', 'Soft skills (comma separated)', 'list'],
      ] },
    { id: 'projects', title: '4. Projects', purpose: 'Demonstrates practical knowledge — especially valuable without work experience.', repeat: true, itemLabel: 'Project',
      fields: [
        ['title', 'Project title', 'text'], ['description', 'Project description', 'textarea'],
        ['technologies', 'Technologies used', 'text'], ['role', 'Your role and contributions', 'textarea'],
        ['outcome', 'Outcome or measurable results', 'text'], ['link', 'GitHub or live project link', 'url'],
      ] },
    { id: 'experience', title: '5. Internship and Work Experience', purpose: 'Highlights practical experience. Freshers can skip this section.', repeat: true, itemLabel: 'Experience', skippable: true,
      fields: [
        ['organization', 'Company or organization', 'text'], ['jobTitle', 'Job title or internship role', 'text'],
        ['startDate', 'Start date (e.g. Jun 2025)', 'text'], ['endDate', 'End date (or "Present")', 'text'],
        ['responsibilities', 'Responsibilities', 'textarea'], ['achievements', 'Achievements and outcomes', 'textarea'],
      ] },
    { id: 'certifications', title: '6. Certifications and Achievements', purpose: 'Evidence of additional learning and accomplishments.', repeat: true, itemLabel: 'Certification',
      fields: [
        ['name', 'Certification / award name', 'text'], ['issuer', 'Issuing organization', 'text'],
        ['completionDate', 'Completion date', 'text'], ['verificationUrl', 'Verification URL (optional)', 'url'],
      ], extra: 'competitions', extraLabel: 'Hackathons & competitions', extraFields: [
        ['name', 'Competition / hackathon', 'text'], ['result', 'Result (e.g. 1st place, finalist)', 'text'], ['date', 'Date', 'text'],
      ], achievementsField: ['achievements', 'Awards, academic achievements and extracurricular activities (free text)'] },
    { id: 'career', title: '7. Career Preferences (AI tailoring)', purpose: 'Lets the AI tailor the resume to a specific opportunity.',
      fields: [
        ['targetRole', 'Target job title (AI: tailors the resume to the role)', 'text'],
        ['preferredIndustry', 'Preferred industry', 'text'],
        ['roleType', 'Internship or full-time role', 'select', ['Internship', 'Full-time', 'Either']],
        ['jobDescription', 'Job description (optional — AI: identifies relevant skills and keywords)', 'textarea'],
        ['resumeStyle', 'Preferred resume style', 'select', ['Classic', 'Modern', 'Compact']],
      ] },
  ];

  function fieldInput(name, label, type, options, value) {
    const v = value || '';
    if (type === 'textarea') {
      return `<textarea id="rq_${name}" rows="3" maxlength="2000" placeholder="${B.escapeHtml(label)}">${B.escapeHtml(v)}</textarea>`;
    }
    if (type === 'select') {
      return `<select id="rq_${name}">${['<option value=""></option>'].concat(options.map((o) => `<option value="${B.escapeHtml(o)}"${v === o ? ' selected' : ''}>${B.escapeHtml(o)}</option>`)).join('')}</select>`;
    }
    const inputType = type === 'list' ? 'text' : (type || 'text');
    return `<input type="${inputType}" id="rq_${name}" maxlength="300" value="${B.escapeHtml(v)}" placeholder="${B.escapeHtml(label)}" />`;
  }

  function fieldWrap(name, label, inner, hint) {
    return `<div class="rq-field"><label for="rq_${name}">${B.escapeHtml(label)}</label>${inner}${hint ? `<div class="small muted">${B.escapeHtml(hint)}</div>` : ''}</div>`;
  }

  function renderQuestionnaire(answers, aiConfigured) {
    const area = document.getElementById('resumeArea');
    const a = answers || {};
    const listVal = (v) => Array.isArray(v) ? v.join(', ') : (v || '');

    const sections = RESUME_SECTIONS.map((s) => {
      const fields = s.fields.map(([name, label, type, options]) => {
        const val = type === 'list' ? listVal(a[name]) : (a[name] || '');
        return fieldWrap(name, label, fieldInput(name, label, type, options, val));
      }).join('');

      let repeatHtml = '';
      if (s.repeat) {
        const items = Array.isArray(a[s.id]) && a[s.id].length ? a[s.id] : [{}];
        repeatHtml = items.map((item, idx) => `
          <div class="rq-item" data-section="${s.id}" data-idx="${idx}">
            <div class="rq-item-head"><strong>${B.escapeHtml(s.itemLabel)} ${idx + 1}</strong>${idx > 0 ? `<button type="button" class="btn btn-ghost btn-sm rq-remove" data-section="${s.id}" data-idx="${idx}">Remove</button>` : ''}</div>
            ${s.fields.map(([name, label, type, options]) => fieldWrap(name, label, fieldInput(name, label, type, options, item[name] || ''))).join('')}
          </div>`).join('');
        repeatHtml += `<button type="button" class="btn btn-outline btn-sm rq-add" data-section="${s.id}">+ Add another ${B.escapeHtml((s.itemLabel || 'entry').toLowerCase())}</button>`;
      }

      let extraHtml = '';
      if (s.extra) {
        const comps = Array.isArray(a[s.extra]) && a[s.extra].length ? a[s.extra] : [{}];
        extraHtml = `<h4 class="rq-sub">${B.escapeHtml(s.extraLabel)}</h4>` + comps.map((item, idx) => `
          <div class="rq-item" data-section="${s.extra}" data-idx="${idx}">
            <div class="rq-item-head"><strong>Entry ${idx + 1}</strong>${idx > 0 ? `<button type="button" class="btn btn-ghost btn-sm rq-remove" data-section="${s.extra}" data-idx="${idx}">Remove</button>` : ''}</div>
            ${s.extraFields.map(([name, label, type, options]) => fieldWrap(name, label, fieldInput(name, label, type, options, item[name] || ''))).join('')}
          </div>`).join('') + `<button type="button" class="btn btn-outline btn-sm rq-add" data-section="${s.extra}">+ Add another entry</button>`;
      }

      let achHtml = '';
      if (s.achievementsField) {
        const [name, label] = s.achievementsField;
        achHtml = fieldWrap(name, label, fieldInput(name, label, 'textarea', null, a[name] || ''));
      }

      const skipToggle = s.skippable ? `
        <div class="rq-fresher">
          <label><input type="checkbox" id="rq_isFresher"${a.isFresher === true || (a.isFresher === undefined && !(Array.isArray(a.experience) && a.experience.length)) ? ' checked' : ''} /> I am a fresher — skip work experience entirely</label>
        </div>` : '';

      return `
        <details class="rq-section" open>
          <summary>${B.escapeHtml(s.title)}<span class="small muted rq-purpose"> — ${B.escapeHtml(s.purpose)}</span></summary>
          <div class="rq-body">
            ${skipToggle}
            ${s.repeat ? repeatHtml : `<div class="rq-grid">${fields}</div>`}
            ${extraHtml}
            ${achHtml}
          </div>
        </details>`;
    }).join('');

    area.innerHTML = `
      <div class="rq-intro small muted">Fill in what applies to you — every field is optional and you decide what appears on the resume. Your answers are saved to your account. Certificates issued on BlockCert AI are added automatically and independently verifiable.</div>
      ${sections}
      <div class="btn-row mt-2">
        <button class="btn btn-primary" type="button" id="resumeSaveBtn">Save resume details</button>
        <button class="btn btn-outline" type="button" id="resumeSaveBuildBtn">Save &amp; build resume</button>
      </div>`;

    area.querySelectorAll('.rq-add').forEach((btn) => btn.addEventListener('click', () => {
      const section = btn.getAttribute('data-section');
      const items = area.querySelectorAll(`.rq-item[data-section="${section}"]`);
      const template = items[0];
      const clone = template.cloneNode(true);
      clone.setAttribute('data-idx', String(items.length));
      clone.querySelectorAll('input,textarea,select').forEach((el) => { if (el.type !== 'checkbox') el.value = ''; });
      const head = clone.querySelector('.rq-item-head strong');
      if (head) head.textContent = (RESUME_SECTIONS.find((s) => s.id === section || s.extra === section) || {}).itemLabel ? `Entry ${items.length + 1}` : `Entry ${items.length + 1}`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-ghost btn-sm rq-remove';
      removeBtn.setAttribute('data-section', section);
      removeBtn.setAttribute('data-idx', String(items.length));
      removeBtn.textContent = 'Remove';
      clone.querySelector('.rq-item-head').appendChild(removeBtn);
      btn.before(clone);
      bindRepeatButtons(area);
    }));

    function bindRepeatButtons(root) {
      root.querySelectorAll('.rq-remove').forEach((btn) => {
        btn.onclick = () => btn.closest('.rq-item').remove();
      });
    }
    bindRepeatButtons(area);

    document.getElementById('resumeSaveBtn').addEventListener('click', () => saveQuestionnaire(false));
    document.getElementById('resumeSaveBuildBtn').addEventListener('click', () => saveQuestionnaire(true));
  }

  function collectQuestionnaire() {
    const val = (id) => { const el = document.getElementById('rq_' + id); return el ? el.value.trim() : ''; };
    const answers = {};

    for (const s of RESUME_SECTIONS) {
      if (s.repeat || s.extra) {
        // repeated sections are read per-item below
      } else {
        for (const [name, , type] of s.fields) {
          if (type === 'list') {
            const items = val(name).split(',').map((x) => x.trim()).filter(Boolean);
            if (items.length) answers[name] = items;
          } else if (val(name)) {
            answers[name] = val(name);
          }
        }
      }
      if (s.extra) {
        const comps = [];
        document.querySelectorAll(`.rq-item[data-section="${s.extra}"]`).forEach((item) => {
          const o = {};
          s.extraFields.forEach(([name]) => { const el = item.querySelector('#rq_' + name) || item.querySelector('[id="rq_' + name + '"]'); if (el && el.value.trim()) o[name] = el.value.trim(); });
          if (Object.keys(o).length) comps.push(o);
        });
        if (comps.length) answers[s.extra] = comps;
      }
      if (s.achievementsField && val(s.achievementsField[0])) answers[s.achievementsField[0]] = val(s.achievementsField[0]);
    }

    // repeated sections: projects, experience, certifications
    for (const sectionId of ['projects', 'experience', 'certifications']) {
      const s = RESUME_SECTIONS.find((x) => x.id === sectionId);
      const items = [];
      document.querySelectorAll(`.rq-item[data-section="${sectionId}"]`).forEach((item) => {
        const o = {};
        s.fields.forEach(([name]) => {
          const el = item.querySelector('[id="rq_' + name + '"]');
          if (el && el.value.trim()) o[name] = el.value.trim();
        });
        if (Object.keys(o).length) items.push(o);
      });
      if (items.length) answers[sectionId] = items;
    }

    const fresherCb = document.getElementById('rq_isFresher');
    answers.isFresher = fresherCb ? fresherCb.checked : false;
    return answers;
  }

  async function saveQuestionnaire(buildAfter) {
    const saveBtn = document.getElementById('resumeSaveBtn');
    const saveBuildBtn = document.getElementById('resumeSaveBuildBtn');
    const busyBtn = buildAfter ? saveBuildBtn : saveBtn;
    B.setButtonBusy(busyBtn, true, 'Saving…');
    try {
      await B.api('/api/students/me/resume-profile', { method: 'PUT', body: { answers: collectQuestionnaire() } });
      B.toast('Resume details saved.', 'success');
      if (buildAfter) await loadResume();
    } catch (err) {
      B.showAlert('Could not save resume details: ' + err.message, 'error');
    } finally {
      B.setButtonBusy(busyBtn, false);
    }
  }

  async function editQuestionnaire() {
    const btn = document.getElementById('resumeEditBtn');
    if (btn) B.setButtonBusy(btn, true, 'Loading…');
    try {
      const res = await B.api('/api/students/me/resume-profile');
      renderQuestionnaire(res.data.answers, res.data.aiConfigured);
    } catch (err) {
      document.getElementById('resumeArea').innerHTML = B.errorState('Could not load your resume details', err.message);
    } finally {
      if (btn) B.setButtonBusy(btn, false);
    }
  }

  function renderResumeEmpty(emptyState, ai) {
    const area = document.getElementById('resumeArea');
    area.innerHTML = B.emptyState('No resume can be built yet', emptyState, '✦');
    document.getElementById('resumeGenerateBtn').disabled = false;
  }

  function badgeLine(text) {
    return `<span class="badge badge-neutral"><span aria-hidden="true">⛓</span> ${B.escapeHtml(text)}</span>`;
  }

  function resumeToPlainText(resume) {
    const lines = [];
    lines.push(resume.holderName);
    const contact = [resume.email, resume.mobile, resume.cityState, resume.linkedinUrl, resume.portfolioUrl].filter(Boolean).join(' | ');
    if (contact) lines.push(contact);
    if (resume.registrationNumber) lines.push('Register number: ' + resume.registrationNumber);
    lines.push('');
    if (resume.summary) { lines.push('SUMMARY'); lines.push(resume.summary); lines.push(''); }
    const sk = resume.skills || {};
    if ((sk.technical || []).length || (sk.tools || []).length || (sk.soft || []).length) {
      lines.push('SKILLS');
      if ((sk.technical || []).length) lines.push('Technical: ' + sk.technical.join(', '));
      if ((sk.tools || []).length) lines.push('Tools & platforms: ' + sk.tools.join(', '));
      if ((sk.soft || []).length) lines.push('Soft skills: ' + sk.soft.join(', '));
      lines.push('');
    }
    const se = resume.selfEducationDetails || {};
    if (resume.selfEducation || (resume.education || []).length) {
      lines.push('EDUCATION');
      if (se.collegeName) lines.push('- ' + se.collegeName + (se.degreeDept ? ', ' + se.degreeDept : '') + (se.graduationYear ? ' (graduating ' + se.graduationYear + ')' : '') + (se.cgpa ? ' — CGPA/%% ' + se.cgpa : ''));
      if (se.school12) lines.push('- ' + se.school12 + ' (12th' + (se.marks12 ? ': ' + se.marks12 : '') + ')');
      if (se.school10) lines.push('- ' + se.school10 + ' (10th' + (se.marks10 ? ': ' + se.marks10 : '') + ')');
      if (se.coursework) lines.push('- Coursework: ' + se.coursework);
      for (const e of resume.education || []) {
        lines.push('- ' + e.credential + (e.semester ? ' (Semester ' + e.semester + ')' : '') + ' — ' + e.institution + (e.department ? ', ' + e.department : '') + (e.academicYear ? ' | AY ' + e.academicYear : '') + (e.marks ? ' | Marks: ' + e.marks : '') + ' | ' + e.badge + ' | Verify: ' + e.verificationUrl);
      }
      lines.push('');
    }
    if ((resume.projects || []).length) {
      lines.push('PROJECTS');
      for (const p of resume.projects) {
        lines.push('- ' + (p.title || 'Untitled project') + (p.technologies ? ' [' + p.technologies + ']' : ''));
        if (p.description) lines.push('  ' + p.description);
        if (p.role) lines.push('  Role: ' + p.role);
        if (p.outcome) lines.push('  Outcome: ' + p.outcome);
        if (p.link) lines.push('  Link: ' + p.link);
      }
      lines.push('');
    }
    if ((resume.experience || []).length) {
      lines.push('INTERNSHIP & WORK EXPERIENCE');
      for (const x of resume.experience) {
        lines.push('- ' + (x.jobTitle || 'Role') + (x.organization ? ', ' + x.organization : '') + (x.startDate || x.endDate ? ' (' + [x.startDate, x.endDate].filter(Boolean).join(' - ') + ')' : ''));
        if (x.responsibilities) lines.push('  ' + x.responsibilities);
        if (x.achievements) lines.push('  Achievements: ' + x.achievements);
      }
      lines.push('');
    } else if (resume.isFresher) {
      lines.push('FRESHER — no work experience section.');
      lines.push('');
    }
    if ((resume.certifications || []).length || (resume.competitions || []).length || resume.achievements) {
      lines.push('CERTIFICATIONS & ACHIEVEMENTS');
      for (const c of resume.certifications || []) lines.push('- ' + (c.name || 'Certification') + (c.issuer ? ' — ' + c.issuer : '') + (c.completionDate ? ' (' + c.completionDate + ')' : '') + (c.verificationUrl ? ' | Verify: ' + c.verificationUrl : ''));
      for (const c of resume.competitions || []) lines.push('- ' + c.name + (c.result ? ' — ' + c.result : '') + (c.date ? ' (' + c.date + ')' : ''));
      if (resume.achievements) lines.push('- ' + resume.achievements);
      lines.push('');
    }
    const cp = resume.careerPreferences;
    if (cp) {
      lines.push('CAREER PREFERENCES');
      const bits = [cp.targetRole && 'Target role: ' + cp.targetRole, cp.preferredIndustry && 'Industry: ' + cp.preferredIndustry, cp.roleType, cp.resumeStyle && 'Style: ' + cp.resumeStyle].filter(Boolean);
      if (bits.length) lines.push(bits.join(' | '));
      if (cp.jobDescription) lines.push('Job description: ' + cp.jobDescription);
      lines.push('');
    }
    lines.push('Generated by BlockCert AI on ' + resume.generatedAt + '. Contact, skills, projects, experience, certifications and preferences are self-reported; certificate entries come from real platform records, independently verifiable at each verification URL.');
    return lines.filter((l) => l !== '').join('\n');
  }

  function buildPrintHtml(resume) {
    const contact = [resume.email, resume.mobile, resume.cityState, resume.linkedinUrl, resume.portfolioUrl].filter(Boolean).map(B.escapeHtml).join(' &middot; ');
    const esc = B.escapeHtml;
    return `<!DOCTYPE html><html><head><title>Resume — ${esc(resume.holderName)}</title><style>
        body{font-family:Georgia,'Times New Roman',serif;max-width:720px;margin:32px auto;padding:0 24px;color:#111;line-height:1.5}
        h1{margin:0 0 2px;font-size:26px} h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #999;padding-bottom:4px;margin:22px 0 8px}
        .muted{color:#555;font-size:12px} .edu{margin:10px 0} .edu b{font-size:15px} .badge{display:inline-block;font-size:11px;border:1px solid #999;border-radius:10px;padding:1px 8px;margin-top:4px}
        p{margin:6px 0}
      </style></head><body>
        <h1>${esc(resume.holderName)}</h1>
        ${contact ? `<div class="muted">${contact}</div>` : ''}
        ${resume.registrationNumber ? `<div class="muted">Register number: ${esc(resume.registrationNumber)}</div>` : ''}
        ${resume.summary ? `<h2>Summary</h2><p>${esc(resume.summary)}</p>` : ''}
        ${(resume.skills || {}).technical || (resume.skills || {}).tools || (resume.skills || {}).soft ? `<h2>Skills</h2><p><b>Technical:</b> ${esc((resume.skills.technical || []).join(', '))}<br/><b>Tools &amp; platforms:</b> ${esc((resume.skills.tools || []).join(', '))}<br/><b>Soft skills:</b> ${esc((resume.skills.soft || []).join(', '))}</p>` : ''}
        <h2>Education</h2>
        ${(() => { const se = resume.selfEducationDetails || {}; return [
          se.collegeName ? `<div class="edu"><b>${esc(se.collegeName)}</b>${se.degreeDept ? '<br/>' + esc(se.degreeDept) : ''}<br/><span class="muted">${[se.currentYearSem && 'Current: ' + esc(se.currentYearSem), se.graduationYear && 'Graduating ' + esc(se.graduationYear), se.cgpa && 'CGPA/%%: ' + esc(se.cgpa)].filter(Boolean).join(' &middot; ')}</span></div>` : '',
          se.school12 ? `<div class="edu"><b>${esc(se.school12)}</b> (12th${se.marks12 ? ': ' + esc(se.marks12) : ''})</div>` : '',
          se.school10 ? `<div class="edu"><b>${esc(se.school10)}</b> (10th${se.marks10 ? ': ' + esc(se.marks10) : ''})</div>` : '',
          se.coursework ? `<p class="muted">Coursework: ${esc(se.coursework)}</p>` : '',
        ].filter(Boolean).join(''); })()}
        ${(resume.education || []).map((e) => `<div class="edu"><b>${esc(e.credential)}${e.semester ? ' — Semester ' + e.semester : ''}</b><br/>${esc(e.institution)}${e.department ? ' — ' + esc(e.department) : ''}<br/><span class="muted">${e.academicYear ? 'Academic year ' + esc(String(e.academicYear)) + ' · ' : ''}${e.marks ? 'Marks: ' + esc(String(e.marks)) + ' · ' : ''}${esc(e.certificateType)} · ${B.fmtDate(e.issueDate)}</span><br/><span class="badge">${esc(e.badge)}</span><br/><span class="muted">Verify: ${esc(e.verificationUrl)}</span></div>`).join('')}
        ${(resume.projects || []).length ? `<h2>Projects</h2>${resume.projects.map((p) => `<div class="edu"><b>${esc(p.title || 'Untitled project')}</b>${p.technologies ? ' <span class="muted">[' + esc(p.technologies) + ']</span>' : ''}<br/>${p.description ? esc(p.description) + '<br/>' : ''}${p.role ? '<span class="muted">Role: ' + esc(p.role) + '</span><br/>' : ''}${p.outcome ? '<span class="muted">Outcome: ' + esc(p.outcome) + '</span><br/>' : ''}${p.link ? '<span class="muted">Link: ' + esc(p.link) + '</span>' : ''}</div>`).join('')}` : ''}
        ${(resume.experience || []).length ? `<h2>Internship &amp; Work Experience</h2>${resume.experience.map((x) => `<div class="edu"><b>${esc(x.jobTitle || 'Role')}</b>${x.organization ? ', ' + esc(x.organization) : ''}${x.startDate || x.endDate ? ' <span class="muted">(' + esc([x.startDate, x.endDate].filter(Boolean).join(' - ')) + ')</span>' : ''}<br/>${x.responsibilities ? esc(x.responsibilities) + '<br/>' : ''}${x.achievements ? '<span class="muted">Achievements: ' + esc(x.achievements) + '</span>' : ''}</div>`).join('')}` : (resume.isFresher ? '<p class="muted">Fresher — no work experience.</p>' : '')}
        ${(resume.certifications || []).length || (resume.competitions || []).length || resume.achievements ? `<h2>Certifications &amp; Achievements</h2>${(resume.certifications || []).map((c) => `<div class="edu"><b>${esc(c.name || 'Certification')}</b>${c.issuer ? ' — ' + esc(c.issuer) : ''}${c.completionDate ? ' <span class="muted">(' + esc(c.completionDate) + ')</span>' : ''}${c.verificationUrl ? '<br/><span class="muted">Verify: ' + esc(c.verificationUrl) + '</span>' : ''}</div>`).join('')}${(resume.competitions || []).map((c) => `<div class="edu"><b>${esc(c.name)}</b>${c.result ? ' — ' + esc(c.result) : ''}${c.date ? ' <span class="muted">(' + esc(c.date) + ')</span>' : ''}</div>`).join('')}${resume.achievements ? '<p>' + esc(resume.achievements) + '</p>' : ''}` : ''}
        ${resume.careerPreferences ? `<h2>Career Preferences</h2><p>${[resume.careerPreferences.targetRole && 'Target role: ' + esc(resume.careerPreferences.targetRole), resume.careerPreferences.preferredIndustry && 'Industry: ' + esc(resume.careerPreferences.preferredIndustry), resume.careerPreferences.roleType && esc(resume.careerPreferences.roleType), resume.careerPreferences.resumeStyle && 'Style: ' + esc(resume.careerPreferences.resumeStyle)].filter(Boolean).join(' &middot; ')}${resume.careerPreferences.jobDescription ? '<br/><span class="muted">Job description provided.</span>' : ''}</p>` : ''}
        <p class="muted">Generated by BlockCert AI on ${B.fmtDateTime(resume.generatedAt)}. Contact, skills, projects, experience, certifications and preferences are self-reported; certificate entries come from real platform records, independently verifiable at each verification URL.</p>
      </body></html>`;
  }

  function renderResume(resume, ai) {
    const area = document.getElementById('resumeArea');

    const contactBits = [
      resume.email ? B.escapeHtml(resume.email) : '',
      resume.mobile ? B.escapeHtml(resume.mobile) : '',
      resume.cityState ? B.escapeHtml(resume.cityState) : '',
      resume.linkedinUrl ? `<a href="${B.escapeHtml(resume.linkedinUrl)}" target="_blank" rel="noopener">LinkedIn</a>` : '',
      resume.portfolioUrl ? `<a href="${B.escapeHtml(resume.portfolioUrl)}" target="_blank" rel="noopener">Portfolio</a>` : '',
      resume.registrationNumber ? `Reg. <span class="mono">${B.escapeHtml(resume.registrationNumber)}</span>` : '',
    ].filter(Boolean);

    const header = `
      <div class="resume-head">
        <div>
          <div class="rh-name">${B.escapeHtml(resume.holderName)}</div>
          ${contactBits.length ? `<div class="rh-contact small">${contactBits.join(' <span class="muted">·</span> ')}</div>` : ''}
        </div>
        <div class="small muted">Generated ${B.fmtDateTime(resume.generatedAt)}</div>
      </div>`;

    const summaryBlock = resume.summary
      ? `<div class="resume-summary"><h3>Professional summary</h3><p id="resumeSummaryText">${B.escapeHtml(resume.summary)}</p></div>`
      : '';

    // Self-reported education (questionnaire) — shown alongside platform certs.
    const se = resume.selfEducationDetails || {};
    const selfEduLines = [
      se.collegeName ? B.escapeHtml(se.collegeName) : '',
      se.degreeDept ? B.escapeHtml(se.degreeDept) : '',
      [se.currentYearSem ? `Current: ${B.escapeHtml(se.currentYearSem)}` : '', se.graduationYear ? `Graduating ${B.escapeHtml(se.graduationYear)}` : ''].filter(Boolean).join(' · '),
      se.cgpa ? `CGPA/%%: <span class="mono">${B.escapeHtml(se.cgpa)}</span>` : '',
      se.school12 ? `${B.escapeHtml(se.school12)} (12th${se.marks12 ? ': ' + B.escapeHtml(se.marks12) : ''})` : '',
      se.school10 ? `${B.escapeHtml(se.school10)} (10th${se.marks10 ? ': ' + B.escapeHtml(se.marks10) : ''})` : '',
      se.coursework ? `Coursework: ${B.escapeHtml(se.coursework)}` : '',
    ].filter(Boolean);

    const platformRows = (resume.education || []).map((e) => `
      <div class="resume-edu">
        <div class="re-main">
          <div class="re-cred">${B.escapeHtml(e.credential)}${e.semester ? ` <span class="muted">· Semester ${e.semester}</span>` : ''}</div>
          <div class="re-inst">${B.escapeHtml(e.institution)}${e.department ? ` — ${B.escapeHtml(e.department)}` : ''}</div>
          <div class="small muted re-meta">
            ${e.academicYear ? `Academic year ${B.escapeHtml(String(e.academicYear))} · ` : ''}${e.marks ? `Marks: <span class="mono">${B.escapeHtml(String(e.marks))}</span> · ` : ''}${B.escapeHtml(e.certificateType)} · ${B.fmtDate(e.issueDate)}
          </div>
        </div>
        <div class="re-side">
          ${badgeLine(e.badge)}
          <a class="small" href="${B.escapeHtml(e.verificationUrl)}" target="_blank" rel="noopener">Verify →</a>
        </div>
      </div>`).join('');

    const educationBlock = (selfEduLines.length || platformRows)
      ? `<div class="resume-edu-block"><h3>Education</h3>
          ${selfEduLines.length ? `<div class="resume-edu"><div class="re-main">${selfEduLines.map((l) => `<div>${l}</div>`).join('')}</div><div class="re-side small muted"> Self-reported</div></div>` : ''}
          ${platformRows ? `<h4 class="rq-sub">Platform-verified certificates</h4>${platformRows}` : ''}
        </div>`
      : '';

    const sk = resume.skills || {};
    const skillChips = (items) => (items || []).map((s) => `<span class="rq-chip">${B.escapeHtml(s)}</span>`).join(' ');
    const skillsBlock = (sk.technical && sk.technical.length) || (sk.tools && sk.tools.length) || (sk.soft && sk.soft.length)
      ? `<div class="resume-edu-block"><h3>Skills</h3>
          ${sk.technical && sk.technical.length ? `<div class="rq-skill-row"><span class="rq-skill-label">Technical:</span>${skillChips(sk.technical)}</div>` : ''}
          ${sk.tools && sk.tools.length ? `<div class="rq-skill-row"><span class="rq-skill-label">Tools &amp; platforms:</span>${skillChips(sk.tools)}</div>` : ''}
          ${sk.soft && sk.soft.length ? `<div class="rq-skill-row"><span class="rq-skill-label">Soft skills:</span>${skillChips(sk.soft)}</div>` : ''}
        </div>`
      : '';

    const projectBlock = (resume.projects || []).length
      ? `<div class="resume-edu-block"><h3>Projects</h3>${resume.projects.map((p) => `
          <div class="resume-edu"><div class="re-main">
            <div class="re-cred">${B.escapeHtml(p.title || 'Untitled project')}</div>
            ${p.description ? `<div class="re-inst">${B.escapeHtml(p.description)}</div>` : ''}
            <div class="small muted re-meta">
              ${p.technologies ? `Tech: ${B.escapeHtml(p.technologies)} · ` : ''}${p.role ? `Role: ${B.escapeHtml(p.role)} · ` : ''}${p.outcome ? `Outcome: ${B.escapeHtml(p.outcome)}` : ''}
            </div>
            ${p.link ? `<a class="small" href="${B.escapeHtml(p.link)}" target="_blank" rel="noopener">View project →</a>` : ''}
          </div></div>`).join('')}</div>`
      : '';

    const experienceBlock = (resume.experience || []).length
      ? `<div class="resume-edu-block"><h3>Internship &amp; Work Experience</h3>${resume.experience.map((x) => `
          <div class="resume-edu"><div class="re-main">
            <div class="re-cred">${B.escapeHtml(x.jobTitle || 'Role')}${x.organization ? ` <span class="muted">· ${B.escapeHtml(x.organization)}</span>` : ''}</div>
            <div class="small muted re-meta">${[x.startDate, x.endDate].filter(Boolean).map(B.escapeHtml).join(' — ')}</div>
            ${x.responsibilities ? `<div class="re-inst">${B.escapeHtml(x.responsibilities)}</div>` : ''}
            ${x.achievements ? `<div class="small">Achievements: ${B.escapeHtml(x.achievements)}</div>` : ''}
          </div></div>`).join('')}</div>`
      : (resume.isFresher ? '<p class="small muted mb-0">Fresher — no work experience section included.</p>' : '');

    const certBlock = (resume.certifications || []).length || (resume.competitions || []).length || resume.achievements
      ? `<div class="resume-edu-block"><h3>Certifications &amp; Achievements</h3>
          ${(resume.certifications || []).map((c) => `
            <div class="resume-edu"><div class="re-main">
              <div class="re-cred">${B.escapeHtml(c.name || 'Certification')}</div>
              <div class="small muted re-meta">${[c.issuer, c.completionDate].filter(Boolean).map(B.escapeHtml).join(' · ')}</div>
              ${c.verificationUrl ? `<a class="small" href="${B.escapeHtml(c.verificationUrl)}" target="_blank" rel="noopener">Verify certificate →</a>` : ''}
            </div></div>`).join('')}
          ${(resume.competitions || []).map((c) => `
            <div class="resume-edu"><div class="re-main">
              <div class="re-cred">${B.escapeHtml(c.name)}</div>
              <div class="small muted re-meta">${[c.result, c.date].filter(Boolean).map(B.escapeHtml).join(' · ')}</div>
            </div></div>`).join('')}
          ${resume.achievements ? `<div class="re-inst">${B.escapeHtml(resume.achievements)}</div>` : ''}
        </div>`
      : '';

    const cp = resume.careerPreferences;
    const careerBlock = cp
      ? `<div class="resume-edu-block"><h3>Career preferences (shared with the AI for tailoring)</h3>
          <div class="small">${[
            cp.targetRole ? `Target role: <b>${B.escapeHtml(cp.targetRole)}</b>` : '',
            cp.preferredIndustry ? `Industry: ${B.escapeHtml(cp.preferredIndustry)}` : '',
            cp.roleType ? `${B.escapeHtml(cp.roleType)}` : '',
            cp.resumeStyle ? `Style: ${B.escapeHtml(cp.resumeStyle)}` : '',
          ].filter(Boolean).map(B.escapeHtml).join(' · ')}</div>
          ${cp.jobDescription ? `<details class="tech"><summary>Job description provided</summary><div class="tech-body small">${B.escapeHtml(cp.jobDescription)}</div></details>` : ''}
        </div>`
      : '';

    const aiHint = ai && ai.configured
      ? '<p class="small muted mb-0">Optional: let the AI provider rephrase the professional summary using exactly the facts above — it never adds skills, experience or grades.</p>'
      : '<p class="small muted mb-0">AI polish is currently unavailable on this server (no AI API key configured). The summary above is written directly from your details and certificate records.</p>';

    const actions = `
      <div class="btn-row mt-2">
        ${resume.summary && ai && ai.configured ? '<button class="btn btn-outline btn-sm" type="button" id="resumeAiBtn">Polish summary with AI</button>' : ''}
        <button class="btn btn-outline btn-sm" type="button" id="resumePrintBtn">Print / Save PDF</button>
        <button class="btn btn-outline btn-sm" type="button" id="resumeCopyBtn">Copy as text</button>
      </div>`;

    area.innerHTML = header + summaryBlock + skillsBlock + educationBlock + projectBlock + experienceBlock + certBlock + careerBlock + aiHint + actions;

    const printBtn = document.getElementById('resumePrintBtn');
    if (printBtn) printBtn.addEventListener('click', () => {
      const w = window.open('', '_blank', 'width=800,height=900');
      if (!w) { B.toast('Popup blocked — allow popups to print the resume.', 'warn'); return; }
      w.document.write(buildPrintHtml(resume));
      w.document.close();
      w.focus();
      w.print();
    });

    const copyBtn = document.getElementById('resumeCopyBtn');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(resumeToPlainText(resume));
        B.toast('Resume copied as plain text.', 'success');
      } catch (_) {
        B.toast('Clipboard unavailable in this browser.', 'warn');
      }
    });

    const aiBtn = document.getElementById('resumeAiBtn');
    if (aiBtn) aiBtn.addEventListener('click', async () => {
      B.setButtonBusy(aiBtn, true, 'Asking AI…');
      try {
        const res = await B.api('/api/ai/resume-summary', { method: 'POST' });
        const text = document.getElementById('resumeSummaryText');
        if (text) text.textContent = res.data.summary;
        B.toast('Summary polished with AI from your verified facts.', 'success');
      } catch (err) {
        if (err.data && err.data.fallbackSummary) {
          const text = document.getElementById('resumeSummaryText');
          if (text) text.textContent = err.data.fallbackSummary;
        }
        B.toast(err.message, 'warn');
      } finally {
        B.setButtonBusy(aiBtn, false);
      }
    });
  }

  async function loadResume() {
    const btn = document.getElementById('resumeGenerateBtn');
    if (!btn) return;
    B.setButtonBusy(btn, true, 'Building…');
    try {
      const res = await B.api('/api/students/me/resume');
      if (!res.data.resume) {
        renderResumeEmpty(res.data.emptyState, res.data.ai);
        return;
      }
      renderResume(res.data.resume, res.data.ai);
    } catch (err) {
      document.getElementById('resumeArea').innerHTML = B.errorState('Could not build the resume', err.message);
    } finally {
      B.setButtonBusy(btn, false);
    }
  }

  const resumeBtn = document.getElementById('resumeGenerateBtn');
  if (resumeBtn) resumeBtn.addEventListener('click', loadResume);
  const resumeEditBtn = document.getElementById('resumeEditBtn');
  if (resumeEditBtn) resumeEditBtn.addEventListener('click', editQuestionnaire);

  document.getElementById('refreshBtn').addEventListener('click', load);
  document.addEventListener('DOMContentLoaded', load);
})();
