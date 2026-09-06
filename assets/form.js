/* ═══════════════════════════════════════════
   FERHAT PATISSERIE — Özel Sipariş Talebi formu
   Vanilla JS. Posts multipart to /api/talep (Cloudflare Worker).
   ═══════════════════════════════════════════ */
(function () {
  'use strict';

  const form = document.getElementById('talepForm');
  if (!form) return;

  const ENDPOINT = form.getAttribute('action') || '/api/talep';
  const MAX_FILES = 3;
  const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  const PHONE_DISPLAY = '0540 314 33 33';

  const card = form.closest('.request-card');
  const typeSelect = form.elements['tur'];
  const teslimSelect = form.elements['teslim_sekli'];
  const dateInput = form.elements['teslim_tarihi'];
  const submitBtn = form.querySelector('[type="submit"]');
  const alertBox = form.querySelector('.form-alert');
  const upload = form.querySelector('.upload');
  const fileInput = form.elements['fotograf'];
  const previews = form.querySelector('.upload-previews');

  // submission_id: the same id is re-sent on retry so the server can dedup.
  let submissionId = null;
  function newSubmissionId() {
    submissionId = (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'sub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    return submissionId;
  }
  newSubmissionId();

  // ── Date bounds: tomorrow .. +180 days (local time) ──
  function isoLocal(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  // "Today" is the shop's day (Europe/Istanbul), not the visitor's — the Worker validates in that zone too.
  const istanbulToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const today = new Date(istanbulToday + 'T00:00:00');
  const minDate = new Date(today); minDate.setDate(today.getDate() + 1);
  const maxDate = new Date(today); maxDate.setDate(today.getDate() + 180);
  dateInput.min = isoLocal(minDate);
  dateInput.max = isoLocal(maxDate);

  // ── Conditional fields by order type ──
  // data-types="a,b" → visible for those types; data-required-for="a" → required for those types.
  const conditional = Array.from(form.querySelectorAll('[data-types]'));
  function applyType() {
    const t = typeSelect.value;
    conditional.forEach(field => {
      const types = field.dataset.types.split(',');
      const show = t && types.includes(t);
      field.hidden = !show;
      const control = field.querySelector('input, select, textarea');
      if (!control) return;
      const reqFor = (field.dataset.requiredFor || '').split(',').filter(Boolean);
      control.required = show && reqFor.includes(t);
      if (!show) { clearError(field); }
      const req = field.querySelector('.req'); const opt = field.querySelector('.opt');
      if (req) req.hidden = !control.required;
      if (opt) opt.hidden = control.required;
    });
    applyDelivery();
  }
  function applyDelivery() {
    const addr = form.querySelector('[data-address]');
    if (!addr || !teslimSelect) return;
    const show = !addr.closest('[data-types]').hidden && teslimSelect.value === 'adrese-teslim';
    addr.hidden = !show;
    const ctl = addr.querySelector('textarea, input');
    if (ctl) ctl.required = show;
  }
  typeSelect.addEventListener('change', applyType);
  if (teslimSelect) teslimSelect.addEventListener('change', applyDelivery);
  applyType();

  // ── Validation ──
  function fieldOf(control) { return control.closest('.field'); }
  function setError(field, msg) {
    if (!field) return;
    field.classList.add('is-invalid');
    const e = field.querySelector('.field-error');
    if (e) e.textContent = msg;
  }
  function clearError(field) {
    if (!field) return;
    field.classList.remove('is-invalid');
  }

  function normalizePhone(raw) {
    const digits = (raw || '').replace(/\D/g, '');
    let d = digits;
    if (d.startsWith('0090')) d = d.slice(4);
    else if (d.startsWith('90') && d.length === 12) d = d.slice(2);
    else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
    if (d.length !== 10) return null;
    if (!/^[2-5]/.test(d)) return null; // TR: 2xx-4xx landline, 5xx mobile
    return '+90' + d;
  }

  const validators = {
    ad_soyad: v => v.trim().length >= 2 && v.trim().length <= 80 ? null : 'Lütfen adınızı ve soyadınızı yazın.',
    telefon: v => normalizePhone(v) ? null : 'Geçerli bir telefon numarası girin (örn. 0540 314 33 33).',
    eposta: v => !v.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? null : 'E-posta adresi hatalı görünüyor.',
    tur: v => v ? null : 'Ne tür bir sipariş istediğinizi seçin.',
    teslim_tarihi: v => {
      if (!v) return 'Teslim tarihini seçin.';
      if (v < dateInput.min) return 'En erken yarın için talep alabiliyoruz.';
      if (v > dateInput.max) return 'En fazla 6 ay sonrası için talep alabiliyoruz.';
      return null;
    },
    kisi_sayisi: v => !v || (Number(v) >= 1 && Number(v) <= 5000) ? null : '1 ile 5000 arasında bir sayı girin.',
    notlar: v => v.length <= 1500 ? null : 'Not en fazla 1500 karakter olabilir.',
    kvkk: (_v, el) => el.checked ? null : 'Devam etmek için aydınlatma metnini onaylayın.'
  };

  function validateControl(el) {
    const field = fieldOf(el);
    if (!field || field.hidden) return true;
    const fn = validators[el.name];
    let msg = null;
    if (el.required && !(el.type === 'checkbox' ? el.checked : el.value.trim())) {
      msg = el.dataset.requiredMsg || 'Bu alan zorunlu.';
    } else if (fn) {
      msg = fn(el.value, el);
    }
    if (msg) { setError(field, msg); return false; }
    clearError(field); return true;
  }

  form.querySelectorAll('input, select, textarea').forEach(el => {
    if (el.name === 'fotograf' || el.name === 'website') return;
    el.addEventListener('blur', () => validateControl(el));
    el.addEventListener('input', () => { if (fieldOf(el)?.classList.contains('is-invalid')) validateControl(el); });
    el.addEventListener('change', () => validateControl(el));
  });

  // ── Photos ──
  let files = [];
  function fmtSize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB'; }
  function renderPreviews() {
    previews.innerHTML = '';
    files.forEach((f, i) => {
      const box = document.createElement('div'); box.className = 'preview';
      const img = document.createElement('img'); img.alt = f.name;
      const url = URL.createObjectURL(f); img.src = url; img.onload = () => URL.revokeObjectURL(url);
      const rm = document.createElement('button'); rm.type = 'button'; rm.setAttribute('aria-label', 'Fotoğrafı kaldır'); rm.textContent = '×';
      rm.addEventListener('click', () => { files.splice(i, 1); renderPreviews(); });
      const size = document.createElement('span'); size.className = 'preview-size'; size.textContent = fmtSize(f.size);
      box.append(img, rm, size); previews.appendChild(box);
    });
  }
  function addFiles(list) {
    const field = fieldOf(fileInput); clearError(field);
    for (const f of Array.from(list)) {
      if (files.length >= MAX_FILES) { setError(field, 'En fazla ' + MAX_FILES + ' fotoğraf ekleyebilirsiniz.'); break; }
      const okType = ALLOWED_TYPES.includes(f.type) || /\.(heic|heif)$/i.test(f.name);
      if (!okType) { setError(field, f.name + ': sadece JPG, PNG, WEBP veya HEIC fotoğraf.'); continue; }
      if (f.size > MAX_FILE_BYTES) { setError(field, f.name + ': fotoğraf 10 MB\'ı geçemez.'); continue; }
      if (files.some(x => x.name === f.name && x.size === f.size)) continue;
      files.push(f);
    }
    renderPreviews();
    fileInput.value = '';
  }
  fileInput.addEventListener('change', e => addFiles(e.target.files));
  upload.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') fileInput.click(); });
  upload.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragenter', 'dragover'].forEach(ev => upload.addEventListener(ev, e => { e.preventDefault(); upload.classList.add('is-drag'); }));
  ['dragleave', 'drop'].forEach(ev => upload.addEventListener(ev, e => { e.preventDefault(); upload.classList.remove('is-drag'); }));
  upload.addEventListener('drop', e => addFiles(e.dataTransfer.files));

  // ── Alerts ──
  function showAlert(html) {
    alertBox.innerHTML = html; alertBox.classList.add('is-visible');
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function hideAlert() { alertBox.classList.remove('is-visible'); alertBox.innerHTML = ''; }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.innerHTML = busy
      ? '<span class="spinner" aria-hidden="true"></span> Gönderiliyor…'
      : submitBtn.dataset.label;
  }
  submitBtn.dataset.label = submitBtn.innerHTML;

  // ── Submit ──
  form.addEventListener('submit', async e => {
    e.preventDefault();
    hideAlert();

    let ok = true; let firstBad = null;
    form.querySelectorAll('input, select, textarea').forEach(el => {
      if (el.name === 'fotograf' || el.name === 'website') return;
      if (!validateControl(el)) { ok = false; firstBad = firstBad || el; }
    });
    if (!ok) { firstBad.focus({ preventScroll: false }); firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }

    const fd = new FormData();
    Array.from(form.elements).forEach(el => {
      if (!el.name || el.name === 'fotograf' || el.disabled) return;
      if (fieldOf(el)?.hidden) return;
      if (el.type === 'checkbox') fd.append(el.name, el.checked ? '1' : '');
      else fd.append(el.name, el.value);
    });
    fd.set('telefon', normalizePhone(form.elements['telefon'].value));
    fd.append('submission_id', submissionId);
    fd.append('page', location.pathname + location.hash);
    fd.append('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || '');
    files.forEach(f => fd.append('fotograf', f, f.name));

    setBusy(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', body: fd, signal: ctrl.signal });
      let data = null;
      try { data = await res.json(); } catch (_) { /* non-JSON body */ }

      if (res.ok && data && data.ok) {
        showSuccess(data);
        return;
      }
      if (res.status === 400 && data && data.field) {
        // Server messages are our own strings, but they are still escaped before any HTML insertion.
        const el = form.elements[data.field];
        if (el) { setError(fieldOf(el), data.message || 'Bu alanı kontrol edin.'); el.focus(); }
        else showAlert(escapeHtml(data.message || 'Formda bir hata var, lütfen kontrol edin.'));
        return;
      }
      if (res.status === 413) { showAlert('Fotoğraflar çok büyük. Toplam 30 MB\'ı geçmeyecek şekilde tekrar deneyin.'); return; }
      if (res.status === 429) { showAlert('Kısa sürede çok fazla deneme yapıldı. Birkaç dakika sonra tekrar deneyin ya da bizi arayın: <a href="tel:+905403143333">' + PHONE_DISPLAY + '</a>'); return; }
      showAlert('Bir sorun oluştu, talebiniz gönderilemedi. Tekrar deneyebilir ya da bizi arayabilirsiniz: <a href="tel:+905403143333">' + PHONE_DISPLAY + '</a>' + (data && data.ref ? ' <small>(hata kodu ' + escapeHtml(data.ref) + ')</small>' : ''));
    } catch (err) {
      const timedOut = err && err.name === 'AbortError';
      showAlert((timedOut ? 'Bağlantı zaman aşımına uğradı.' : 'Bağlantı hatası.') + ' İnternetinizi kontrol edip tekrar deneyin ya da bizi arayın: <a href="tel:+905403143333">' + PHONE_DISPLAY + '</a>');
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  });

  function showSuccess(data) {
    const email = form.elements['eposta'].value.trim();
    const ref = data.referans || data.id || '';
    card.innerHTML =
      '<div class="request-success" role="status" aria-live="polite">' +
        '<div class="request-success-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div>' +
        '<div class="request-success-title">Talebiniz alındı</div>' +
        (ref ? '<div class="request-success-ref">Referans: ' + escapeHtml(ref) + '</div>' : '') +
        '<p class="request-success-text">' +
          (data.mail === true && email ? '<strong>' + escapeHtml(email) + '</strong> adresine bir onay e-postası gönderdik, lütfen gelen kutunuzu (ve spam klasörünü) kontrol edin. ' : '') +
          'Ferhat Patisserie en kısa sürede <strong>' + escapeHtml(form.elements['telefon'].value) + '</strong> numarasından sizi arayacak; fiyat ve detayları birlikte netleştireceğiz.' +
        '</p>' +
        '<a href="#menu" class="btn btn-outline">Menüye Dön</a>' +
      '</div>';
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    newSubmissionId();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── KVKK dialog ──
  const dlg = document.getElementById('kvkkDialog');
  document.querySelectorAll('[data-open-kvkk]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    if (dlg && typeof dlg.showModal === 'function') dlg.showModal();
    else if (dlg) dlg.setAttribute('open', '');
  }));
  if (dlg) {
    dlg.querySelectorAll('[data-close-kvkk]').forEach(b => b.addEventListener('click', () => dlg.close ? dlg.close() : dlg.removeAttribute('open')));
    dlg.addEventListener('click', e => { if (e.target === dlg && dlg.close) dlg.close(); });
  }
})();
