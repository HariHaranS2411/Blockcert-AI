/* ============================================================
   BlockCert AI - landing + static page behaviour.
   Loads live counts from the API; when the database is
   unavailable the counts block is hidden entirely (no fakes).
   ============================================================ */
(function () {
  'use strict';
  const B = window.BlockCert;

  async function loadLiveCounts() {
    const healthEl = document.getElementById('landingHealth');
    try {
      const res = await B.api('/api/dashboard/public');
      const { counts, health } = res.data;

      if (healthEl) {
        const parts = [];
        parts.push('Database: ' + (health.database.connected ? 'connected' : 'unavailable'));
        parts.push('Blockchain: ' + (health.blockchain.connected ? (health.blockchain.configured ? 'connected' : 'no contract') : 'unavailable'));
        parts.push('AI: ' + (health.ai.configured ? 'configured' : 'unavailable'));
        healthEl.textContent = parts.join(' · ');
      }

      const section = document.getElementById('liveCountsSection');
      const target = document.getElementById('liveCounts');
      if (!section || !target) return;
      if (!counts) {
        section.hidden = true;
        return;
      }
      const items = [
        { label: 'Certificates registered', value: counts.certificates },
        { label: 'Approved institutions', value: counts.institutions },
        { label: 'Verifications performed', value: counts.verifications },
        { label: 'Verified results', value: counts.verified },
      ];
      target.innerHTML = items
        .map(
          (i) => `<div class="stat info"><div class="label">${B.escapeHtml(i.label)}</div><div class="value">${i.value}</div></div>`
        )
        .join('');
      section.hidden = false;
    } catch (err) {
      if (healthEl) healthEl.textContent = 'Live statistics unavailable: ' + err.message;
      const section = document.getElementById('liveCountsSection');
      if (section) section.hidden = true;
    }
  }

  document.addEventListener('DOMContentLoaded', loadLiveCounts);
})();
