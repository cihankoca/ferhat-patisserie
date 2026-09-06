/* ═══════════════════════════════════════════
   FERHAT PATISSERIE — Asistan (scripted preview)
   No AI calls, no data collection. Answers from SITE_FACTS below.
   Prices and dates are never quoted; the form is the only next step.
   ═══════════════════════════════════════════ */
(function () {
  'use strict';

  const SITE_FACTS = {
    name: 'Ferhat Patisserie',
    hours: '24 saat açığız, haftanın her günü.',
    address: 'Nusratiye Mah, Kuvayi Milliye Cad No:126/E, 33080 Akdeniz / Mersin',
    maps: 'https://maps.google.com/maps?q=36.8097910,34.6207350',
    phones: ['0324 336 10 74', '0540 314 33 33'],
    getir: 'https://getir.com/yemek/restoran/ferhat-patisseria-akdeniz-nusratiye-mah-akdeniz-mersin/',
    instagram: 'https://www.instagram.com/ferhatpatisserie/',
    products: 'Yaş pasta, konsept ve özel tasarım pasta, kuru pasta ve kurabiye, taş fırın börek ve poğaça, simit, sütlaç, trileçe, magnolya, ekler ve daha fazlası.',
    payment: 'Nakit ve kredi kartı kabul ediyoruz.',
    wifi: 'Ücretsiz Wi-Fi var.'
  };

  const FORM_LINK = '<a href="#talep" data-chat-go>Sipariş talebi formu</a>';
  const CALL_LINK = '<a href="tel:+905403143333">0540 314 33 33</a>';

  // Each rule: keywords (any match, Turkish-insensitive) → answer + optional chips
  const RULES = [
    { k: ['saat', 'açık', 'acik', 'kaçta', 'kacta', 'kapan', 'çalışma', 'calisma', 'gece'], a: `<strong>${SITE_FACTS.hours}</strong> Gece yarısı poğaça için bile gelebilirsiniz.`, chips: ['Adres', 'Özel pasta yaptırmak istiyorum'] },
    { k: ['adres', 'nerede', 'nerde', 'konum', 'yol', 'harita', 'mersin', 'nusratiye'], a: `${SITE_FACTS.address}. <a href="${SITE_FACTS.maps}" target="_blank" rel="noopener">Haritada aç</a>`, chips: ['Çalışma saatleri', 'Telefon'] },
    { k: ['telefon', 'ara', 'numara', 'iletişim', 'iletisim', 'ulaş', 'ulas'], a: `Bize ${CALL_LINK} ya da <a href="tel:+903243361074">0324 336 10 74</a> numaralarından ulaşabilirsiniz. Özel sipariş için formu doldurursanız biz sizi ararız: ${FORM_LINK}.`, chips: ['Özel pasta yaptırmak istiyorum', 'Adres'] },
    { k: ['fiyat', 'fiyatı', 'kaç para', 'kac para', 'ne kadar', 'ücret', 'ucret', 'tl', 'lira', 'pahalı', 'ucuz', 'bütçe', 'butce'], a: `Fiyat; boyuta, tasarıma ve tarihe göre değişiyor, o yüzden buradan rakam veremiyorum. ${FORM_LINK}'nu doldurun, ustamız sizi arayıp net fiyatı söylesin. Ya da hemen arayın: ${CALL_LINK}.`, chips: ['Sipariş talebi formu', 'Telefon'] },
    { k: ['özel pasta', 'ozel pasta', 'konsept', 'tasarım', 'tasarim', 'doğum günü', 'dogum gunu', 'doğumgünü', 'nişan', 'nisan', 'düğün', 'dugun', 'baby shower', 'yaptır', 'yaptir', 'sipariş ver', 'siparis ver', 'pasta istiyorum', 'katlı', 'katli', 'şekerli hamur', 'figür', 'figur'], a: `Harika, özel pastalar bizim işimiz. Beğendiğiniz bir modelin fotoğrafını ekleyerek ${FORM_LINK}'nu doldurun; kişi sayısı ve tarihi de yazın. Ustamız sizi arayıp fiyatı ve detayları konuşacak.`, chips: ['Sipariş talebi formu', 'Ne kadar önceden sipariş vermeliyim?'] },
    { k: ['önceden', 'onceden', 'kaç gün', 'kac gun', 'yetişir', 'yetisir', 'acil', 'yarın', 'yarin', 'bugün', 'bugun', 'süre', 'sure'], a: `Özel pastalar için en erken yarın için talep alıyoruz; katlı ve figürlü tasarımlarda birkaç gün önceden haber vermek en iyisi. Acil bir durum varsa arayın, bakalım: ${CALL_LINK}.`, chips: ['Sipariş talebi formu', 'Telefon'] },
    { k: ['teslimat', 'teslim', 'kapıya', 'kapiya', 'eve', 'gönder', 'gonder', 'kurye', 'getir', 'yemeksepeti', 'online', 'paket'], a: `Günlük ürünlerimizi <a href="${SITE_FACTS.getir}" target="_blank" rel="noopener">GetirYemek</a> üzerinden kapınıza getirtebilirsiniz. Özel pasta ve toplu siparişlerde teslim şeklini formda seçiyorsunuz, ustamız sizi arayınca netleştiriyoruz.`, chips: ['Özel pasta yaptırmak istiyorum', 'Menü'] },
    { k: ['menü', 'menu', 'ürün', 'urun', 'neler var', 'çeşit', 'cesit', 'börek', 'borek', 'poğaça', 'pogaca', 'simit', 'kurabiye', 'tatlı', 'tatli', 'ekler', 'trileçe', 'trilece', 'magnolya', 'sütlaç', 'sutlac'], a: `${SITE_FACTS.products} <a href="#menu" data-chat-go>Menünün tamamı</a> sitede.`, chips: ['Özel pasta yaptırmak istiyorum', 'Teslimat var mı?'] },
    { k: ['catering', 'kurumsal', 'toplu', 'ikram', 'ofis', 'şirket', 'sirket', 'organizasyon', 'davet', 'kokteyl', 'kişilik', 'kisilik'], a: `Toplu ve kurumsal siparişler alıyoruz. ${FORM_LINK}'nda "Catering / kurumsal" seçip kişi sayısını ve tarihi yazın; ustamız sizi arayıp menüyü birlikte planlasın.`, chips: ['Sipariş talebi formu', 'Telefon'] },
    { k: ['alerji', 'alerjen', 'glüten', 'gluten', 'şekersiz', 'sekersiz', 'vegan', 'laktoz', 'fındık', 'findik', 'diyabet'], a: `Alerji ve özel beslenme isteklerini formdaki <strong>Notlar</strong> alanına yazın; hangi seçeneklerin mümkün olduğunu ustamız telefonda söyleyecek. Burada söz veremem, çünkü ürüne göre değişiyor.`, chips: ['Sipariş talebi formu'] },
    { k: ['ödeme', 'odeme', 'kart', 'nakit', 'kapora', 'havale', 'iban'], a: `${SITE_FACTS.payment} Özel siparişlerde kapora ve ödeme şeklini ustamız telefonda anlatıyor.`, chips: ['Özel pasta yaptırmak istiyorum'] },
    { k: ['instagram', 'insta', 'foto', 'örnek', 'ornek', 'model', 'galeri', 'vitrin'], a: `Örnek pastalarımız <a href="#galeri" data-chat-go>galeride</a> ve <a href="${SITE_FACTS.instagram}" target="_blank" rel="noopener">Instagram</a>'da. Beğendiğinizin fotoğrafını forma ekleyin, aynısını ya da benzerini konuşalım.`, chips: ['Sipariş talebi formu'] },
    { k: ['wifi', 'wi-fi', 'internet', 'otur', 'masa', 'kahvaltı', 'kahvalti', 'çay', 'cay', 'kahve'], a: `Dükkânda oturup çay ve kahve eşliğinde taze ürünlerimizi yiyebilirsiniz. ${SITE_FACTS.wifi}`, chips: ['Adres', 'Çalışma saatleri'] },
    { k: ['merhaba', 'selam', 'iyi günler', 'iyi gunler', 'kolay gelsin', 'nasılsın', 'nasilsin', 'hey'], a: `Merhaba, hoş geldiniz! Ferhat Patisserie'nin asistanıyım. Saatler, adres, menü ya da özel pasta siparişi… ne öğrenmek istersiniz?`, chips: ['Çalışma saatleri', 'Özel pasta yaptırmak istiyorum', 'Adres'] },
    { k: ['teşekkür', 'tesekkur', 'sağol', 'sagol', 'eyvallah', 'tamam', 'ok'], a: `Rica ederim! Bir şey daha sormak isterseniz buradayım. Afiyet olsun.`, chips: ['Sipariş talebi formu'] }
  ];
  const FALLBACK = `Bunu tam anlayamadım. Saatler, adres, menü, teslimat ve özel pasta siparişi konusunda yardımcı olabilirim. Farklı bir sorunuz varsa bizi arayın: ${CALL_LINK} — ya da ${FORM_LINK}'nu doldurun, biz sizi arayalım.`;
  const FALLBACK_CHIPS = ['Çalışma saatleri', 'Adres', 'Özel pasta yaptırmak istiyorum'];

  const norm = s => String(s).toLocaleLowerCase('tr').replace(/[İI]/g, 'i').replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ç/g, 'c').replace(/ö/g, 'o').replace(/ü/g, 'u');
  // Keyword must start a word ("ara" matches "arayın", not "para"). Price rule is checked first:
  // a money question must never fall into another rule and get a non-answer.
  const PRICE_RULE = RULES.find(r => r.k.includes('fiyat'));
  function hits(rule, t) {
    return rule.k.some(k => {
      const kw = norm(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9])' + kw).test(t);
    });
  }
  function answer(text) {
    const t = norm(text);
    if (norm('Sipariş talebi formu') === t.trim()) return { a: `Buyurun, form aşağıda: ${FORM_LINK}. Bir dakikanızı alır; fotoğraf eklemeyi unutmayın.`, chips: [] };
    if (hits(PRICE_RULE, t)) return PRICE_RULE;
    for (const r of RULES) {
      if (hits(r, t)) return r;
    }
    return { a: FALLBACK, chips: FALLBACK_CHIPS };
  }

  // ── DOM ──
  const launch = document.createElement('button');
  launch.type = 'button'; launch.className = 'chat-launch'; launch.setAttribute('aria-label', 'Asistan ile sohbet');
  launch.innerHTML = '<span class="chat-launch-avatar">F</span><span>Soru sorun</span>';

  const panel = document.createElement('div');
  panel.className = 'chat-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Ferhat Patisserie asistanı');
  panel.innerHTML =
    '<div class="chat-head">' +
      '<span class="chat-launch-avatar">F</span>' +
      '<div><div class="chat-head-title">Ferhat Asistan</div><div class="chat-head-sub">Hemen cevap verir</div></div>' +
      '<button type="button" class="chat-close" aria-label="Kapat">×</button>' +
    '</div>' +
    '<div class="chat-body" aria-live="polite"></div>' +
    '<div class="chat-chips"></div>' +
    '<form class="chat-input"><input type="text" name="q" placeholder="Sorunuzu yazın…" autocomplete="off" maxlength="200" aria-label="Sorunuz"><button type="submit" aria-label="Gönder"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg></button></form>' +
    '<div class="chat-foot">Asistan fiyat vermez ve kişisel bilgi istemez. Sipariş için formu kullanın.</div>';

  document.body.append(launch, panel);
  const body = panel.querySelector('.chat-body');
  const chips = panel.querySelector('.chat-chips');
  const form = panel.querySelector('.chat-input');
  const input = form.querySelector('input');

  function addMsg(html, who) {
    const m = document.createElement('div'); m.className = 'msg msg--' + who;
    if (who === 'user') m.textContent = html; else m.innerHTML = html;
    body.appendChild(m); body.scrollTop = body.scrollHeight;
    return m;
  }
  function setChips(list) {
    chips.innerHTML = '';
    (list || []).forEach(c => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = c;
      b.addEventListener('click', () => ask(c));
      chips.appendChild(b);
    });
  }
  let busy = false;
  function ask(q) {
    if (busy || !q.trim()) return;
    busy = true;
    addMsg(q, 'user'); setChips([]);
    const typing = addMsg('<i></i><i></i><i></i>', 'bot'); typing.classList.add('msg--typing');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => {
      typing.remove();
      const r = answer(q);
      addMsg(r.a, 'bot'); setChips(r.chips);
      busy = false;
    }, reduce ? 50 : 500 + Math.min(900, q.length * 25));
  }

  let opened = false;
  function open() {
    panel.hidden = false; launch.hidden = true;
    launch.classList.add('chat-launch--ready'); // entrance animation must not replay on re-show
    if (!opened) {
      opened = true;
      addMsg('Merhaba! Ben Ferhat Patisserie asistanıyım. Saatler, adres, menü ya da özel pasta siparişi hakkında sorabilirsiniz.', 'bot');
      setChips(['Çalışma saatleri', 'Özel pasta yaptırmak istiyorum', 'Teslimat var mı?']);
    }
    setTimeout(() => input.focus(), 50);
  }
  function close() { panel.hidden = true; launch.hidden = false; launch.focus(); }

  launch.addEventListener('click', open);
  panel.querySelector('.chat-close').addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) close(); });
  form.addEventListener('submit', e => { e.preventDefault(); const q = input.value; input.value = ''; ask(q); });
  body.addEventListener('click', e => {
    const a = e.target.closest('a[data-chat-go]');
    if (a) { close(); }
  });
})();
