/**
 * Ferhat Patisserie — Cloudflare Worker
 *
 * Routes
 *   POST /api/talep            → custom order request (multipart/form-data)
 *   GET  /api/health           → { ok: true }
 *   GET  /foto/{id}/{n}.{ext}  → original photo from R2 (unguessable id, noindex; bucket stays private)
 *   *                 → static assets (index.html etc.) with security headers
 *
 * Bindings (wrangler.jsonc)
 *   ASSETS  static site
 *   PHOTOS  R2 bucket — original photo bytes + request.json (the durable copy)
 *   STATE   KV — dedup by submission_id, rate limiting
 *
 * Secrets / vars (optional — each integration is skipped, and logged, when unset)
 *   AIRTABLE_TOKEN, AIRTABLE_BASE, AIRTABLE_TABLE, AIRTABLE_TABLE_ID (record links)
 *   RESEND_API_KEY, MAIL_FROM, OWNER_EMAIL, MAIL_REPLY_TO
 *   PHOTO_PUBLIC_BASE   optional; defaults to `<site origin>/foto` (served by this Worker)
 *   SITE_ORIGIN         optional; absolute origin for logo/links inside e-mails
 *   ALLOWED_ORIGINS     comma-separated; defaults to same-origin only
 *
 * Design rules (spec 2026-09-04 §6): validate → R2 first (durable) → Airtable → emails.
 * Never fail silently: every skipped/failed step is logged with the request id.
 */

const MAX_FILES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BODY_BYTES = 35 * 1024 * 1024;
const RATE_WINDOW_SEC = 600;
const RATE_MAX = 5;
const DEDUP_TTL_SEC = 24 * 3600;

const ORDER_TYPES = {
  'ozel-pasta': 'Özel pasta',
  'kuru-pasta': 'Kuru pasta & kurabiye',
  'borek-pogaca': 'Börek & poğaça (toplu)',
  'catering': 'Catering / kurumsal',
  'diger': 'Diğer'
};
const EVENT_TYPES = {
  'dogum-gunu': 'Doğum günü', 'nisan': 'Nişan', 'dugun': 'Düğün', 'baby-shower': 'Baby shower',
  'kurumsal': 'Kurumsal', 'diger': 'Diğer'
};
const DELIVERY = { 'dukkandan': 'Dükkândan teslim', 'adrese-teslim': 'Adrese teslim' };

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // Google Fonts + the Google Maps embed are the only third parties on the page.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "frame-src https://maps.google.com https://www.google.com https://challenges.cloudflare.com",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'"
  ].join('; ')
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({ ok: true, ts: new Date().toISOString() });
    }
    const foto = url.pathname.match(/^\/foto\/([a-z0-9]+-[a-z0-9]+)\/([1-9])\.(jpg|png|webp|heic)$/);
    if (foto) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ ok: false, message: 'Method not allowed' }, 405);
      return servePhoto(env, request, `${foto[1]}/${foto[2]}.${foto[3]}`);
    }
    if (url.pathname === '/api/talep') {
      if (request.method === 'OPTIONS') return cors(request, env, new Response(null, { status: 204 }));
      if (request.method !== 'POST') return json({ ok: false, message: 'Method not allowed' }, 405);
      const res = await handleTalep(request, env, ctx).catch(err => {
        const ref = shortId();
        console.error(`[talep] UNHANDLED ref=${ref} ${err && err.stack || err}`);
        return json({ ok: false, message: 'Beklenmeyen bir hata oluştu.', ref }, 500);
      });
      return cors(request, env, res);
    }

    // Static site
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/talep
// ─────────────────────────────────────────────────────────────
async function handleTalep(request, env, ctx) {
  // 1. Origin + size + rate limit
  if (!originAllowed(request, env)) return json({ ok: false, message: 'Geçersiz kaynak.' }, 403);
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) return json({ ok: false, message: 'Dosyalar çok büyük.' }, 413);

  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const limited = await rateLimited(env, ip);
  if (limited) return json({ ok: false, message: 'Çok fazla deneme.' }, 429);

  // 2. Parse
  let fd;
  try { fd = await request.formData(); }
  catch (e) { return json({ ok: false, message: 'Form verisi okunamadı.' }, 400); }

  if ((fd.get('website') || '').toString().trim() !== '') {
    // Honeypot filled → pretend success, store nothing, log it.
    console.warn(`[talep] honeypot hit ip=${maskIp(ip)}`);
    return json({ ok: true, referans: 'FP-0000-0000' });
  }

  // 3. Dedup (same submission_id within 24h → same answer, no second email)
  const submissionId = str(fd.get('submission_id')).slice(0, 80);
  if (submissionId && env.STATE) {
    const prev = await env.STATE.get('sub:' + submissionId);
    if (prev) { console.log(`[talep] dedup hit sub=${submissionId}`); return json(JSON.parse(prev)); }
  }

  // 4. Validate fields
  const v = validate(fd);
  if (v.error) return json({ ok: false, field: v.error.field, message: v.error.message }, 400);
  const data = v.data;

  // 5. Validate files (magic bytes, size, count)
  const files = fd.getAll('fotograf').filter(f => f && typeof f === 'object' && typeof f.arrayBuffer === 'function' && f.size > 0);
  if (files.length > MAX_FILES) return json({ ok: false, field: 'fotograf', message: `En fazla ${MAX_FILES} fotoğraf.` }, 400);
  const photos = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) return json({ ok: false, field: 'fotograf', message: 'Fotoğraf 10 MB\'ı geçemez.' }, 400);
    const buf = await f.arrayBuffer();
    const kind = sniffImage(new Uint8Array(buf));
    if (!kind) return json({ ok: false, field: 'fotograf', message: 'Sadece JPG, PNG, WEBP veya HEIC fotoğraf kabul ediyoruz.' }, 400);
    photos.push({ buf, ext: kind.ext, mime: kind.mime, size: f.size, name: safeName(f.name) });
  }

  // 6. Identity + metadata
  const id = newId();
  const referans = makeReferans(id);
  const cf = request.cf || {};
  const meta = {
    id, referans,
    created_at: new Date().toISOString(),
    created_at_tr: istanbulTime(new Date()),
    ip_masked: maskIp(ip),
    city: cf.city || '', region: cf.region || '', country: cf.country || '',
    ua: str(request.headers.get('user-agent')).slice(0, 200),
    device: deviceType(request.headers.get('user-agent')),
    page: str(fd.get('page')).slice(0, 200),
    tz: str(fd.get('tz')).slice(0, 60),
    submission_id: submissionId,
    source: 'Web formu'
  };

  // 7. R2 first — the durable copy. If this fails nothing else runs.
  const stored = [];
  try {
    for (let i = 0; i < photos.length; i++) {
      const key = `${id}/${i + 1}.${photos[i].ext}`;
      await env.PHOTOS.put(key, photos[i].buf, { httpMetadata: { contentType: photos[i].mime }, customMetadata: { original: photos[i].name } });
      stored.push({ key, mime: photos[i].mime, size: photos[i].size, name: photos[i].name });
    }
    await env.PHOTOS.put(`${id}/request.json`, JSON.stringify({ meta, data, photos: stored }, null, 2), { httpMetadata: { contentType: 'application/json' } });
  } catch (err) {
    const ref = shortId();
    console.error(`[talep] R2_FAILED ref=${ref} id=${id} ${err && err.message}`);
    return json({ ok: false, message: 'Talebiniz kaydedilemedi.', ref }, 502);
  }
  console.log(`[talep] STORED id=${id} ref=${referans} photos=${stored.length} type=${data.tur} city=${meta.city}`);

  // 8. Airtable (best effort, logged)
  const photoBase = (env.PHOTO_PUBLIC_BASE || new URL(request.url).origin + '/foto').replace(/\/$/, '');
  let airtableUrl = '';
  let airtableWarning = '';
  if (env.AIRTABLE_TOKEN && env.AIRTABLE_BASE && env.AIRTABLE_TABLE) {
    try {
      airtableUrl = await createAirtableRecord(env, meta, data, stored, photoBase);
      console.log(`[talep] AIRTABLE_OK id=${id}`);
    } catch (err) {
      airtableWarning = String(err && err.message || err).slice(0, 300);
      console.error(`[talep] AIRTABLE_FAILED id=${id} ${airtableWarning}`);
    }
  } else {
    console.warn(`[talep] AIRTABLE_SKIPPED id=${id} (not configured)`);
  }

  // 9. Emails (best effort, logged). Owner first, then customer.
  const mailConfigured = !!(env.RESEND_API_KEY && env.MAIL_FROM && env.OWNER_EMAIL);
  if (mailConfigured) {
    ctx.waitUntil((async () => {
      try { await sendOwnerEmail(env, meta, data, stored, photoBase, airtableUrl, airtableWarning); console.log(`[talep] MAIL_OWNER_OK id=${id}`); }
      catch (err) { console.error(`[talep] MAIL_OWNER_FAILED id=${id} ${err && err.message}`); }
      if (data.eposta) {
        try { await sendCustomerEmail(env, meta, data); console.log(`[talep] MAIL_CUSTOMER_OK id=${id}`); }
        catch (err) { console.error(`[talep] MAIL_CUSTOMER_FAILED id=${id} ${err && err.message}`); }
      }
    })());
  } else {
    console.warn(`[talep] EMAIL_SKIPPED id=${id} (not configured)`);
  }

  // 10. Remember the answer for retries. `mail` = a confirmation e-mail is actually being sent to the customer.
  const answer = { ok: true, id, referans, mail: mailConfigured && !!data.eposta };
  if (submissionId && env.STATE) ctx.waitUntil(env.STATE.put('sub:' + submissionId, JSON.stringify(answer), { expirationTtl: DEDUP_TTL_SEC }));
  return json(answer);
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────
function validate(fd) {
  const g = k => str(fd.get(k)).trim();
  const bad = (field, message) => ({ error: { field, message } });

  const ad_soyad = g('ad_soyad');
  if (ad_soyad.length < 2 || ad_soyad.length > 80) return bad('ad_soyad', 'Lütfen adınızı ve soyadınızı yazın.');

  const telefon = normalizePhone(g('telefon'));
  if (!telefon) return bad('telefon', 'Geçerli bir telefon numarası girin.');

  const eposta = g('eposta').toLowerCase();
  if (eposta && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(eposta)) return bad('eposta', 'E-posta adresi hatalı görünüyor.');
  if (eposta.length > 120) return bad('eposta', 'E-posta çok uzun.');

  const tur = g('tur');
  if (!ORDER_TYPES[tur]) return bad('tur', 'Sipariş türünü seçin.');

  const teslim_tarihi = g('teslim_tarihi');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(teslim_tarihi)) return bad('teslim_tarihi', 'Teslim tarihini seçin.');
  const today = istanbulDate();
  const min = addDays(today, 1), max = addDays(today, 180);
  if (teslim_tarihi < min) return bad('teslim_tarihi', 'En erken yarın için talep alabiliyoruz.');
  if (teslim_tarihi > max) return bad('teslim_tarihi', 'En fazla 6 ay sonrası için talep alabiliyoruz.');

  const kisi_raw = g('kisi_sayisi');
  const kisi_sayisi = kisi_raw ? Number(kisi_raw) : null;
  if (kisi_raw && !(Number.isInteger(kisi_sayisi) && kisi_sayisi >= 1 && kisi_sayisi <= 5000)) return bad('kisi_sayisi', '1 ile 5000 arasında bir sayı girin.');
  if ((tur === 'ozel-pasta' || tur === 'catering') && !kisi_sayisi) return bad('kisi_sayisi', 'Kaç kişilik olduğunu yazın.');

  const miktar = g('miktar').slice(0, 80);
  if (tur === 'kuru-pasta' && !miktar) return bad('miktar', 'Ne kadar istediğinizi yazın (örn. 2 kg).');

  const adet_raw = g('adet');
  const adet = adet_raw ? Number(adet_raw) : null;
  if (adet_raw && !(Number.isInteger(adet) && adet >= 1 && adet <= 5000)) return bad('adet', '1 ile 5000 arasında bir sayı girin.');
  if (tur === 'borek-pogaca' && !adet) return bad('adet', 'Kaç adet istediğinizi yazın.');

  const teslim_saati = g('teslim_saati');
  if (teslim_saati && !/^\d{2}:\d{2}$/.test(teslim_saati)) return bad('teslim_saati', 'Saat biçimi hatalı.');
  if (tur === 'borek-pogaca' && !teslim_saati) return bad('teslim_saati', 'Teslim saatini seçin.');

  const etkinlik = g('etkinlik');
  if (etkinlik && !EVENT_TYPES[etkinlik]) return bad('etkinlik', 'Etkinlik türü geçersiz.');
  if (tur === 'catering' && !etkinlik) return bad('etkinlik', 'Etkinlik türünü seçin.');

  const teslim_sekli = g('teslim_sekli');
  if (teslim_sekli && !DELIVERY[teslim_sekli]) return bad('teslim_sekli', 'Teslim şekli geçersiz.');
  if (tur === 'catering' && !teslim_sekli) return bad('teslim_sekli', 'Teslim şeklini seçin.');

  const adres = g('adres').slice(0, 300);
  if (teslim_sekli === 'adrese-teslim' && adres.length < 8) return bad('adres', 'Teslimat adresini yazın.');

  const pasta_yazisi = g('pasta_yazisi').slice(0, 120);
  const diger_aciklama = g('diger_aciklama').slice(0, 120);
  if (tur === 'diger' && diger_aciklama.length < 3) return bad('diger_aciklama', 'Ne istediğinizi kısaca yazın.');
  const notlar = g('notlar');
  if (notlar.length > 1500) return bad('notlar', 'Not en fazla 1500 karakter olabilir.');

  if (g('kvkk') !== '1') return bad('kvkk', 'Devam etmek için aydınlatma metnini onaylayın.');

  return { data: { ad_soyad, telefon, eposta, tur, tur_label: ORDER_TYPES[tur], teslim_tarihi, kisi_sayisi, miktar, adet, teslim_saati, etkinlik, etkinlik_label: EVENT_TYPES[etkinlik] || '', teslim_sekli, teslim_sekli_label: DELIVERY[teslim_sekli] || '', adres, pasta_yazisi, diger_aciklama, notlar, kvkk_onay: true } };
}

function normalizePhone(raw) {
  let d = (raw || '').replace(/\D/g, '');
  if (d.startsWith('0090')) d = d.slice(4);
  else if (d.startsWith('90') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  if (d.length !== 10 || !/^[2-5]/.test(d)) return null;
  return '+90' + d;
}

function sniffImage(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ext: 'webp', mime: 'image/webp' };
  // ISO BMFF: ....ftypheic / heix / hevc / mif1
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return { ext: 'heic', mime: 'image/heic' };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Airtable
// ─────────────────────────────────────────────────────────────
async function createAirtableRecord(env, meta, data, stored, photoBase) {
  const fields = {
    'Referans': meta.referans,
    'Durum': 'Yeni',
    'Kaynak': meta.source,
    'Ad Soyad': data.ad_soyad,
    'Telefon': data.telefon,
    'E-posta': data.eposta || '',
    'Sipariş türü': data.tur_label,
    'Teslim tarihi': data.teslim_tarihi,
    'Kişi sayısı': data.kisi_sayisi || undefined,
    'Miktar': data.miktar || '',
    'Adet': data.adet || undefined,
    'Teslim saati': data.teslim_saati || '',
    'Etkinlik': data.etkinlik_label || undefined,
    'Teslim şekli': data.teslim_sekli_label || undefined,
    'Adres': data.adres || '',
    'Pasta yazısı': data.pasta_yazisi || '',
    'Diğer (açıklama)': data.diger_aciklama || '',
    'Notlar': data.notlar || '',
    'Şehir': [meta.city, meta.country].filter(Boolean).join(', '),
    'Cihaz': meta.device,
    'Talep ID': meta.id,
    'KVKK onayı': true,
    'Oluşturma (TR)': meta.created_at_tr
  };
  if (stored.length) {
    fields['Fotoğraflar'] = stored.map(p => ({ url: `${photoBase}/${p.key}`, filename: p.name }));
  }
  Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(env.AIRTABLE_TABLE)}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const recId = body.records && body.records[0] && body.records[0].id;
  if (!recId) return '';
  // Record deep link needs the table id (tblXXX); without it fall back to the base.
  return env.AIRTABLE_TABLE_ID ? `https://airtable.com/${env.AIRTABLE_BASE}/${env.AIRTABLE_TABLE_ID}/${recId}` : `https://airtable.com/${env.AIRTABLE_BASE}`;
}

// ─────────────────────────────────────────────────────────────
// Email (Resend)
// ─────────────────────────────────────────────────────────────
async function resend(env, msg) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(msg)
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function summaryLine(data) {
  const parts = [data.ad_soyad, fmtDateTr(data.teslim_tarihi)];
  if (data.diger_aciklama) parts.push(data.diger_aciklama);
  if (data.etkinlik_label) parts.push(data.etkinlik_label);
  if (data.kisi_sayisi) parts.push(`${data.kisi_sayisi} kişi`);
  else if (data.adet) parts.push(`${data.adet} adet`);
  else if (data.miktar) parts.push(data.miktar);
  return parts.join(' · ');
}

// Shared shell: ivory ground, white card, dark header with the logo. Inline styles only (e-mail clients).
function emailShell(env, meta, { preheader, body }) {
  const origin = (env.SITE_ORIGIN || 'https://ferhat-patisserie.1cihankoca.workers.dev').replace(/\/$/, '');
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ferhat Patisserie</title></head>
<body style="margin:0;padding:0;background:#faf6f0;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#faf6f0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf6f0;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #f0ebe3;">
  <tr><td style="background:#1a1410;padding:26px 28px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:14px;"><img src="${origin}/images-enhanced/profil-nav.png" width="56" height="56" alt="Ferhat Patisserie" style="display:block;border-radius:50%;border:1px solid #c9a96e;"></td>
      <td style="font-family:Georgia,'Times New Roman',serif;color:#faf6f0;font-size:22px;line-height:1.15;">Ferhat <span style="color:#c9a96e;font-style:italic;">Patisserie</span><div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a8957a;margin-top:6px;">Mersin · 24 saat açık</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:30px 28px 10px;font-family:Arial,Helvetica,sans-serif;color:#1a1410;">${body}</td></tr>
  <tr><td style="padding:18px 28px 26px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#8a7a6e;border-top:1px solid #f0ebe3;">
    Ferhat Patisserie · Nusratiye Mah, Kuvayi Milliye Cad No:126/E, Akdeniz / Mersin<br>
    <a href="tel:+905403143333" style="color:#8a7a6e;">0540 314 33 33</a> · <a href="${origin}" style="color:#8a7a6e;">ferhat-patisserie</a>
  </td></tr>
</table>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#b3a696;margin-top:14px;">Talep ${esc(meta.referans)}</div>
</td></tr></table></body></html>`;
}
const H1 = 'font-family:Georgia,\'Times New Roman\',serif;font-weight:normal;font-size:26px;line-height:1.2;margin:0 0 6px;color:#1a1410;';
const P = 'font-size:15px;line-height:1.65;margin:0 0 14px;color:#3d322a;';
const PILL = 'display:inline-block;padding:7px 14px;border-radius:100px;background:#f5e6c8;color:#1a1410;font-size:13px;letter-spacing:1px;font-weight:bold;';
const BTN = 'display:inline-block;background:#c9a96e;color:#0a0a0a;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 22px;border-radius:100px;';
function rowsTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:6px 0 18px;">${rows.map(([k, v]) =>
    `<tr><td style="padding:9px 0;border-bottom:1px solid #f0ebe3;color:#8a7a6e;width:36%;vertical-align:top;">${esc(k)}</td><td style="padding:9px 0;border-bottom:1px solid #f0ebe3;color:#1a1410;white-space:pre-wrap;vertical-align:top;">${esc(v)}</td></tr>`).join('')}</table>`;
}
function firstName(full) { return str(full).trim().split(/\s+/)[0] || ''; }

async function sendOwnerEmail(env, meta, data, stored, photoBase, airtableUrl, airtableWarning) {
  const tel = data.telefon;
  const place = [meta.city, meta.country].filter(Boolean).join(', ');
  const rows = [
    ['Sipariş türü', data.tur_label + (data.diger_aciklama ? ' — ' + data.diger_aciklama : '')],
    ['Teslim', fmtDateTr(data.teslim_tarihi) + (data.teslim_saati ? ' · ' + data.teslim_saati : '')],
    ['Kişi / miktar', data.kisi_sayisi ? `${data.kisi_sayisi} kişi` : (data.adet ? `${data.adet} adet` : (data.miktar || '—'))],
    ['Etkinlik', data.etkinlik_label || '—'],
    ['Teslim şekli', data.teslim_sekli_label || '—'],
    ['Adres', data.adres || '—'],
    ['Pasta yazısı', data.pasta_yazisi || '—'],
    ['Notlar', data.notlar || '—'],
    ['E-posta', data.eposta || '— (müşteri yazmadı; onay yalnızca telefonla)'],
    ['Zaman', meta.created_at_tr]
  ];
  if (place) rows.push(['Gönderim yeri (IP\'den tahmini)', place]);
  const photoLinks = stored.map(p => `${photoBase}/${p.key}`);
  const body = `
<h1 style="${H1}">Yeni sipariş talebi</h1>
<p style="${P}">${esc(summaryLine(data))}</p>
<p style="margin:0 0 20px;"><span style="${PILL}">${esc(meta.referans)}</span></p>
<p style="margin:0 0 22px;"><a href="tel:${esc(tel)}" style="${BTN}">${esc(fmtPhone(tel))} · Ara</a></p>
${rowsTable(rows)}
${photoLinks.length ? `<div style="font-size:13px;color:#8a7a6e;margin:0 0 8px;">Referans fotoğraf${photoLinks.length > 1 ? 'lar' : ''} (${photoLinks.length})</div>` + photoLinks.map(u => `<a href="${esc(u)}"><img src="${esc(u)}" alt="Referans fotoğraf" style="max-width:100%;border-radius:12px;margin:0 0 10px;display:block;border:1px solid #f0ebe3;"></a>`).join('') : ''}
${airtableUrl ? `<p style="margin:18px 0 0;"><a href="${esc(airtableUrl)}" style="color:#1a1410;font-size:14px;">Airtable'da aç →</a></p>` : ''}
${airtableWarning ? `<p style="margin:16px 0 0;padding:10px 12px;background:#fff3f3;border-radius:8px;color:#7a2e2e;font-size:13px;">⚠️ Airtable kaydı oluşturulamadı; talep dosya deposunda güvende (ID ${esc(meta.id)}). Hata: ${esc(airtableWarning)}</p>` : ''}
<p style="margin:22px 0 0;font-size:11px;color:#b3a696;">Talep ID ${esc(meta.id)} · ${esc(meta.device)} · IP ${esc(meta.ip_masked)}</p>`;
  const text = `Yeni sipariş talebi\n${summaryLine(data)}\nReferans: ${meta.referans}\nTelefon: ${fmtPhone(tel)}\n` + rows.map(([k, v]) => `${k}: ${v}`).join('\n') + (photoLinks.length ? `\nFotoğraflar:\n${photoLinks.join('\n')}` : '') + (airtableUrl ? `\nAirtable: ${airtableUrl}` : '');
  return resend(env, {
    from: env.MAIL_FROM,
    to: env.OWNER_EMAIL.split(',').map(s => s.trim()).filter(Boolean),
    reply_to: data.eposta || env.MAIL_REPLY_TO || undefined,
    subject: `🎂 Yeni talep · ${summaryLine(data)}`,
    html: emailShell(env, meta, { preheader: `${summaryLine(data)} · ${fmtPhone(tel)}`, body }), text,
    headers: { 'X-Entity-Ref-ID': meta.id }
  });
}

async function sendCustomerEmail(env, meta, data) {
  const name = firstName(data.ad_soyad);
  const what = [data.diger_aciklama || data.tur_label, data.kisi_sayisi ? `${data.kisi_sayisi} kişilik` : '', data.adet ? `${data.adet} adet` : '', data.miktar].filter(Boolean).join(', ');
  const rows = [
    ['Ne', what],
    ['Ne zaman', fmtDateTr(data.teslim_tarihi) + (data.teslim_saati ? ' · ' + data.teslim_saati : '')],
    ['Sizi arayacağımız numara', fmtPhone(data.telefon)]
  ];
  if (data.etkinlik_label) rows.splice(1, 0, ['Etkinlik', data.etkinlik_label]);
  if (data.pasta_yazisi) rows.push(['Pasta üstü yazı', data.pasta_yazisi]);
  const body = `
<h1 style="${H1}">Talebiniz bize ulaştı</h1>
<p style="margin:0 0 22px;"><span style="${PILL}">${esc(meta.referans)}</span></p>
<p style="${P}">Merhaba ${esc(name || data.ad_soyad)},</p>
<p style="${P}">Talebinizi aldık. Ustamız fotoğrafınıza ve notlarınıza bakıp en kısa sürede sizi arayacak; fiyatı ve detayları telefonda birlikte netleştireceğiz. Bu e-posta bir sipariş onayı değildir.</p>
${rowsTable(rows)}
<p style="${P}">Acele bir durum varsa bize her saat ulaşabilirsiniz:</p>
<p style="margin:0 0 8px;"><a href="tel:+905403143333" style="${BTN}">0540 314 33 33 · Ara</a></p>`;
  const text = `Talebiniz bize ulaştı — Referans ${meta.referans}\n\nMerhaba ${name || data.ad_soyad},\nTalebinizi aldık. En kısa sürede ${fmtPhone(data.telefon)} numarasından sizi arayacağız; fiyat ve detaylar telefonda netleşir. Bu e-posta bir sipariş onayı değildir.\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nAcele bir durum varsa: 0540 314 33 33\nFerhat Patisserie — Nusratiye Mah, Kuvayi Milliye Cad No:126/E, Akdeniz / Mersin`;
  return resend(env, {
    from: env.MAIL_FROM,
    to: [data.eposta],
    reply_to: env.MAIL_REPLY_TO || undefined,
    subject: `${name ? name + ', t' : 'T'}alebiniz alındı · Ferhat Patisserie · ${meta.referans}`,
    html: emailShell(env, meta, { preheader: `Talebinizi aldık, en kısa sürede sizi arayacağız. Referans ${meta.referans}.`, body }), text,
    headers: { 'X-Entity-Ref-ID': meta.id + ':customer' }
  });
}

// ─────────────────────────────────────────────────────────────
// GET /foto/{id}/{n}.{ext} — photo bytes from the private R2 bucket
// ─────────────────────────────────────────────────────────────
async function servePhoto(env, request, key) {
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
  const h = new Headers();
  h.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream');
  h.set('Content-Length', String(obj.size));
  h.set('ETag', obj.httpEtag);
  h.set('Cache-Control', 'private, max-age=3600');
  h.set('Content-Disposition', 'inline');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Robots-Tag', 'noindex, nofollow');
  h.set('Content-Security-Policy', "default-src 'none'; sandbox");
  if (request.headers.get('if-none-match') === obj.httpEtag) return new Response(null, { status: 304, headers: h });
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers: h });
}

// ─────────────────────────────────────────────────────────────
// Rate limit / origin / helpers
// ─────────────────────────────────────────────────────────────
async function rateLimited(env, ip) {
  if (!env.STATE) return false;
  try {
    const key = 'rl:' + ip;
    const cur = Number(await env.STATE.get(key) || 0);
    if (cur >= RATE_MAX) return true;
    await env.STATE.put(key, String(cur + 1), { expirationTtl: RATE_WINDOW_SEC });
    return false;
  } catch (err) {
    console.error(`[talep] RATE_LIMIT_ERROR ${err && err.message} — allowing`);
    return false; // never block real customers because the limiter broke
  }
}

function originAllowed(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin form posts may omit Origin in some browsers
  const self = new URL(request.url).origin;
  const allowed = new Set([self, ...(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
  return allowed.has(origin);
}

function cors(request, env, res) {
  const origin = request.headers.get('origin');
  if (!origin || !originAllowed(request, env)) return res;
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function str(v) { return v == null ? '' : String(v); }
function esc(s) { return str(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeName(n) { return str(n).replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'foto'; }
function shortId() { return Math.random().toString(36).slice(2, 8); }
function newId() {
  const t = Date.now().toString(36);
  const r = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 10);
  return `${t}-${r}`;
}
function makeReferans(id) {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2), mm = String(d.getMonth() + 1).padStart(2, '0');
  const tail = id.slice(-4).toUpperCase();
  return `FP-${yy}${mm}-${tail}`;
}
function maskIp(ip) {
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : ip;
}
function deviceType(ua) {
  ua = str(ua);
  if (/iPad|Tablet/i.test(ua)) return 'Tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'Telefon';
  return 'Bilgisayar';
}
function istanbulDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function istanbulTime(d = new Date()) {
  return new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDateTr(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' }).format(new Date(iso + 'T12:00:00Z'));
}
function fmtPhone(p) {
  const d = str(p).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('90')) return `0${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10)}`;
  return p;
}
