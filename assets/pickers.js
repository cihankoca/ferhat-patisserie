/* ═══════════════════════════════════════════
   FERHAT PATISSERIE — desktop pickers
   Progressive enhancement for the request form: native <select> and
   <input type="date"> stay in the DOM (submission, validation and the
   `change` listeners in form.js are untouched); on pointer devices wider
   than 768 px a styled button + popover is drawn in front of them.
   Phones keep the OS pickers, which are the better UX there.
   ═══════════════════════════════════════════ */
(function () {
  'use strict';
  const form = document.getElementById('talepForm');
  if (!form) return;
  const enhance = window.matchMedia('(min-width: 769px) and (pointer: fine)').matches;
  if (!enhance) return;

  const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  const DAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
  const DAYS_LONG = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  const CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';

  let openPicker = null;
  function closeAll() { if (openPicker) { openPicker.close(); openPicker = null; } }
  document.addEventListener('pointerdown', e => { if (openPicker && !openPicker.root.contains(e.target)) closeAll(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && openPicker) { const p = openPicker; closeAll(); p.btn.focus(); } });

  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseIso(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function fmtLong(s) { const d = parseIso(s); return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${DAYS_LONG[d.getDay()]}` : ''; }

  // ── <select> → button + listbox ──
  function enhanceSelect(sel) {
    const root = document.createElement('div'); root.className = 'picker picker--select';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'picker-btn';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    if (sel.id) btn.setAttribute('aria-labelledby', labelIdFor(sel));
    const txt = document.createElement('span'); txt.className = 'picker-value';
    btn.append(txt); btn.insertAdjacentHTML('beforeend', CHEVRON);
    const menu = document.createElement('div'); menu.className = 'picker-menu'; menu.setAttribute('role', 'listbox'); menu.hidden = true;
    const items = [];
    Array.from(sel.options).forEach(opt => {
      if (opt.value === '') return; // placeholder
      const it = document.createElement('div'); it.className = 'picker-item'; it.setAttribute('role', 'option'); it.dataset.value = opt.value; it.tabIndex = -1;
      it.innerHTML = `<span>${escapeHtml(opt.textContent)}</span>${CHECK}`;
      it.addEventListener('click', () => { choose(opt.value); btn.focus(); });
      menu.append(it); items.push(it);
    });
    sel.classList.add('picker-native'); sel.tabIndex = -1;
    sel.parentNode.insertBefore(root, sel); root.append(btn, menu, sel);

    function sync() {
      const o = sel.options[sel.selectedIndex];
      const empty = !sel.value;
      txt.textContent = empty ? (sel.options[0] && sel.options[0].value === '' ? sel.options[0].textContent : 'Seçin…') : o.textContent;
      btn.classList.toggle('is-placeholder', empty);
      items.forEach(it => it.setAttribute('aria-selected', it.dataset.value === sel.value ? 'true' : 'false'));
    }
    function choose(v) { if (sel.value !== v) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); } sync(); close(); }
    function open() { closeAll(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); root.classList.add('is-open'); openPicker = api; const cur = items.find(it => it.dataset.value === sel.value) || items[0]; if (cur) cur.focus(); }
    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); root.classList.remove('is-open'); if (openPicker === api) openPicker = null; }
    const api = { root, btn, close };
    btn.addEventListener('click', () => menu.hidden ? open() : close());
    btn.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
    menu.addEventListener('keydown', e => {
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (i >= 0) { choose(items[i].dataset.value); btn.focus(); } }
      else if (e.key === 'Tab') { close(); }
    });
    sel.addEventListener('change', sync);
    sel.addEventListener('focus', () => btn.focus()); // form.js focuses the native control on error
    sync();
  }

  // ── <input type="date"> → button + calendar ──
  function enhanceDate(input) {
    const root = document.createElement('div'); root.className = 'picker picker--date';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'picker-btn';
    btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
    if (input.id) btn.setAttribute('aria-labelledby', labelIdFor(input));
    const txt = document.createElement('span'); txt.className = 'picker-value';
    btn.append(txt); btn.insertAdjacentHTML('beforeend', CAL);
    const pop = document.createElement('div'); pop.className = 'picker-menu picker-cal'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Takvim'); pop.hidden = true;
    input.classList.add('picker-native'); input.tabIndex = -1;
    input.parentNode.insertBefore(root, input); root.append(btn, pop, input);

    let view = null; // first day of the month shown
    function bounds() { return { min: parseIso(input.min), max: parseIso(input.max) }; }
    function inRange(d) { const b = bounds(); return (!b.min || d >= b.min) && (!b.max || d <= b.max); }
    function render() {
      const b = bounds(); const cur = parseIso(input.value); const today = new Date(); today.setHours(0, 0, 0, 0);
      const y = view.getFullYear(), m = view.getMonth();
      const first = new Date(y, m, 1); const startOffset = (first.getDay() + 6) % 7; // Monday-first
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const prevOk = !b.min || new Date(y, m, 0) >= new Date(b.min.getFullYear(), b.min.getMonth(), 1);
      const nextOk = !b.max || new Date(y, m + 1, 1) <= b.max;
      let html = `<div class="cal-head"><button type="button" class="cal-nav" data-nav="-1" aria-label="Önceki ay" ${prevOk ? '' : 'disabled'}>‹</button><div class="cal-title">${MONTHS[m]} ${y}</div><button type="button" class="cal-nav" data-nav="1" aria-label="Sonraki ay" ${nextOk ? '' : 'disabled'}>›</button></div>`;
      html += '<div class="cal-grid" role="grid">' + DAYS.map(d => `<div class="cal-dow">${d}</div>`).join('');
      for (let i = 0; i < startOffset; i++) html += '<div class="cal-pad"></div>';
      for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(y, m, d); const v = iso(date); const ok = inRange(date);
        const cls = ['cal-day', ok ? '' : 'is-off', cur && iso(cur) === v ? 'is-selected' : '', iso(today) === v ? 'is-today' : ''].filter(Boolean).join(' ');
        html += `<button type="button" class="${cls}" data-v="${v}" ${ok ? '' : 'disabled'} tabindex="-1" aria-label="${d} ${MONTHS[m]} ${y}, ${DAYS_LONG[date.getDay()]}">${d}</button>`;
      }
      html += '</div><div class="cal-foot">En erken yarın, en geç 6 ay sonrası için talep alıyoruz.</div>';
      pop.innerHTML = html;
    }
    function sync() { txt.textContent = input.value ? fmtLong(input.value) : 'Tarih seçin'; btn.classList.toggle('is-placeholder', !input.value); }
    function choose(v) { if (input.value !== v) { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); } sync(); close(); btn.focus(); }
    function open() {
      closeAll(); const cur = parseIso(input.value) || bounds().min || new Date(); view = new Date(cur.getFullYear(), cur.getMonth(), 1);
      render(); pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); root.classList.add('is-open'); openPicker = api;
      const target = pop.querySelector('.cal-day.is-selected') || pop.querySelector('.cal-day:not([disabled])'); if (target) target.focus();
    }
    function close() { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); root.classList.remove('is-open'); if (openPicker === api) openPicker = null; }
    const api = { root, btn, close };
    btn.addEventListener('click', () => pop.hidden ? open() : close());
    btn.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); open(); } });
    pop.addEventListener('click', e => {
      const nav = e.target.closest('.cal-nav'); const day = e.target.closest('.cal-day');
      if (nav) { view = new Date(view.getFullYear(), view.getMonth() + Number(nav.dataset.nav), 1); render(); const f = pop.querySelector('.cal-day:not([disabled])'); if (f) f.focus(); }
      else if (day && !day.disabled) choose(day.dataset.v);
    });
    pop.addEventListener('keydown', e => {
      const day = e.target.closest('.cal-day'); if (!day) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (step) {
        e.preventDefault(); const d = parseIso(day.dataset.v); d.setDate(d.getDate() + step);
        if (!inRange(d)) return;
        if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) { view = new Date(d.getFullYear(), d.getMonth(), 1); render(); }
        const t = pop.querySelector(`.cal-day[data-v="${iso(d)}"]`); if (t) t.focus();
      } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(day.dataset.v); }
    });
    input.addEventListener('change', sync); input.addEventListener('input', sync);
    input.addEventListener('focus', () => btn.focus());
    sync();
  }

  function labelIdFor(control) {
    const lab = form.querySelector(`label[for="${control.id}"]`);
    if (lab && !lab.id) lab.id = control.id + '-label';
    return lab ? lab.id : '';
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  form.querySelectorAll('select').forEach(enhanceSelect);
  form.querySelectorAll('input[type="date"]').forEach(enhanceDate);
  // Clicking a label should open our button, not the hidden native control
  form.querySelectorAll('label[for]').forEach(l => l.addEventListener('click', e => {
    const c = document.getElementById(l.htmlFor); const p = c && c.closest('.picker');
    if (p) { e.preventDefault(); p.querySelector('.picker-btn').focus(); }
  }));
})();
