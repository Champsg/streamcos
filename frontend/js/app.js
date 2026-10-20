(function() {
  "use strict";

  // Backend origin. Resolution order:
  //   1. window.STREAMCOS_CONFIG.apiBase from runtime-config.js (generated automatically by start.js)
  //   2. a URL manually saved from the in-app "PC Backend" dialog (localStorage)
  //   3. same origin — correct whenever the backend itself serves this page
  var runtimeCfg = window.STREAMCOS_CONFIG || {};
  var runtimeApi = String(runtimeCfg.apiBase || '').replace(/\/+$/, '');
  var customApi = localStorage.getItem('sc_api_base');
  var API_BASE = runtimeApi || (customApi ? customApi.replace(/\/+$/, '') : '');

  if (!API_BASE && window.location.protocol === 'file:') {
    API_BASE = 'http://localhost:5000';
  }

  var authToken = localStorage.getItem('sc_token') || null;
  var ownerToken = sessionStorage.getItem('sc_owner_token') || null;

  var store = {
    get: function(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e) { return d; } },
    set: function(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {} },
    del: function(k) { try { localStorage.removeItem(k); } catch(e) {} }
  };

  var K = { cat: "sv_catalog", users: "sv_users", sess: "sv_session", owns: "sv_owns", prog: "sv_progress", sales: "sv_sales", pin: "sv_owner_pin", pass: "sv_pass" };

  var GB = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/";
  var SEED = [
    { id: "sintel", title: "Sintel", year: 2010, mins: 15, rating: "8.1", quality: "4K", category: "Fantasy",
      price: 299, oldPrice: 499, views: 18400, featured: true, published: true,
      poster: "assets/poster-sintel.jpg", video: GB + "Sintel.mp4",
      desc: "A lonely young wanderer crosses a frozen wasteland searching for Scales, the baby dragon she once rescued and lost. Colin Levy's wordless fantasy about love, obsession and letting go." },
    { id: "tears-of-steel", title: "Tears of Steel", year: 2012, mins: 12, rating: "7.4", quality: "HD", category: "Sci-Fi",
      price: 249, oldPrice: 399, views: 15200, featured: false, published: true,
      poster: "assets/poster-tears-of-steel.jpg", video: GB + "TearsOfSteel.mp4",
      desc: "Forty years after giant machines tore Amsterdam apart, a group of scientists and robots restages the day it all went wrong — hoping a perfect re-enactment can rewrite the past." },
    { id: "spring", title: "Spring", year: 2019, mins: 8, rating: "7.9", quality: "4K", category: "Fantasy",
      price: 199, oldPrice: 299, views: 12800, featured: false, published: true,
      poster: "assets/poster-spring.jpg", video: GB + "Sintel.mp4",
      desc: "High in the mountains, a shepherd girl and her loyal dog must face the ancient spirits of the forest to coax the season back to life." },
    { id: "agent-327", title: "Agent 327: Operation Barbershop", year: 2017, mins: 4, rating: "7.8", quality: "HD", category: "Comedy",
      price: 149, oldPrice: 249, views: 9700, featured: false, published: true,
      poster: "assets/poster-agent-327.jpg", video: GB + "ForBiggerFun.mp4",
      desc: "Hendrik IJzerbroot — Agent 327, Holland's most accident-prone secret agent — pops into a barbershop for a quick trim and walks straight into a trap." },
    { id: "big-buck-bunny", title: "Big Buck Bunny", year: 2008, mins: 10, rating: "7.6", quality: "HD", category: "Family",
      price: 0, oldPrice: 0, views: 22100, featured: false, published: true,
      poster: "assets/poster-big-buck-bunny.jpg", video: GB + "BigBuckBunny.mp4",
      desc: "The gentle giant of the forest loves butterflies, berries and quiet mornings — until three bullying rodents push him one prank too far. Free for everyone, forever." },
    { id: "elephants-dream", title: "Elephants Dream", year: 2006, mins: 11, rating: "6.9", quality: "HD", category: "Sci-Fi",
      price: 179, oldPrice: 279, views: 6400, featured: false, published: true,
      poster: "assets/poster-elephants-dream.jpg", video: GB + "ElephantsDream.mp4",
      desc: "Inside an infinite, ever-shifting Machine, the elder Proog tries to open young Emo's eyes to its wonders — but Emo begins to doubt everything he is shown." }
  ];

  var catalog = store.get(K.cat, SEED);
  var session = store.get(K.sess, null); // user object or null
  var owns = store.get(K.owns, []);
  var passHolders = store.get(K.pass, false);
  var progress = store.get(K.prog, {});
  var sales = store.get(K.sales, []);
  var ownerPin = store.get(K.pin, null);
  // Amount comes from the merchant QR (₹99.99) — the server is the source of truth.
  var PASS_PRICE = 99.99;
  var ownerUnlocked = false;
  var paymentConfig = { vpa: "", payeeName: "", amount: "99.99", qrImage: null };
  var PAY_LINKS = null;

  var state = { tab: "home", cat: "All", query: "", detailId: null, payId: null, payOrder: null, authMode: "in", authNext: null, editingId: null, pinBuffer: "", pinStep: "enter", pinNew: "" };

  function applyPaymentConfig(cfg, links) {
    if (cfg) {
      paymentConfig = cfg;
      var amt = Number(cfg.amount);
      if (isFinite(amt) && amt > 0) PASS_PRICE = amt;
    }
    if (links) PAY_LINKS = links;
  }

  async function loadPaymentConfig() {
    try {
      var res = await api('/api/payment/config');
      if (res) applyPaymentConfig(res.config, res.links);
    } catch (e) {}
  }

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function inr(n) { return "₹" + Number(n || 0).toLocaleString("en-IN"); }
  function mediaUrl(url) {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url;
    if (url.startsWith('/uploads/')) {
      return (API_BASE ? API_BASE : '') + url;
    }
    return url;
  }
  function byId(id) { for (var i = 0; i < catalog.length; i++) if (catalog[i].id === id) return catalog[i]; return null; }
  function hasPass() { return !!passHolders; }
  function isOwned(id) { var v = byId(id); if (v && v.price === 0) return true; if (!session) return false; if (passHolders) return true; return owns.indexOf(id) >= 0; }
  function toast(msg) { var t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(function() { t.classList.remove("on"); }, 2600); }

  async function api(path, options) {
    options = options || {};
    var url = (path.startsWith('http') ? path : (API_BASE + path));
    var headers = Object.assign({
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
      'Bypass-Tunnel-Reminder': 'true'
    }, options.headers || {});
    if (ownerToken) {
      headers['Authorization'] = 'Bearer ' + ownerToken;
    } else if (authToken) {
      headers['Authorization'] = 'Bearer ' + authToken;
    }
    try {
      var res = await fetch(url, {
        ...options,
        headers: headers
      });
      var data = await res.json().catch(function() { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server error ' + res.status);
      return data;
    } catch (err) {
      console.warn('API error (' + path + '):', err.message);
      throw err;
    }
  }

  async function syncCatalog() {
    try {
      var res = await api('/api/catalog');
      if (res && res.catalog && res.catalog.length) {
        catalog = res.catalog;
        store.set(K.cat, catalog);
        renderHome();
        if (state.tab === "library") renderLibrary();
      }
    } catch (e) {}
  }

  async function syncUserData() {
    if (!authToken) {
      owns = [];
      passHolders = false;
      progress = {};
      session = null;
      store.del(K.sess);
      renderHeader();
      renderHome();
      renderLibrary();
      return;
    }
    try {
      var res = await api('/api/user/data');
      if (res) {
        owns = res.owns || [];
        passHolders = !!res.hasPass;
        progress = res.progress || {};
        store.set(K.owns, owns);
        store.set(K.pass, passHolders);
        store.set(K.prog, progress);
        renderHome();
        renderLibrary();
        renderAccount();
      }
    } catch (e) {
      if (e.message && e.message.includes('401')) {
        authToken = null;
        localStorage.removeItem('sc_token');
        session = null;
        store.del(K.sess);
        renderHeader();
        renderHome();
        renderLibrary();
      }
    }
  }

  var ICON = {
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.6"><path d="m4.5 12.5 5 5 10-11"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
    playSm: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor;"><path d="M8 5.5v13l11-6.5z"/></svg>'
  };

  /* ============ header / tabs ============ */
  function renderHeader() {
    var b = $("#hdrAvatar");
    if (session && session.name) {
      b.textContent = session.name.trim().charAt(0).toUpperCase();
    } else {
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"/></svg>';
    }
  }

  function goto(tab) {
    state.tab = tab;
    $$(".view").forEach(function(v) { v.classList.remove("on"); });
    $("#view-" + tab).classList.add("on");
    $$("#tabBar button").forEach(function(b) { b.classList.toggle("on", b.dataset.tab === tab); });
    window.scrollTo(0, 0);
    if (tab === "library") renderLibrary();
    if (tab === "account") renderAccount();
    if (tab === "admin") renderAdmin();
    if (tab === "home") renderHome();
  }

  /* ============ home ============ */
  function liveCatalog() { return catalog.filter(function(v) { return v.published; }); }

  function renderHome() {
    renderHero(); renderPassBanner(); renderTrending(); renderCats(); renderGrid();
  }

  function renderPassBanner() {
    var slot = $("#passSlot"); if (!slot) return;
    if (hasPass()) {
      slot.innerHTML = '<div class="passbar active"><div style="flex:1; min-width:0;"><h3>All-Access Pass active</h3><p>Every film on StreamCos is unlocked for you. Happy watching!</p></div><span class="chip" style="background:rgba(47,206,110,.2); color:var(--green); border:1px solid rgba(47,206,110,.5);">Unlocked</span></div>';
    } else {
      slot.innerHTML = '<div class="passbar"><div style="flex:1; min-width:0;"><h3>StreamCos All-Access</h3><p>One payment of ₹99.99 unlocks every film — no per-film prices, no subscription.</p></div><button class="btn goldb sm" data-buy="pass">Get pass · ₹99.99</button></div>';
    }
  }

  function renderHero() {
    var f = liveCatalog().filter(function(v) { return v.featured; })[0] || liveCatalog()[0];
    var slot = $("#heroSlot");
    if (!f) { slot.innerHTML = ""; return; }
    var owned = isOwned(f.id);
    slot.innerHTML =
      '<article class="hero">' +
        '<img src="' + esc(mediaUrl(f.poster)) + '" alt="' + esc(f.title) + ' poster" />' +
        '<div class="shade"></div>' +
        '<div class="hbody">' +
          '<div class="chiprow"><span class="chip hot">Featured premiere</span><span class="chip">' + esc(f.quality) + ' · Dolby sound</span></div>' +
          '<h1>' + esc(f.title) + '</h1>' +
          '<p>' + esc(f.desc) + '</p>' +
          '<div class="meta"><span class="star">★ ' + esc(f.rating) + '</span><span class="dot"></span><span>' + f.year + '</span><span class="dot"></span><span>' + f.mins + ' min</span><span class="dot"></span><span>' + esc(f.category) + '</span><span class="q">' + esc(f.quality) + '</span></div>' +
          '<div class="btnrow">' +
            (owned
              ? '<button class="btn acc" data-watch="' + f.id + '">' + ICON.playSm + ' Watch now</button>'
              : '<button class="btn acc" data-buy="pass">Unlock all · ' + inr(PASS_PRICE) + '</button>') +
            '<button class="btn glass" data-open="' + f.id + '">Details</button>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function renderTrending() {
    var list = liveCatalog().slice().sort(function(a, b) { return b.views - a.views; }).slice(0, 5);
    $("#trendRail").innerHTML = list.map(function(v, i) {
      var owned = isOwned(v.id);
      return '<article class="trend-card" data-open="' + v.id + '">' +
        '<div class="thumb"><img src="' + esc(mediaUrl(v.poster)) + '" alt="' + esc(v.title) + ' poster" loading="lazy" />' +
          '<span class="rank">' + (i + 1) + '</span>' +
          (v.price === 0 ? '<span class="pricetag free">FREE</span>' : (owned ? '' : '<span class="pricetag pass">PASS</span>')) +
          '<span class="locktag' + (owned ? ' open' : '') + '">' + (owned ? ICON.check : ICON.lock) + '</span>' +
        '</div>' +
        '<h3>' + esc(v.title) + '</h3>' +
        '<div class="sub"><span>★ ' + esc(v.rating) + '</span><span>' + esc(v.category) + '</span><span>' + v.mins + ' min</span></div>' +
      '</article>';
    }).join("");
  }

  function renderCats() {
    var cats = ["All"];
    liveCatalog().forEach(function(v) { if (cats.indexOf(v.category) < 0) cats.push(v.category); });
    if (cats.indexOf(state.cat) < 0) state.cat = "All";
    $("#catRow").innerHTML = cats.map(function(c) {
      return '<button class="cat' + (c === state.cat ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join("");
  }

  function renderGrid() {
    var q = state.query.trim().toLowerCase();
    var list = liveCatalog().filter(function(v) {
      var okCat = state.cat === "All" || v.category === state.cat;
      var okQ = !q || v.title.toLowerCase().indexOf(q) >= 0 || v.category.toLowerCase().indexOf(q) >= 0;
      return okCat && okQ;
    });
    $("#browseCount").textContent = list.length + (list.length === 1 ? " film" : " films");
    $("#noResults").classList.toggle("hidden", list.length > 0);
    $("#browseGrid").innerHTML = list.map(function(v) {
      var owned = isOwned(v.id);
      return '<article class="pcard" data-open="' + v.id + '">' +
        '<div class="pimg"><img src="' + esc(mediaUrl(v.poster)) + '" alt="' + esc(v.title) + ' poster" loading="lazy" onerror="this.style.display=\'none\';this.parentNode.insertAdjacentHTML(\'beforeend\',\'<div class=&quot;tile-fallback&quot;>' + esc(v.title) + '</div>\')" />' +
          (v.price === 0 ? '<span class="pricetag free">FREE</span>' : (owned ? '' : '<span class="pricetag pass">PASS</span>')) +
        '</div>' +
        '<h3>' + esc(v.title) + '</h3>' +
        '<div class="sub"><span>' + v.year + ' · ' + esc(v.category) + '</span>' + (owned ? '<span class="owned-lbl">Owned</span>' : '<b>★ ' + esc(v.rating) + '</b>') + '</div>' +
      '</article>';
    }).join("");
  }

  /* ============ sheets ============ */
  function openSheet(el) { $("#scrim").classList.add("on"); el.classList.add("on"); document.body.style.overflow = "hidden"; }
  function closeSheets() {
    stopPayTimers();
    $("#scrim").classList.remove("on");
    $$(".sheet").forEach(function(s) { s.classList.remove("on"); });
    document.body.style.overflow = "";
  }
  function metaRow(v) {
    return '<div class="meta"><span class="star">★ ' + esc(v.rating) + '</span><span class="dot"></span><span>' + v.year + '</span><span class="dot"></span><span>' + v.mins + ' min</span><span class="dot"></span><span>' + esc(v.category) + '</span><span class="q">' + esc(v.quality) + '</span></div>';
  }

  function openDetail(id) {
    var v = byId(id); if (!v) return;
    state.detailId = id;
    var owned = isOwned(id);
    var el = $("#detailSheet");
    el.innerHTML =
      '<div class="detail-hero"><img src="' + esc(mediaUrl(v.poster)) + '" alt="' + esc(v.title) + ' poster" /><div class="shade"></div>' +
        '<button class="sheet-x" data-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.2"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
      '<div class="detail-body">' +
        '<h2>' + esc(v.title) + '</h2>' + metaRow(v) +
        '<p class="desc">' + esc(v.desc) + '</p>' +
        '<div class="includes">' +
          '<div>' + ICON.check + ' Full film in ' + esc(v.quality) + ' — stream instantly, no downloads</div>' +
          '<div>' + ICON.check + ' Included in the All-Access Pass — one ₹99.99 payment unlocks every film</div>' +
          '<div>' + ICON.check + ' Watch on this phone any time you\'re signed in</div>' +
        '</div>' +
        (owned
          ? '<div class="btnrow"><button class="btn acc" data-watch="' + v.id + '">' + ICON.playSm + ' Watch now</button><button class="btn ghost" data-preview="' + v.id + '">Preview</button></div>'
          : '<div class="pricebox"><div><span class="amt">' + inr(PASS_PRICE) + '</span><div class="per">All-Access Pass · unlocks every film on StreamCos</div></div>' +
            '<span class="chip gold">One payment</span></div>' +
            '<div class="btnrow"><button class="btn acc" data-buy="pass">Unlock everything · ' + inr(PASS_PRICE) + '</button><button class="btn ghost" data-preview="' + v.id + '">▶ 45-sec preview</button></div>') +
      '</div>';
    openSheet(el);
  }

  /* ============ auth ============ */
  function openAuth(next) {
    state.authNext = next || null;
    renderAuth();
    openSheet($("#authSheet"));
  }

  function renderAuth() {
    var mode = state.authMode;
    $("#authSheet").innerHTML =
      '<div class="grab"></div>' +
      '<div style="padding:16px 20px calc(24px + env(safe-area-inset-bottom));">' +
        '<h2 style="margin:4px 0 6px; font-size:22px;">' + (mode === "in" ? "Welcome back" : "Create your account") + '</h2>' +
        '<p style="margin:0 0 16px; color:var(--mut); font-size:13.5px; line-height:1.55;">' + (mode === "in" ? "Sign in to watch the films in your library." : "One account for buying and watching.") + '</p>' +
        '<div class="form-err" id="authErr"></div>' +
        '<form class="form" id="authForm" style="padding:0;">' +
          (mode === "up" ? '<div class="fld"><label>Your name</label><input id="auName" type="text" placeholder="e.g. Aarav Shah" autocomplete="name" /></div>' : '') +
          '<div class="fld"><label>Email</label><input id="auEmail" type="email" placeholder="you@example.com" autocomplete="email" /></div>' +
          '<div class="fld"><label>Password</label><input id="auPass" type="password" placeholder="At least 4 characters" autocomplete="' + (mode === "in" ? "current-password" : "new-password") + '" /></div>' +
          '<button class="btn acc block" type="submit">' + (mode === "in" ? "Sign in" : "Create account") + '</button>' +
        '</form>' +
        '<p class="switch-line">' + (mode === "in" ? "New to StreamCos? " : "Already have an account? ") +
          '<button id="authSwitch">' + (mode === "in" ? "Create an account" : "Sign in") + '</button></p>' +
      '</div>';

    $("#authSwitch").addEventListener("click", function() { state.authMode = mode === "in" ? "up" : "in"; renderAuth(); });
    $("#authForm").addEventListener("submit", async function(e) {
      e.preventDefault();
      var email = $("#auEmail").value.trim().toLowerCase();
      var pass = $("#auPass").value;
      var err = $("#authErr");
      function fail(m) { err.textContent = m; err.classList.add("on"); }

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Please enter a valid email address.");
      if (pass.length < 4) return fail("Password needs at least 4 characters.");

      try {
        var userResult;
        if (state.authMode === "up") {
          var name = $("#auName").value.trim();
          if (!name) return fail("Please enter your name.");
          var reg = await api('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ name: name, email: email, pass: pass })
          });
          if (reg && reg.token) {
            authToken = reg.token;
            localStorage.setItem('sc_token', authToken);
          }
          userResult = reg.user;
        } else {
          var log = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: email, pass: pass })
          });
          if (log && log.token) {
            authToken = log.token;
            localStorage.setItem('sc_token', authToken);
          }
          userResult = log.user;
        }

        session = userResult;
        store.set(K.sess, session);
        await syncUserData();
        renderHeader();
        closeSheets();
        toast(state.authMode === "up" ? "Account created — welcome!" : "Signed in. Happy watching!");

        var nx = state.authNext;
        state.authNext = null;
        if (nx === "buy") startCheckout("pass");
        renderHome(); renderLibrary(); renderAccount();
      } catch (authErr) {
        fail(authErr.message || "Authentication failed");
      }
    });
  }

  /* ============ checkout · YouPI-style UPI ============ */
  var payPoll = null;

  function stopPayTimers() {
    if (payPoll) { clearInterval(payPoll); payPoll = null; }
    if (renderPay._timer) { clearInterval(renderPay._timer); renderPay._timer = null; }
  }

  function buyFlow(id) {
    if (hasPass()) { toast("Your All-Access Pass is already active — everything is unlocked."); return; }
    if (!session) { state.detailId = id; openAuth("buy"); return; }
    startCheckout("pass");
  }

  async function startCheckout(id) {
    if (id !== "pass" && !byId(id)) return;
    state.payId = id;
    state.payOrder = null;
    await loadPaymentConfig();
    renderPay("loading");
    openSheet($("#paySheet"));

    try {
      var res = await api('/api/pay/orders', { method: 'POST', body: JSON.stringify({ sku: 'pass' }) });
      applyPaymentConfig(res.config, res.links);
      state.payOrder = res.order;
      if (res.order && res.order.status === "PAID") return onPaymentConfirmed();
      renderPay("form");
    } catch (e) {
      renderPay("error", e.message || "Could not open the UPI checkout");
    }
  }

  /* Server is the source of truth: poll the order until it is PAID, so a
     webhook / owner approval unlocks the app without a page refresh. */
  function startPayPoll(orderId) {
    if (payPoll) clearInterval(payPoll);
    if (!orderId) return;
    payPoll = setInterval(async function () {
      try {
        var res = await api('/api/pay/orders/' + encodeURIComponent(orderId));
        if (!res || !res.order) return;
        state.payOrder = res.order;
        if (res.order.status === "PAID") { onPaymentConfirmed(); return; }
        if (res.order.status === "EXPIRED" || res.order.status === "CANCELLED" || res.order.status === "REJECTED") {
          clearInterval(payPoll); payPoll = null;
        }
      } catch (e) {
        if (String(e.message || "").indexOf("40") === 0 || String(e.message || "").indexOf("not found") >= 0) {
          clearInterval(payPoll); payPoll = null;
        }
      }
    }, 3000);
  }

  async function onPaymentConfirmed() {
    stopPayTimers();
    try { await syncUserData(); } catch (e) {}
    try { await loadPaymentConfig(); } catch (e) {}
    renderPay("done");
    renderHome(); renderLibrary(); renderAccount();
  }

  function renderPay(stage, msg) {
    var el = $("#paySheet");
    if (!el) return;
    var order = state.payOrder;
    var amount = order ? order.amount : Number(PASS_PRICE || 0).toFixed(2);
    var skuName = (order && order.skuName) || paymentConfig.skuName || "StreamCos All-Access Pass";

    if (stage !== "form" && stage !== "review") stopPayTimers();

    if (stage === "loading") {
      el.innerHTML = '<div class="grab"></div><div style="padding:34px 22px calc(40px + env(safe-area-inset-bottom)); text-align:center;">' +
        '<div class="spin"></div><h3 style="margin:0 0 6px;">Opening UPI checkout…</h3>' +
        '<p style="margin:0; color:var(--mut); font-size:13px;">Creating a secure payment session.</p></div>';
      return;
    }

    if (stage === "error") {
      el.innerHTML = '<div class="grab"></div><div style="padding:24px 22px calc(32px + env(safe-area-inset-bottom)); text-align:center;">' +
        '<h3 style="margin:0 0 8px;">Checkout unavailable</h3>' +
        '<p style="margin:0 0 18px; color:var(--mut); font-size:13.5px; line-height:1.6;">' + esc(msg || "Please try again.") + '</p>' +
        '<button class="btn acc block" data-refresh-pay>Try again</button>' +
        '<button class="btn ghost block" data-close style="margin-top:9px;">Close</button></div>';
      return;
    }

    if (stage === "processing") {
      el.innerHTML = '<div class="grab"></div><div style="padding:34px 22px calc(40px + env(safe-area-inset-bottom)); text-align:center;">' +
        '<div class="spin"></div><h3 style="margin:0 0 6px;">Verifying UPI payment…</h3>' +
        '<p style="margin:0; color:var(--mut); font-size:13.5px;">Matching your UTR against the ₹' + esc(amount) + ' payment.</p></div>';
      return;
    }

    if (stage === "review") {
      el.innerHTML = '<div class="grab"></div><div style="padding:24px 22px calc(32px + env(safe-area-inset-bottom)); text-align:center;">' +
        '<div class="success-ic" style="background:rgba(255,176,32,.14); color:var(--gold);">' + ICON.check + '</div>' +
        '<h3 style="margin:0 0 6px; font-size:20px;">Payment submitted</h3>' +
        '<p style="margin:0 0 6px; color:var(--mut); font-size:13.5px; line-height:1.6;">We recorded your reference <b style="color:#fff;">' + esc(order ? order.utr : "") + '</b>.<br/>The studio owner is confirming the credit; this page unlocks itself the moment it clears.</p>' +
        '<p style="margin:0 0 18px; font-size:11.5px; color:var(--dim);">Session ' + esc(order ? order.id : "") + '</p>' +
        '<button class="btn ghost block" data-close>Close — I\'ll check later</button></div>';
      if (order) startPayPoll(order.id);
      return;
    }

    if (stage === "done") {
      el.innerHTML = '<div class="grab"></div><div style="padding:18px 22px calc(72px + env(safe-area-inset-bottom)); text-align:center;">' +
        '<div class="success-ic">' + ICON.check + '</div>' +
        '<h3 style="margin:0 0 6px; font-size:20px;">Everything is unlocked!</h3>' +
        '<p style="margin:0 0 18px; color:var(--mut); font-size:13.5px; line-height:1.6;">Payment of ₹' + esc(amount) + ' received.<br/>Your All-Access Pass is active — every film on StreamCos is ready to stream.</p>' +
        '<button class="btn acc block" data-close>Start watching</button></div>';
      return;
    }

    /* ---- form: the fixed merchant QR + UTR claim ---- */
    var qr = paymentConfig.qrImage ? mediaUrl(paymentConfig.qrImage) : null;
    var links = PAY_LINKS || {};
    var payee = paymentConfig.payeeName || "";
    var vpa = paymentConfig.vpa || "";
    var expired = !order || Number(order.expiresAt) <= Date.now();
    var appBtn = function (href, cls, label, txt) {
      return '<a href="' + esc(href || "#") + '" class="upi-app-btn" target="_blank" rel="noopener"><div class="u-icon ' + cls + '">' + label + '</div><span>' + txt + '</span></a>';
    };

    el.innerHTML =
      '<div class="grab"></div>' +
      '<div style="padding:14px 20px calc(24px + env(safe-area-inset-bottom));">' +
        '<h2 style="margin:2px 0 12px; font-size:20px; font-family:\'Sora\'; font-weight:800;">UPI Checkout</h2>' +
        '<div class="order-line"><img src="assets/poster-sintel.jpg" alt="" /><div><h4>' + esc(skuName) + '</h4><p>Unlocks every film · yours forever</p></div><span class="amt">₹' + esc(amount) + '</span></div>' +
        '<div class="youpi-box">' +
          '<div class="youpi-badge">⚡ YouPI Gateway · 0% platform fee</div>' +
          '<div class="youpi-timer"><span class="pdot"></span><span id="upiTimer">' + (expired ? 'QR expired' : 'Valid for 05:00') + '</span></div>' +
          (msg ? '<div class="form-err on" style="margin:0 0 12px; text-align:left;">' + esc(msg) + '</div>' : '') +
          '<div class="upi-qr-card" id="youpiQrSlot">' +
            (qr ? '<img src="' + esc(qr) + '" alt="Scan to pay with any UPI app" />' : '') +
          '</div>' +
          (qr ? '' : '<p style="margin:0 0 10px; color:#ff9f43; font-size:12px; font-weight:700;">No payment QR configured — the studio owner must upload one.</p>') +
          '<p style="margin:0 0 10px; font-size:12px; color:var(--mut); line-height:1.5;">Scan with any UPI app and pay exactly <b style="color:#fff;">₹' + esc(amount) + '</b>' + (payee ? ' to <b style="color:#fff;">' + esc(payee) + '</b>' : '') + '.</p>' +
          '<div style="margin-top:2px;"><div class="upi-id-pill" id="copyUpiIdBtn" title="Click to copy UPI ID"><span id="upiPillTxt">' + esc(vpa) + '</span><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></div></div>' +
          '<div class="upi-apps-row">' +
            appBtn(links.gpay, 'u-gpay', 'G', 'GPay') +
            appBtn(links.phonepe, 'u-phonepe', 'Pe', 'PhonePe') +
            appBtn(links.paytm, 'u-paytm', 'Py', 'Paytm') +
            appBtn(links.upi, 'u-upi', '⚡', 'Any UPI') +
          '</div>' +
          '<div class="utr-section">' +
            '<label>Paid? Enter the 12-digit UPI Ref / UTR:</label>' +
            '<div class="utr-input-row">' +
              '<input type="text" id="utrInput" inputmode="numeric" maxlength="12" placeholder="e.g. 412356789012" autocomplete="off" />' +
              '<button class="btn acc sm" id="verifyUtrBtn">Verify</button>' +
            '</div>' +
            '<p style="margin:7px 0 0; font-size:11px; color:var(--mut); line-height:1.4;">Open your UPI app → transaction details → copy the 12-digit reference. The pass unlocks the moment it checks out.</p>' +
          '</div>' +
          (expired ? '<button class="btn ghost block" data-refresh-pay style="margin-top:12px;">This QR expired — get a fresh one</button>' : '') +
          '<p class="fineprint" style="margin-top:12px;">Direct bank settlement · NPCI UPI · YouPI self-hosted gateway</p>' +
        '</div>' +
      '</div>';

    var expiresAt = order ? Number(order.expiresAt) : Date.now() + 5 * 60 * 1000;
    clearInterval(renderPay._timer);
    renderPay._timer = setInterval(function () {
      var n = $("#upiTimer");
      if (!n) { clearInterval(renderPay._timer); return; }
      var left = Math.round((expiresAt - Date.now()) / 1000);
      if (left <= 0) { n.textContent = "QR expired"; return; }
      n.textContent = "Valid for " + ("0" + Math.floor(left / 60)).slice(-2) + ":" + ("0" + (left % 60)).slice(-2);
    }, 1000);

    var copyBtn = $("#copyUpiIdBtn");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(vpa);
        var ptxt = $("#upiPillTxt");
        if (ptxt) {
          var orig = ptxt.textContent;
          ptxt.textContent = "Copied!";
          setTimeout(function () { ptxt.textContent = orig; }, 1500);
        }
        toast("UPI ID copied: " + vpa);
      });
    }

    var doVerify = function () {
      var inp = $("#utrInput");
      var utr = (inp ? inp.value : "").replace(/\D/g, "");
      if (!/^\d{12}$/.test(utr)) {
        toast("Enter the 12-digit UPI reference from your receipt");
        if (inp) inp.focus();
        return;
      }
      submitUtr(utr);
    };
    var verifyBtn = $("#verifyUtrBtn");
    if (verifyBtn) verifyBtn.addEventListener("click", doVerify);
    var utrInp = $("#utrInput");
    if (utrInp) utrInp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doVerify(); } });

    if (order && order.status === "AWAITING_REVIEW") return renderPay("review");
    if (order) startPayPoll(order.id);
  }

  async function submitUtr(utr) {
    var order = state.payOrder;
    if (!order) return;
    renderPay("processing");
    try {
      var res = await api('/api/pay/orders/' + encodeURIComponent(order.id) + '/claim', {
        method: 'POST',
        body: JSON.stringify({ utr: utr })
      });
      if (res.order) state.payOrder = res.order;
      if (res.hasPass) { passHolders = true; store.set(K.pass, true); }
      if (res.order && res.order.status === "PAID") { onPaymentConfirmed(); return; }
      renderPay("review");
    } catch (e) {
      toast(e.message || "Could not verify that reference");
      renderPay("form", e.message || "Could not verify that reference");
    }
  }

  /* ============ player ============ */
  var playerCtx = { id: null, preview: false };
  var hlsInstance = null;
  var plyrInstance = null;

  function initPlyr(el, qualities, onQualityChange) {
    if (window.Plyr) {
      var controls = [
        'play-large',
        'restart',
        'rewind',
        'play',
        'fast-forward',
        'progress',
        'current-time',
        'duration',
        'mute',
        'volume',
        'settings',
        'pip',
        'airplay',
        'fullscreen'
      ];
      var settings = ['speed'];
      var qualityConfig = undefined;
      if (qualities && qualities.length > 1) {
        settings.unshift('quality');
        qualityConfig = {
          default: 0,
          options: qualities,
          forced: true,
          onChange: onQualityChange
        };
      }
      try {
        plyrInstance = new Plyr(el, {
          controls: controls,
          settings: settings,
          quality: qualityConfig,
          speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
          seekTime: 10,
          keyboard: { focused: true, global: true },
          tooltips: { controls: true, seek: true }
        });
        return plyrInstance;
      } catch (err) {
        console.warn('Plyr init error:', err);
      }
    }
    return null;
  }

  async function openPlayer(id, preview) {
    var v = byId(id); if (!v) return;
    closeSheets();
    if (plyrInstance) { try { plyrInstance.destroy(); } catch (e) {} plyrInstance = null; }
    if (hlsInstance) { try { hlsInstance.destroy(); } catch (e) {} hlsInstance = null; }
    playerCtx = { id: id, preview: !!preview };
    $("#playerTitle").textContent = v.title;
    $("#playerMode").textContent = preview ? "Preview · 45s left" : "Authorizing...";
    $("#previewEnd").classList.remove("on");

    var el = $("#videoEl");
    if (el) {
      el.pause();
      el.currentTime = 0;
    }

    var videoSrc = v.video || '';
    var activePlayToken = null;
    var previewSeconds = 45;

    try {
      var tokenRes = await api('/api/player/token', {
        method: 'POST',
        body: JSON.stringify({ videoId: id, isPreview: !!preview })
      });
      if (tokenRes && tokenRes.playToken) {
        activePlayToken = tokenRes.playToken;
        // The server owns preview URLs: it hands back a separate short clip,
        // never the full stream.
        if (tokenRes.videoUrl) videoSrc = tokenRes.videoUrl;
        if (tokenRes.previewSeconds) previewSeconds = tokenRes.previewSeconds;
        if (videoSrc.startsWith('/uploads/') || (API_BASE && videoSrc.startsWith(API_BASE))) {
          videoSrc = (videoSrc.startsWith('http') ? videoSrc : (API_BASE + videoSrc));
          videoSrc += (videoSrc.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tokenRes.playToken);
        }
      }
    } catch (err) {
      if (preview) {
        toast(err.message || 'Preview is not available for this title');
        return;
      }
      toast(err.message || 'Pass required to stream');
      buyFlow(id);
      return;
    }

    playerCtx.previewSeconds = previewSeconds;

    if (videoSrc.startsWith('/uploads/')) {
      videoSrc = (API_BASE ? API_BASE : '') + videoSrc;
    }

    // Hovod HLS adaptive bitrate streaming
    if (videoSrc.includes('.m3u8')) {
      if (window.Hls && Hls.isSupported()) {
        hlsInstance = new Hls({
          enableWorker: true,
          xhrSetup: function(xhr, url) {
            xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');
            xhr.setRequestHeader('Bypass-Tunnel-Reminder', 'true');
            if (activePlayToken) {
              xhr.setRequestHeader('Authorization', 'Bearer ' + activePlayToken);
            } else if (session && session.token) {
              xhr.setRequestHeader('Authorization', 'Bearer ' + session.token);
            }
          }
        });
        hlsInstance.on(Hls.Events.ERROR, function(event, data) {
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hlsInstance.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hlsInstance.recoverMediaError();
            } else {
              hlsInstance.destroy();
            }
          }
        });
        hlsInstance.loadSource(videoSrc);
        hlsInstance.attachMedia(el);

        hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
          var levels = (hlsInstance.levels || []).map(function(l) { return l.height; }).filter(Boolean);
          var uniqueLevels = levels.filter(function(v, i, a) { return a.indexOf(v) === i; }).sort(function(a, b) { return b - a; });
          uniqueLevels.unshift(0); // Auto

          initPlyr(el, uniqueLevels, function(newQuality) {
            if (newQuality === 0) {
              hlsInstance.currentLevel = -1; // Auto
            } else {
              hlsInstance.levels.forEach(function(lvl, idx) {
                if (lvl.height === newQuality) hlsInstance.currentLevel = idx;
              });
            }
          });

          var saved = session && progress[id];
          if (!preview && saved && saved.t > 5 && saved.d && saved.t < saved.d * 0.95) {
            el.currentTime = saved.t;
          }
          if (plyrInstance) plyrInstance.play().catch(function() {});
          else el.play().catch(function() {});
        });
        $("#playerMode").textContent = preview ? "Preview · 45s left" : "⚡ Adaptive HLS";
      } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
        el.src = videoSrc;
        initPlyr(el);
        var saved = session && progress[id];
        if (!preview && saved && saved.t > 5 && saved.d && saved.t < saved.d * 0.95) { el.currentTime = saved.t; }
        if (plyrInstance) plyrInstance.play().catch(function() {});
        else el.play().catch(function() {});
        $("#playerMode").textContent = preview ? "Preview · 45s left" : "HLS Stream";
      } else {
        el.src = videoSrc;
        initPlyr(el);
        if (plyrInstance) plyrInstance.play().catch(function() {});
        else el.play().catch(function() {});
      }
    } else {
      el.src = videoSrc;
      initPlyr(el);
      var saved = session && progress[id];
      if (!preview && saved && saved.t > 5 && saved.d && saved.t < saved.d * 0.95) { el.currentTime = saved.t; }
      if (plyrInstance) plyrInstance.play().catch(function() {});
      else el.play().catch(function() {});
      $("#playerMode").textContent = preview ? "Preview · 45s left" : "HD Stream";
    }

    $("#player").classList.add("on");
    document.body.style.overflow = "hidden";
  }

  function closePlayer() {
    var el = $("#videoEl");
    saveProgress();
    if (plyrInstance) { try { plyrInstance.destroy(); } catch (e) {} plyrInstance = null; }
    if (hlsInstance) { try { hlsInstance.destroy(); } catch (e) {} hlsInstance = null; }
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.currentTime = 0;
      el.load();
    }
    $("#previewEnd").classList.remove("on");
    $("#player").classList.remove("on");
    document.body.style.overflow = "";
    renderLibrary();
  }

  async function saveProgress() {
    if (!session || playerCtx.preview) return;
    var el = $("#videoEl");
    if (!el || !el.duration) return;
    progress[playerCtx.id] = { t: el.currentTime, d: el.duration };
    store.set(K.prog, progress);
    try {
      await api('/api/progress', {
        method: 'POST',
        body: JSON.stringify({ email: session.email, videoId: playerCtx.id, t: el.currentTime, d: el.duration })
      });
    } catch (e) {}
  }

  $("#videoEl").addEventListener("timeupdate", function() {
    var el = this;
    if (playerCtx.preview) {
      var limit = playerCtx.previewSeconds || 45;
      var remaining = Math.max(0, Math.ceil(limit - el.currentTime));
      $("#playerMode").textContent = "Preview · " + remaining + "s left";
      if (el.currentTime >= limit) {
        el.currentTime = limit;
        el.pause();
        $("#previewEnd").classList.add("on");
      }
    }
  });

  $("#videoEl").addEventListener("seeking", function() {
    var el = this;
    var limit = playerCtx.previewSeconds || 45;
    if (playerCtx.preview && el.currentTime > limit) {
      el.currentTime = limit;
      el.pause();
      $("#previewEnd").classList.add("on");
    }
  });

  $("#videoEl").addEventListener("pause", saveProgress);
  $("#playerClose").addEventListener("click", closePlayer);
  $("#previewBuyBtn").addEventListener("click", function() { closePlayer(); buyFlow("pass"); });
  $("#previewReplayBtn").addEventListener("click", function() {
    var el = $("#videoEl");
    $("#previewEnd").classList.remove("on");
    if (el) {
      el.currentTime = 0;
      if (plyrInstance) plyrInstance.play().catch(function() {});
      else el.play().catch(function() {});
    }
  });

  /* ============ library ============ */
  function renderLibrary() {
    var list = $("#libList"), empty = $("#libEmpty");
    if (!session) {
      list.innerHTML = ""; empty.classList.remove("hidden");
      $("#continueSlot").innerHTML = "";
      $("#libSub").textContent = "Sign in to see the films you own.";
      $("#libEmptyTxt").textContent = "Sign in to see your films — purchases are saved to your account.";
      empty.querySelector("button").textContent = "Sign in";
      empty.querySelector("button").dataset.act = "signin";
      return;
    }
    empty.querySelector("button").textContent = "Browse films";
    empty.querySelector("button").dataset.act = "browse";
    $("#libEmptyTxt").textContent = "Get the ₹99.99 All-Access Pass and every film is yours — watch any time, right here.";

    var mine = (owns || []).map(byId).filter(Boolean);
    if (hasPass()) catalog.forEach(function(v) { if (v.published && mine.indexOf(v) < 0) mine.push(v); });
    catalog.forEach(function(v) { if (v.price === 0 && v.published && mine.indexOf(v) < 0) mine.push(v); });
    $("#libSub").textContent = hasPass() ? "All-Access Pass active — every film is unlocked for you." : (mine.length ? mine.length + (mine.length === 1 ? " film" : " films") + " in your library · yours forever" : "Films you own live here.");
    empty.classList.toggle("hidden", mine.length > 0);

    var cont = [];
    Object.keys(progress || {}).forEach(function(id) {
      var p = progress[id];
      if (p.d && p.t > 5 && p.t < p.d * 0.95) {
        var v = byId(id);
        if (v && isOwned(id)) cont.push({ v: v, pct: Math.round(p.t / p.d * 100) });
      }
    });

    $("#continueSlot").innerHTML = cont.length ?
      '<div class="sec" style="margin-top:20px;"><div class="sec-head"><h2>Continue watching</h2></div><div class="rail">' +
      cont.map(function(c) {
        return '<article class="trend-card" data-watch="' + c.v.id + '"><div class="thumb"><img src="' + esc(mediaUrl(c.v.poster)) + '" alt="' + esc(c.v.title) + ' poster" /><span class="locktag open">' + ICON.play + '</span></div>' +
          '<h3>' + esc(c.v.title) + '</h3><div class="prog" style="max-width:190px;"><i style="width:' + c.pct + '%"></i></div><div class="sub" style="margin-top:5px;"><span>' + c.pct + '% watched</span></div></article>';
      }).join("") + '</div></div>' : "";

    list.innerHTML = mine.map(function(v) {
      var p = progress[v.id]; var pct = p && p.d ? Math.min(100, Math.round(p.t / p.d * 100)) : 0;
      return '<article class="lib-item" data-watch="' + v.id + '"><img src="' + esc(mediaUrl(v.poster)) + '" alt="' + esc(v.title) + ' poster" />' +
        '<div class="li-body"><h3>' + esc(v.title) + '</h3><div class="sub">' + v.year + ' · ' + esc(v.category) + ' · ' + v.mins + ' min · ' + esc(v.quality) + '</div>' +
        (pct > 0 && pct < 100 ? '<div class="prog"><i style="width:' + pct + '%"></i></div>' : '<div class="sub" style="margin-top:6px; color:var(--green); font-weight:800;">' + (pct >= 100 ? "Watched · watch again" : "Ready to watch") + '</div>') +
        '</div><span class="play-fab">' + ICON.play + '</span></article>';
    }).join("");
  }

  /* ============ account ============ */
  function renderAccount() {
    var slot = $("#accountSlot");
    var u = session;
    if (!u) {
      slot.innerHTML =
        '<div class="page-head"><h1>Account</h1><p>Sign in to buy films and build your library.</p></div>' +
        '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"/></svg>' +
        '<h3>You\'re browsing as a guest</h3><p>Guests can browse and preview every film. Create a free account to buy and keep films in your library.</p>' +
        '<button class="btn acc sm" id="accSignIn">Sign in / Create account</button></div>' +
        ownerCardHtml();
      var b = $("#accSignIn"); if (b) b.addEventListener("click", function() { openAuth(null); });
      bindOwnerCard();
      return;
    }
    var mine = hasPass() ? liveCatalog().length : (owns || []).length;
    var mins = 0; Object.keys(progress || {}).forEach(function(k) { mins += (progress[k].t || 0) / 60; });
    slot.innerHTML =
      '<div class="profile"><div class="big-av">' + esc(u.name.trim().charAt(0).toUpperCase()) + '</div>' +
        '<div style="min-width:0;"><h3>' + esc(u.name) + '</h3><p>' + esc(u.email) + '</p><p style="margin-top:3px; color:var(--gold);">' + (hasPass() ? 'All-Access Pass active' : 'StreamCos Member') + '</p></div></div>' +
      '<div class="stats"><div class="stat"><b>' + mine + '</b><span>Films owned</span></div><div class="stat"><b>' + Math.round(mins) + ' min</b><span>Watched so far</span></div></div>' +
      (hasPass() ? '' : '<div style="padding:12px 18px 0;"><button class="btn goldb block" id="accPassBtn">Get All-Access Pass · ' + inr(PASS_PRICE) + ' — unlock every film</button></div>') +
      '<div class="menu">' +
        '<button data-goto="library"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3z"/></svg>My library<svg class="chev" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="m9 5 7 7-7 7"/></svg></button>' +
        '<button data-goto="home"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg>Browse films<svg class="chev" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="m9 5 7 7-7 7"/></svg></button>' +
      '</div>' +
      ownerCardHtml() +
      '<div style="padding:18px;"><button class="btn ghost block" id="signOutBtn">Sign out</button></div>';

    var pb = $("#accPassBtn"); if (pb) pb.addEventListener("click", function() { startCheckout("pass"); });
    $("#signOutBtn").addEventListener("click", function() {
      authToken = null; ownerToken = null;
      localStorage.removeItem('sc_token');
      sessionStorage.removeItem('sc_owner_token');
      session = null; owns = []; passHolders = false; progress = {};
      store.del(K.sess); store.del(K.owns); store.del(K.pass); store.del(K.prog);
      ownerUnlocked = false; $("#tabAdmin").classList.add("hidden");
      renderHeader(); renderAccount(); renderHome(); toast("Signed out. See you soon!");
    });
    bindOwnerCard();
  }

  function ownerCardHtml() {
    return '<div class="menu" style="margin-top:14px;"><button id="ownerStudioBtn">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>' +
      '<span class="gold-t">Owner Studio</span><span style="margin-left:auto; font-size:11.5px; color:var(--dim); font-weight:700;">Owner only · PIN protected</span>' +
      '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke-width="2" style="margin-left:6px;"><path d="m9 5 7 7-7 7"/></svg></button></div>' +
      '<p class="foot-note" style="margin-top:10px;">Only the store owner can open the Studio — upload films, set prices and manage the catalogue.</p>';
  }

  function bindOwnerCard() {
    var b = $("#ownerStudioBtn");
    if (b) b.addEventListener("click", function() { openOwnerGate(); });
  }

  /* ============ admin / studio ============ */
  async function renderAdmin() {
    var slot = $("#adminSlot");
    if (!ownerUnlocked) { renderPinGate(slot); return; }
    $("#tabAdmin").classList.remove("hidden");

    var stats = { totalFilms: catalog.length, salesCount: sales.length, revenue: 0 };
    var netUrls = [];
    try {
      var s = await api('/api/admin/stats');
      if (s) { stats = s; sales = s.sales || []; }
    } catch (e) {}
    try {
      var n = await api('/api/network-info');
      if (n && n.urls) netUrls = n.urls;
    } catch (e) {}
    await loadPaymentConfig();

    slot.innerHTML =
      '<div class="page-head"><h1>Owner Studio</h1><p>Upload films from your PC, set prices, publish or remove titles.</p></div>' +
      '<div class="admin-stats">' +
        '<div class="stat"><b>' + catalog.length + '</b><span>Titles</span></div>' +
        '<div class="stat"><b>' + (stats.salesCount || 0) + '</b><span>Sales</span></div>' +
        '<div class="stat"><b>' + inr(stats.revenue || 0) + '</b><span>Revenue</span></div>' +
      '</div>' +
      '<div style="margin:14px 18px 0; background:linear-gradient(135deg,rgba(255,176,32,.12),rgba(47,206,110,.08)); border:1px solid rgba(255,176,32,.35); border-radius:var(--r-md); padding:13px 15px;">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">' +
          '<div>' +
            '<div style="font-size:11px; font-weight:800; color:var(--gold); text-transform:uppercase; letter-spacing:.06em;">⚡ YouPI Gateway · 0% Fees</div>' +
            '<div style="font-size:13px; font-weight:700; color:#fff; margin-top:3px;">Receiving: <span style="color:var(--green);">' + esc(paymentConfig.vpa || 'not set') + '</span></div>' +
            '<div style="font-size:11.5px; color:var(--mut); margin-top:2px;">₹' + esc(paymentConfig.amount || '—') + ' · ' + esc(paymentConfig.payeeName || '') + ' · ' + (paymentConfig.qrImage ? 'Fixed QR' : 'No QR') + ' · ' + (paymentConfig.verification === 'manual' ? 'Manual approval' : 'Instant UTR') + '</div>' +
          '</div>' +
          '<div style="display:flex; flex-direction:column; gap:6px; flex:none;">' +
            '<button class="btn ghost sm" id="editPaymentBtn" style="font-size:12px; padding:6px 12px;">Configure</button>' +
            '<button class="btn ghost sm" id="paymentsLedgerBtn" style="font-size:12px; padding:6px 12px;">Ledger</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      (netUrls.length ?
        '<div style="margin:14px 18px 0; background:linear-gradient(135deg,rgba(47,206,110,.12),rgba(255,176,32,.08)); border:1px solid rgba(47,206,110,.4); border-radius:var(--r-md); padding:12px 14px;">' +
        '<div style="font-size:11px; font-weight:800; color:var(--green); text-transform:uppercase; letter-spacing:.06em; margin-bottom:4px;">⚡ Streaming Live from your PC (Hovod)</div>' +
        '<p style="margin:0; font-size:12px; color:var(--txt); line-height:1.5;">Watch on phones, tablets or other devices on this Wi-Fi:<br/>' +
        netUrls.map(function(u){ return '<b style="color:var(--gold); font-size:12.5px;">'+esc(u)+'</b>'; }).join(' &nbsp;·&nbsp; ') +
        '</p></div>' : '') +
      '<div style="padding:16px 18px 0;"><button class="btn acc block" id="addVideoBtn">＋ Add a new film from PC</button></div>' +
      '<div class="sec" style="margin-top:20px;"><div class="sec-head"><h2>Your catalogue</h2><span>' + catalog.filter(function(v) { return v.published; }).length + ' live</span></div>' +
      '<div class="lib-list" style="padding-top:0;">' +
      (catalog.length ? catalog.map(function(v) {
        var n = (sales || []).filter(function(s) { return s.videoId === v.id; }).length;
        var isHls = v.video && v.video.includes('.m3u8');
        return '<div class="adm-item"><img src="' + esc(mediaUrl(v.poster)) + '" alt="" onerror="this.style.visibility=\'hidden\'" />' +
          '<div class="ai-body"><h4>' + esc(v.title) + (isHls ? ' <span style="font-size:9.5px; background:rgba(255,176,32,.2); color:var(--gold); border:1px solid rgba(255,176,32,.4); padding:2px 5px; border-radius:4px; font-weight:800;">HLS</span>' : '') + '</h4><p>' + inr(v.price) + ' · ' + esc(v.category) + ' · ' + n + ' sold</p></div>' +
          '<div class="adm-actions">' +
            '<button class="pub-toggle' + (v.published ? '' : ' off') + '" data-pub="' + v.id + '">' + (v.published ? 'Live' : 'Hidden') + '</button>' +
            '<button class="mini-btn" data-edit="' + v.id + '" aria-label="Edit"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m13.5 6.5 3 3"/></svg></button>' +
            '<button class="mini-btn danger" data-del="' + v.id + '" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13"/></svg></button>' +
          '</div></div>';
      }).join("") : '<div class="empty"><h3>No films yet</h3><p>Add your first film to open the store.</p></div>') +
      '</div></div>' +
      '<div style="padding:20px 18px 0;"><button class="btn ghost block" id="lockStudioBtn">Lock Studio</button></div>' +
      '<div id="videoFormSlot"></div>';

    $("#addVideoBtn").addEventListener("click", function() { renderVideoForm(null); });
    var editPayBtn = $("#editPaymentBtn");
    if (editPayBtn) editPayBtn.addEventListener("click", renderPaymentSettingsForm);
    var ledgerBtn = $("#paymentsLedgerBtn");
    if (ledgerBtn) ledgerBtn.addEventListener("click", renderPaymentsLedger);
    $("#lockStudioBtn").addEventListener("click", function() {
      ownerUnlocked = false; $("#tabAdmin").classList.add("hidden"); goto("account"); toast("Studio locked.");
    });
    $$("#adminSlot [data-pub]").forEach(function(b) {
      b.addEventListener("click", async function() {
        var v = byId(b.dataset.pub);
        var nextStatus = !v.published;
        try {
          await api('/api/catalog/' + v.id, {
            method: 'PUT',
            body: JSON.stringify({ published: nextStatus })
          });
          v.published = nextStatus;
          store.set(K.cat, catalog);
          renderAdmin(); renderHome();
          toast(v.published ? "Published — live in store." : "Unpublished — hidden.");
        } catch (e) {
          toast("Update failed: " + e.message);
        }
      });
    });
    $$("#adminSlot [data-edit]").forEach(function(b) { b.addEventListener("click", function() { renderVideoForm(byId(b.dataset.edit)); }); });
    $$("#adminSlot [data-del]").forEach(function(b) { b.addEventListener("click", function() { renderDeleteConfirm(b.dataset.del); }); });
  }

  async function renderPaymentSettingsForm() {
    var slot = $("#videoFormSlot");
    var cfg = paymentConfig || {};
    var secret = "";
    try {
      var admin = await api('/api/admin/payments');
      if (admin && admin.config) { cfg = admin.config; secret = admin.config.webhookSecret || ""; }
    } catch (e) {}
    if (!secret) secret = cfg.webhookSecret || "";

    var qr = cfg.qrImage ? mediaUrl(cfg.qrImage) : null;
    var pin = cfg.qrSha256 ? cfg.qrSha256.slice(0, 16) + "…" : "not pinned";

    slot.innerHTML =
      '<div class="sec" style="margin-top:24px;"><div class="sec-head"><h2>Payment Gateway</h2><span>YouPI · self-hosted UPI</span></div>' +
      '<div style="background:rgba(255,176,32,.08); border:1px solid rgba(255,176,32,.3); border-radius:var(--r-md); padding:11px 13px; margin:0 18px 14px; font-size:12px; color:var(--txt); line-height:1.5;">' +
        '<b>⚡ Direct UPI · 0% fees</b><br/>Checkout always shows the <b>single</b> QR configured here — it is never regenerated. That QR fixes the amount, so keep the pass price equal to it.' +
      '</div>' +
      '<form class="form" id="payConfigForm">' +
        '<div class="fld"><label>Payment QR (fixed) ' + (qr ? '' : '<span style="color:#ff9f43;">— missing</span>') + '</label>' +
          (qr ? '<div style="margin-bottom:8px; display:flex; align-items:center; gap:10px; padding:8px; background:#fff; border-radius:10px; width:max-content;"><img src="' + esc(qr) + '" style="width:84px; height:84px; object-fit:contain;" alt="Merchant QR" /></div>' : '') +
          '<input id="pcfgQrFile" type="file" accept="image/png,image/jpeg" />' +
          '<span style="font-size:11px; color:var(--mut); margin-top:3px; display:block;">Upload the merchant QR exactly as issued. SHA-256 pin: ' + esc(pin) + '</span>' +
        '</div>' +
        '<div class="fld"><label>Payee UPI ID (VPA)</label><input id="pcfgVpa" type="text" value="' + esc(cfg.vpa || '') + '" required />' +
          '<span style="font-size:11px; color:var(--mut); margin-top:3px; display:block;">The UTR flow assumes the QR pays this VPA.</span></div>' +
        '<div class="fld"><label>Payee name</label><input id="pcfgName" type="text" value="' + esc(cfg.payeeName || '') + '" /></div>' +
        '<div class="two">' +
          '<div class="fld"><label>Pass price (₹)</label><input id="pcfgAmount" type="number" min="1" step="0.01" value="' + esc(cfg.amount || '') + '" /></div>' +
          '<div class="fld"><label>Verification</label><select id="pcfgVerify">' +
            '<option value="instant"' + (cfg.verification !== 'manual' ? ' selected' : '') + '>Instant · UTR unlocks</option>' +
            '<option value="manual"' + (cfg.verification === 'manual' ? ' selected' : '') + '>Manual · I approve</option>' +
          '</select></div>' +
        '</div>' +
        '<div class="fld"><label>Webhook secret</label><input id="pcfgSecret" type="text" readonly value="' + esc(secret) + '" style="font-size:11px;" />' +
          '<span style="font-size:11px; color:var(--mut); margin-top:3px; display:block;">POST /api/youpi/webhook with X-Gateway-Signature: sha256=HMAC-SHA256(body). <button type="button" id="rotateSecretBtn" style="color:var(--gold); font-weight:700; text-decoration:underline;">Rotate</button></span></div>' +
        '<div style="display:flex; gap:8px; margin-top:14px;">' +
          '<button class="btn acc block" type="submit" id="savePayCfgBtn" style="flex:1;">Save</button>' +
          '<button class="btn ghost" type="button" id="cancelPayCfgBtn">Cancel</button>' +
        '</div>' +
      '</form></div>';

    slot.scrollIntoView({ behavior: "smooth", block: "start" });

    $("#cancelPayCfgBtn").addEventListener("click", function() { slot.innerHTML = ""; });
    $("#rotateSecretBtn").addEventListener("click", function() { state.rotateSecret = true; toast("A new webhook secret will be generated on save."); });

    $("#payConfigForm").addEventListener("submit", async function(e) {
      e.preventDefault();
      var vpa = $("#pcfgVpa").value.trim();
      var name = $("#pcfgName").value.trim();
      var amount = Number($("#pcfgAmount").value);
      if (!/^[\w.\-]{2,}@[a-zA-Z][\w.\-]{1,}$/.test(vpa)) { toast("Enter a valid UPI ID like name@bank"); return; }
      if (!isFinite(amount) || amount < 1) { toast("Enter a pass price of at least ₹1"); return; }

      var btn = $("#savePayCfgBtn");
      btn.textContent = "Saving…";
      btn.disabled = true;

      var qrImgUrl = paymentConfig.qrImage;
      var file = $("#pcfgQrFile").files[0];
      if (file) {
        try {
          var uploadHeaders = {
            "X-Filename": encodeURIComponent(file.name),
            "Content-Type": file.type || "image/png",
            "ngrok-skip-browser-warning": "true",
            "Bypass-Tunnel-Reminder": "true"
          };
          if (ownerToken) uploadHeaders["Authorization"] = "Bearer " + ownerToken;
          var upRes = await fetch((API_BASE ? API_BASE : "") + "/api/upload", {
            method: "POST",
            headers: uploadHeaders,
            body: file
          });
          var upData = await upRes.json();
          if (upData.ok) qrImgUrl = upData.rawUrl || upData.url;
        } catch (err) {
          toast("QR upload failed: " + err.message);
          btn.textContent = "Save"; btn.disabled = false;
          return;
        }
      }

      try {
        var res = await api('/api/admin/payment/config', {
          method: 'POST',
          body: JSON.stringify({
            vpa: vpa,
            payeeName: name,
            amount: amount,
            verification: $("#pcfgVerify").value,
            qrImage: qrImgUrl,
            rotateWebhookSecret: !!state.rotateSecret
          })
        });
        state.rotateSecret = false;
        if (res && res.config) applyPaymentConfig(res.config, null);
        toast("Payment gateway updated");
        slot.innerHTML = "";
        renderAdmin();
      } catch (err) {
        toast("Save failed: " + err.message);
        btn.textContent = "Save"; btn.disabled = false;
      }
    });
  }

  function payStatusChip(status) {
    var map = {
      PAID: ['var(--green)', 'rgba(47,206,110,.16)', 'Paid'],
      AWAITING_PAYMENT: ['var(--gold)', 'rgba(255,176,32,.16)', 'Awaiting payment'],
      AWAITING_REVIEW: ['var(--gold)', 'rgba(255,176,32,.16)', 'Review'],
      EXPIRED: ['var(--dim)', 'rgba(255,255,255,.08)', 'Expired'],
      REJECTED: ['#ff7a72', 'rgba(255,64,56,.16)', 'Rejected'],
      CANCELLED: ['var(--dim)', 'rgba(255,255,255,.08)', 'Cancelled']
    };
    var m = map[status] || ['var(--mut)', 'rgba(255,255,255,.08)', status];
    return '<span style="font-size:10px; font-weight:800; color:' + m[0] + '; background:' + m[1] + '; border:1px solid ' + m[0] + '; padding:2px 7px; border-radius:999px; text-transform:uppercase; letter-spacing:.04em;">' + m[2] + '</span>';
  }

  async function renderPaymentsLedger() {
    var slot = $("#videoFormSlot");
    slot.innerHTML = '<div class="sec" style="margin-top:24px;"><div class="sec-head"><h2>Payments</h2></div><div class="spin" style="margin:20px auto;"></div></div>';
    slot.scrollIntoView({ behavior: "smooth", block: "start" });

    var data;
    try { data = await api('/api/admin/payments'); }
    catch (e) { slot.innerHTML = '<div class="sec" style="margin-top:24px;"><p style="padding:0 18px; color:#ff7a72;">Could not load payments: ' + esc(e.message) + '</p></div>'; return; }

    var stats = data.stats || {};
    var orders = data.orders || [];
    var pending = orders.filter(function(o) { return o.status === 'AWAITING_REVIEW'; });

    slot.innerHTML =
      '<div class="sec" style="margin-top:24px;"><div class="sec-head"><h2>Payments</h2><span>' + (stats.paid || 0) + ' paid</span></div>' +
      '<div class="admin-stats" style="margin:0 18px 12px;">' +
        '<div class="stat"><b>' + inr((stats.revenuePaise || 0) / 100) + '</b><span>Collected</span></div>' +
        '<div class="stat"><b>' + (stats.pendingReview || 0) + '</b><span>To review</span></div>' +
        '<div class="stat"><b>' + (stats.expired || 0) + '</b><span>Expired</span></div>' +
      '</div>' +
      '<div style="margin:0 18px 14px; background:var(--card); border:1px solid var(--line2); border-radius:12px; padding:12px;">' +
        '<div style="font-size:12px; font-weight:800; color:var(--gold); margin-bottom:6px;">Match bank credits</div>' +
        '<p style="margin:0 0 8px; font-size:11.5px; color:var(--mut); line-height:1.45;">Paste lines from your bank statement (amount + 12-digit UTR). Matching credits unlock their orders and mark them <b>statement</b>.</p>' +
        '<textarea id="statementInput" rows="3" placeholder="20/10/2026 UPI/MUSKAAN 412345678901 99.99" style="width:100%; box-sizing:border-box; background:var(--card2); border:1px solid var(--line2); border-radius:8px; padding:9px 10px; color:#fff; font-size:12px; font-family:monospace; resize:vertical;"></textarea>' +
        '<button class="btn acc block sm" id="reconcileBtn" style="margin-top:8px;">Reconcile credits</button>' +
        '<div id="reconcileResult" style="font-size:11.5px; margin-top:8px; line-height:1.5;"></div>' +
      '</div>' +
      (orders.length ? '<div class="lib-list" style="padding-top:0;">' + orders.map(function(o) {
        return '<div class="adm-item">' +
          '<div class="ai-body"><h4>' + payStatusChip(o.status) + ' <span style="margin-left:6px;">₹' + esc(o.amount) + '</span></h4>' +
            '<p>' + esc(o.email) + ' · ' + esc(o.id) + (o.utr ? ' · ' + esc(o.utr) : '') + '</p>' +
            '<p style="color:var(--dim); font-size:11px;">' + new Date(o.createdAt).toLocaleString() + (o.source ? ' · ' + esc(o.source) : '') + '</p>' +
          '</div>' +
          (o.status === 'AWAITING_REVIEW'
            ? '<div class="adm-actions"><button class="mini-btn" data-approve="' + esc(o.id) + '" title="Approve" style="color:var(--green); font-weight:900;">✓</button>' +
              '<button class="mini-btn danger" data-reject="' + esc(o.id) + '" title="Reject">✕</button></div>'
            : '') +
        '</div>';
      }).join("") + '</div>'
        : '<div class="empty"><h3>No payments yet</h3><p>Checkout sessions appear here the moment a customer opens the QR.</p></div>') +
      (pending.length ? '<p class="foot-note" style="margin:8px 18px 0;">' + pending.length + ' payment(s) waiting for your approval.</p>' : '') +
      '</div>';

    $$("#videoFormSlot [data-approve]").forEach(function(b) {
      b.addEventListener("click", function() { resolvePayment(b.dataset.approve, 'approve'); });
    });
    $$("#videoFormSlot [data-reject]").forEach(function(b) {
      b.addEventListener("click", function() { resolvePayment(b.dataset.reject, 'reject'); });
    });

    var reconcileBtn = $("#reconcileBtn");
    if (reconcileBtn) {
      reconcileBtn.addEventListener("click", async function() {
        var text = ($("#statementInput") || {}).value || "";
        var out = $("#reconcileResult");
        if (!text.trim()) { out.innerHTML = '<span style="color:#ff9f43;">Paste a few statement lines first.</span>'; return; }
        reconcileBtn.disabled = true;
        reconcileBtn.textContent = "Matching…";
        try {
          var res = await api('/api/admin/payments/reconcile', {
            method: 'POST',
            body: JSON.stringify({ text: text })
          });
          out.innerHTML =
            '<span style="color:var(--green); font-weight:800;">' + res.matched.length + ' matched</span>' +
            (res.unmatched.length ? ' · <span style="color:#ff9f43;">' + res.unmatched.length + ' unmatched</span>' : '') +
            (res.matched.length ? '<br/>' + res.matched.map(function(m) { return esc(m.email) + ' · ₹' + (m.amountPaise / 100).toFixed(2); }).join('<br/>') : '');
          if (res.matched.length) setTimeout(renderPaymentsLedger, 900);
        } catch (e) {
          out.innerHTML = '<span style="color:#ff7a72;">' + esc(e.message) + '</span>';
        } finally {
          reconcileBtn.disabled = false;
          reconcileBtn.textContent = "Reconcile credits";
        }
      });
    }
  }

  async function resolvePayment(id, action) {
    try {
      await api('/api/admin/payments/' + encodeURIComponent(id) + '/resolve', {
        method: 'POST',
        body: JSON.stringify({ action: action })
      });
      toast(action === 'approve' ? "Payment approved — pass granted" : "Payment rejected");
      renderPaymentsLedger();
    } catch (e) {
      toast("Could not update: " + e.message);
    }
  }

  async function openOwnerGate() {
    if (ownerUnlocked) { goto("admin"); return; }
    try {
      var status = await api('/api/admin/owner-status');
      state.ownerConfigured = !!status.configured;
    } catch (e) {
      state.ownerConfigured = true;
    }
    state.pinStep = state.ownerConfigured ? "enter" : "create";
    state.pinBuffer = ""; state.pinNew = ""; state.setupCode = "";
    renderAdmin();
    goto("admin");
  }

  function renderPinGate(slot) {
    var setup = !state.ownerConfigured;
    var create = setup && (state.pinStep === "create" || state.pinStep === "confirm");
    var title = state.pinStep === "confirm" ? "Repeat the PIN"
      : setup ? "Set up Owner Studio"
      : "Owner Studio";
    var sub = state.pinStep === "confirm" ? "Enter the same 4 digits once more to confirm."
      : setup ? "Enter the setup code from the server terminal, then choose a 4-digit PIN."
      : "Enter your 4-digit PIN.";

    slot.innerHTML =
      '<div class="page-head"><h1>' + title + '</h1><p>' + sub + '</p></div>' +
      '<div class="pin-dots">' + [0, 1, 2, 3].map(function(i) { return '<i class="' + (state.pinBuffer.length > i ? 'f' : '') + '"></i>'; }).join("") + '</div>' +
      '<div class="form-err" id="pinErr" style="margin:12px 18px 0;"></div>' +
      '<form class="form" id="pinForm" style="margin-top:14px;">' +
        (setup && state.pinStep === "create"
          ? '<div class="fld"><label>Setup code</label><input id="pinSetupCode" type="text" placeholder="e.g. 7K2M-9QRS" autocomplete="off" autocapitalize="characters" value="' + esc(state.setupCode || "") + '" style="letter-spacing:2px; text-transform:uppercase;" /></div>'
          : '') +
        '<div class="fld"><label>Owner PIN</label><input id="pinInput" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="••••" autocomplete="off" style="text-align:center; font-size:22px; letter-spacing:10px;" /></div>' +
        '<button class="btn ' + (create ? 'goldb' : 'acc') + ' block" type="submit">' + (state.pinStep === "create" ? "Continue" : state.pinStep === "confirm" ? "Set PIN & open Studio" : "Unlock Studio") + '</button>' +
        '<button class="btn ghost block" type="button" id="pinBack">Back to account</button>' +
      '</form>' +
      '<p class="foot-note" style="margin:14px 18px 0;">' +
        (setup
          ? 'The setup code is printed once in the terminal running StreamCos. Lost it? Run <b>node backend/reset-pin.js --yes</b> on the host.'
          : 'Forgot your PIN? Run <b>node backend/reset-pin.js --yes</b> on the host that runs StreamCos.') +
      '</p>';

    var inp = $("#pinInput");
    inp.focus();
    inp.addEventListener("input", function() {
      state.pinBuffer = inp.value.replace(/\D/g, "").slice(0, 4);
      inp.value = state.pinBuffer;
      $$(".pin-dots i").forEach(function(d, i) { d.classList.toggle("f", state.pinBuffer.length > i); });
    });
    $("#pinBack").addEventListener("click", function() { goto("account"); });

    $("#pinForm").addEventListener("submit", async function(e) {
      e.preventDefault();
      var err = $("#pinErr");
      function fail(m) { err.textContent = m; err.classList.add("on"); }
      if (state.pinBuffer.length !== 4) return fail("Enter all 4 digits.");

      if (state.pinStep === "create") {
        var codeInput = $("#pinSetupCode");
        var code = codeInput ? codeInput.value.trim().toUpperCase() : "";
        if (code.replace(/[^0-9A-Z]/g, "").length < 6) {
          return fail("Enter the setup code printed in the server terminal (or run node backend/reset-pin.js --yes).");
        }
        state.setupCode = code;
        state.pinNew = state.pinBuffer;
        state.pinBuffer = "";
        state.pinStep = "confirm";
        renderAdmin();
        return;
      }
      if (state.pinStep === "confirm") {
        if (state.pinBuffer !== state.pinNew) { state.pinStep = "create"; state.pinBuffer = ""; renderAdmin(); toast("PINs didn't match — start again."); return; }
        try {
          var setupRes = await api('/api/admin/verify-pin', {
            method: 'POST',
            body: JSON.stringify({ newPin: state.pinNew, setupCode: state.setupCode })
          });
          if (setupRes.ownerToken) {
            ownerToken = setupRes.ownerToken;
            sessionStorage.setItem('sc_owner_token', ownerToken);
          }
          ownerUnlocked = true; renderAdmin(); toast("Studio unlocked. Welcome, owner.");
        } catch (errApi) {
          fail(errApi.message);
        }
        return;
      }

      try {
        var res = await api('/api/admin/verify-pin', { method: 'POST', body: JSON.stringify({ pin: state.pinBuffer }) });
        if (res.needsSetup) {
          state.ownerConfigured = false;
          state.pinStep = "create"; state.pinBuffer = ""; renderAdmin(); return;
        }
        if (res.ownerToken) {
          ownerToken = res.ownerToken;
          sessionStorage.setItem('sc_owner_token', ownerToken);
        }
        ownerUnlocked = true; renderAdmin(); toast("Studio unlocked. Welcome back, owner.");
      } catch (verifyErr) {
        fail("Wrong PIN. Enter your 4-digit PIN.");
      }
    });
  }

  function renderVideoForm(v) {
    state.editingId = v ? v.id : null;
    var slot = $("#videoFormSlot");
    slot.innerHTML =
      '<div class="sec" style="margin-top:24px;"><div class="sec-head"><h2>' + (v ? "Edit film" : "Add a new film") + '</h2></div>' +
      '<form class="form" id="videoForm">' +
        '<div class="fld"><label>Title</label><input id="vfTitle" type="text" placeholder="Film title" value="' + (v ? esc(v.title) : "") + '" /></div>' +
        '<div class="two">' +
          '<div class="fld"><label>Price (₹)</label><input id="vfPrice" type="number" min="0" step="1" placeholder="199" value="' + (v ? v.price : "") + '" /></div>' +
          '<div class="fld"><label>Old price (₹, optional)</label><input id="vfOld" type="number" min="0" step="1" placeholder="299" value="' + (v && v.oldPrice ? v.oldPrice : "") + '" /></div>' +
        '</div>' +
        '<div class="two">' +
          '<div class="fld"><label>Category</label><select id="vfCat">' +
            ["Drama", "Comedy", "Action", "Sci-Fi", "Fantasy", "Family", "Documentary", "Romance", "Thriller"].map(function(c) { return '<option' + (v && v.category === c ? ' selected' : '') + '>' + c + '</option>'; }).join("") +
          '</select></div>' +
          '<div class="fld"><label>Duration (minutes)</label><input id="vfMins" type="number" min="1" placeholder="12" value="' + (v ? v.mins : "") + '" /></div>' +
        '</div>' +
        '<div class="two">' +
          '<div class="fld"><label>Year</label><input id="vfYear" type="number" placeholder="2026" value="' + (v ? v.year : "") + '" /></div>' +
          '<div class="fld"><label>Quality</label><select id="vfQ"><option' + (v && v.quality === "HD" ? ' selected' : '') + '>HD</option><option' + (v && v.quality === "4K" ? ' selected' : '') + '>4K</option></select></div>' +
        '</div>' +
        '<div class="fld"><label>Description</label><textarea id="vfDesc" placeholder="Tell buyers what this film is about…">' + (v ? esc(v.desc) : "") + '</textarea></div>' +
        '<div class="fld"><label>Thumbnail image</label>' +
          '<div style="display:flex; gap:8px; margin-bottom:6px;">' +
            '<button type="button" class="btn ghost sm" id="btnUploadPoster" style="border:1px dashed var(--line2); padding:8px 12px; font-size:12px;">🖼 Choose Poster from PC</button>' +
            '<input type="file" id="vfPosterFileInput" accept="image/*" style="display:none;" />' +
          '</div>' +
          '<input id="vfPoster" type="text" placeholder="assets/poster-spring.jpg or /uploads/posters/..." value="' + (v ? esc(v.poster) : "") + '" />' +
        '</div>' +
        '<div class="fld"><label>Video Stream (Upload from PC or enter URL)</label>' +
          '<div style="margin-bottom:8px;">' +
            '<button type="button" class="btn acc sm block" id="btnUploadVideo" style="border:1px dashed rgba(255,255,255,.4); padding:11px 14px; font-size:13px;">📁 Choose & Upload Video from PC</button>' +
            '<input type="file" id="vfVideoFileInput" accept="video/*" style="display:none;" />' +
            '<label style="display:flex; align-items:center; gap:8px; font-size:12px; color:var(--gold); margin-top:8px; cursor:pointer;"><input type="checkbox" id="vfHlsToggle" checked style="width:auto; accent-color:var(--gold);" /> ⚡ Hovod Engine: Transcode to multi-bitrate HLS (.m3u8 adaptive stream)</label>' +
          '</div>' +
          '<div id="vfUploadBox" class="hidden" style="margin-bottom:10px; padding:10px; background:var(--card2); border:1px solid var(--line2); border-radius:10px;">' +
            '<div class="prog" style="height:6px;"><i id="vfUploadBar" style="width:0%; background:var(--green); transition:width .2s;"></i></div>' +
            '<div id="vfUploadText" style="font-size:12px; color:var(--gold); margin-top:6px; font-weight:700;">Uploading...</div>' +
          '</div>' +
          '<input id="vfVideo" type="text" placeholder="/uploads/hls/.../master.m3u8 or https://..." value="' + (v ? esc(v.video) : "") + '" />' +
        '</div>' +
        '<button class="btn acc block" type="submit">' + (v ? "Save changes" : "Publish film") + '</button>' +
        '<button class="btn ghost block" type="button" id="vfCancel">Cancel</button>' +
      '</form></div>';

    slot.scrollIntoView({ behavior: "smooth", block: "start" });

    // Video Upload Handler
    $("#btnUploadVideo").addEventListener("click", function() { $("#vfVideoFileInput").click(); });
    $("#vfVideoFileInput").addEventListener("change", function() {
      var file = this.files[0];
      if (!file) return;
      var box = $("#vfUploadBox");
      var bar = $("#vfUploadBar");
      var txt = $("#vfUploadText");
      var wantHls = $("#vfHlsToggle").checked;

      box.classList.remove("hidden");
      bar.style.width = "10%";
      txt.textContent = "Uploading " + file.name + " (" + (Math.round(file.size / (1024*1024)*10)/10) + " MB)...";

      var xhr = new XMLHttpRequest();
      xhr.open("POST", (API_BASE ? API_BASE : "") + "/api/upload");
      xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      if (wantHls) xhr.setRequestHeader("X-Auto-HLS", "true");
      if (ownerToken) xhr.setRequestHeader("Authorization", "Bearer " + ownerToken);

      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) {
          var pct = Math.round((e.loaded / e.total) * 100);
          var mbLoaded = (Math.round(e.loaded / (1024 * 1024) * 10) / 10);
          var mbTotal = (Math.round(e.total / (1024 * 1024) * 10) / 10);
          if (pct >= 100 || e.loaded >= e.total) {
            bar.style.width = "100%";
            txt.innerHTML = '<span style="color:var(--gold);">⚡ Uploaded 100% (' + mbTotal + ' MB)! Hovod engine is slicing into HLS stream... Please wait</span>';
          } else {
            bar.style.width = pct + "%";
            txt.textContent = "Uploading: " + pct + "% (" + mbLoaded + " MB / " + mbTotal + " MB)...";
          }
        }
      };

      xhr.upload.onload = function() {
        bar.style.width = "100%";
        txt.innerHTML = '<span style="color:var(--gold);">⚡ Uploaded 100%! Hovod engine is slicing into HLS stream... Please wait a moment</span>';
      };

      xhr.onload = function() {
        if (xhr.status === 201 || xhr.status === 200) {
          try {
            var resp = JSON.parse(xhr.responseText);
            bar.style.width = "100%";
            txt.innerHTML = '<span style="color:var(--green);">✔ Uploaded' + (resp.hlsUrl ? ' & Transcoded to Adaptive HLS!' : ' successfully!') + '</span>';
            $("#vfVideo").value = resp.hlsUrl || resp.url;
            if (resp.posterUrl && !$("#vfPoster").value) {
              $("#vfPoster").value = resp.posterUrl;
            }
            if (!$("#vfTitle").value) {
              var cleanTitle = file.name.replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " ");
              $("#vfTitle").value = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);
            }
            toast(resp.hlsUrl ? "Video uploaded & sliced into HLS stream!" : "Video uploaded from PC!");
          } catch(e) {
            txt.textContent = "Upload complete.";
          }
        } else {
          txt.innerHTML = '<span style="color:var(--acc);">Upload failed (status ' + xhr.status + ')</span>';
        }
      };

      xhr.onerror = function() {
        txt.innerHTML = '<span style="color:var(--acc);">Network error during upload</span>';
      };

      txt.textContent = "Processing upload...";
      xhr.send(file);
    });

    // Poster Upload Handler
    $("#btnUploadPoster").addEventListener("click", function() { $("#vfPosterFileInput").click(); });
    $("#vfPosterFileInput").addEventListener("change", async function() {
      var file = this.files[0];
      if (!file) return;
      toast("Uploading poster from PC...");
      try {
        var uploadHeaders = {
          "X-Filename": encodeURIComponent(file.name),
          "Content-Type": file.type || "image/jpeg",
          "ngrok-skip-browser-warning": "true",
          "Bypass-Tunnel-Reminder": "true"
        };
        if (ownerToken) uploadHeaders["Authorization"] = "Bearer " + ownerToken;
        var res = await fetch((API_BASE ? API_BASE : "") + "/api/upload", {
          method: "POST",
          headers: uploadHeaders,
          body: file
        });
        var data = await res.json();
        if (data.ok) {
          $("#vfPoster").value = data.rawUrl || data.url;
          toast("Poster uploaded!");
        }
      } catch(e) {
        toast("Poster upload failed: " + e.message);
      }
    });

    $("#vfCancel").addEventListener("click", function() { slot.innerHTML = ""; });
    $("#videoForm").addEventListener("submit", async function(e) {
      e.preventDefault();
      var title = $("#vfTitle").value.trim();
      var price = parseInt($("#vfPrice").value, 10);
      var video = $("#vfVideo").value.trim();
      if (!title) { toast("Give the film a title."); return; }
      if (isNaN(price) || price < 0) { toast("Set a price (0 for free)."); return; }
      if (!video) { toast("Add the video file or upload one from PC."); return; }

      var data = {
        title: title, price: price,
        oldPrice: parseInt($("#vfOld").value, 10) || 0,
        category: $("#vfCat").value,
        mins: parseInt($("#vfMins").value, 10) || 10,
        year: parseInt($("#vfYear").value, 10) || 2026,
        quality: $("#vfQ").value,
        desc: $("#vfDesc").value.trim() || "A film from the StreamCos owner.",
        poster: $("#vfPoster").value.trim() || "assets/poster-spring.jpg",
        video: video
      };

      try {
        if (v) {
          var updateRes = await api('/api/catalog/' + v.id, { method: 'PUT', body: JSON.stringify(data) });
          Object.assign(v, updateRes.film || data);
          toast("Film updated.");
        } else {
          var addRes = await api('/api/catalog', { method: 'POST', body: JSON.stringify(data) });
          catalog.unshift(addRes.film);
          toast("Film published — live in the store.");
        }
        store.set(K.cat, catalog);
        slot.innerHTML = "";
        renderAdmin(); renderHome();
      } catch (err) {
        toast("Save failed: " + err.message);
      }
    });
  }

  function renderDeleteConfirm(id) {
    var v = byId(id); if (!v) return;
    var slot = $("#videoFormSlot");
    slot.innerHTML =
      '<div style="margin:22px 18px 0; background:rgba(255,64,56,.08); border:1px solid rgba(255,64,56,.4); border-radius:var(--r-lg); padding:18px;">' +
        '<h3 style="margin:0 0 6px; font-size:16px;">Remove “' + esc(v.title) + '”?</h3>' +
        '<p style="margin:0 0 14px; color:var(--mut); font-size:13px; line-height:1.55;">It disappears from the store and from buyers\' libraries. This can\'t be undone.</p>' +
        '<div style="display:flex; gap:10px;"><button class="btn acc" id="delYes" style="flex:1;">Yes, remove</button><button class="btn ghost" id="delNo" style="flex:1;">Keep it</button></div>' +
      '</div>';
    slot.scrollIntoView({ behavior: "smooth" });
    $("#delYes").addEventListener("click", async function() {
      try {
        await api('/api/catalog/' + id, { method: 'DELETE' });
        catalog = catalog.filter(function(x) { return x.id !== id; });
        store.set(K.cat, catalog);
        slot.innerHTML = "";
        renderAdmin(); renderHome(); toast("Film removed.");
      } catch (e) {
        toast("Delete failed: " + e.message);
      }
    });
    $("#delNo").addEventListener("click", function() { slot.innerHTML = ""; });
  }

  /* ============ global events ============ */
  document.addEventListener("click", function(e) {
    var t = e.target.closest("[data-open],[data-watch],[data-preview],[data-buy],[data-cat],[data-goto],[data-close],[data-tab],[data-refresh-pay]");
    if (!t) return;
    if (t.hasAttribute("data-refresh-pay")) { startCheckout("pass"); return; }
    if (t.dataset.open) openDetail(t.dataset.open);
    else if (t.dataset.watch) openPlayer(t.dataset.watch, false);
    else if (t.dataset.preview) openPlayer(t.dataset.preview, true);
    else if (t.dataset.buy) buyFlow(t.dataset.buy);
    else if (t.dataset.cat) { state.cat = t.dataset.cat; renderCats(); renderGrid(); }
    else if (t.dataset.goto) {
      if (t.dataset.act === "signin") { openAuth(null); return; }
      goto(t.dataset.goto);
    }
    else if (t.hasAttribute("data-close")) closeSheets();
    else if (t.dataset.tab) {
      if (t.dataset.tab === "admin" && !ownerUnlocked) { goto("account"); toast("Open Owner Studio from your account to unlock."); return; }
      goto(t.dataset.tab);
    }
  });

  $("#scrim").addEventListener("click", closeSheets);
  $("#searchInput").addEventListener("input", function() { state.query = this.value; renderGrid(); });
  $("#hdrAvatar").addEventListener("click", function() { goto("account"); });
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") { closeSheets(); if ($("#player").classList.contains("on")) closePlayer(); }
  });

  /* ============ server connection modal ============ */
  function updateServerBadge(online, text) {
    var btn = $("#serverBtn");
    var dot = $("#serverDot");
    var lbl = $("#serverLbl");
    if (!btn || !dot || !lbl) return;
    if (online) {
      btn.classList.remove("offline");
      lbl.textContent = text || "PC Online";
    } else {
      btn.classList.add("offline");
      lbl.textContent = text || "Offline";
    }
  }

  async function checkServerHealth() {
    try {
      var h = await api('/api/health');
      if (h && h.status === 'ok') {
        updateServerBadge(true, "PC Online");
        return true;
      }
      updateServerBadge(false, "Offline");
      return false;
    } catch (e) {
      updateServerBadge(false, "Offline");
      return false;
    }
  }

  // Poll server health every 10s to keep status badge real-time
  setInterval(checkServerHealth, 10000);

  function openServerModal() {
    var sh = $("#serverSheet"), sc = $("#scrim");
    sh.innerHTML =
      '<div class="s-head"><h3>PC Backend 24x7 Connection</h3><button class="sheet-x" id="serverClose" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.2"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
      '<div style="padding:16px 20px calc(24px + env(safe-area-inset-bottom));">' +
        '<p style="font-size:13px; color:var(--mut); line-height:1.55; margin-bottom:14px;">Your backend and Hovod HLS engine run 24/7 on your PC. Any device or friend worldwide connects securely through this Cloudflare Tunnel URL:</p>' +
        '<div class="fld"><label>Active Backend Tunnel URL</label><input type="text" id="serverUrlInput" value="' + esc(API_BASE) + '" placeholder="https://....trycloudflare.com" /></div>' +
        '<div style="display:flex; gap:8px; margin-top:14px;">' +
          '<button class="btn acc block" id="btnSaveServer" style="flex:1;">Test & Connect</button>' +
          '<button class="btn ghost" id="btnResetServer">Reset Default</button>' +
        '</div>' +
        '<div id="serverTestStatus" style="font-size:12px; margin-top:12px; font-weight:700;"></div>' +
      '</div>';
    sc.classList.add("on");
    sh.classList.add("on");

    $("#serverClose").addEventListener("click", function() { sh.classList.remove("on"); sc.classList.remove("on"); });
    $("#btnResetServer").addEventListener("click", function() {
      localStorage.removeItem('sc_api_base');
      API_BASE = runtimeApi;
      $("#serverUrlInput").value = API_BASE || window.location.origin;
      toast(API_BASE ? "Reset to the configured backend" : "Reset to same-origin backend");
    });
    $("#btnSaveServer").addEventListener("click", async function() {
      var val = $("#serverUrlInput").value.trim().replace(/\/+$/, '');
      var statusEl = $("#serverTestStatus");
      statusEl.style.color = "var(--gold)";
      statusEl.textContent = "Connecting to your PC backend...";
      try {
        var res = await fetch(val + '/api/health', {
          headers: {
            'ngrok-skip-browser-warning': 'true',
            'Bypass-Tunnel-Reminder': 'true'
          }
        });
        var data = await res.json();
        if (data.status === 'ok') {
          API_BASE = val;
          localStorage.setItem('sc_api_base', val);
          statusEl.style.color = "var(--green)";
          statusEl.textContent = "✔ Connected! Backend is live & secure.";
          updateServerBadge(true, "PC Online");
          toast("Backend connected!");
          setTimeout(function() { sh.classList.remove("on"); sc.classList.remove("on"); }, 1000);
          syncCatalog();
          syncUserData();
        } else {
          throw new Error("Invalid response");
        }
      } catch (err) {
        statusEl.style.color = "var(--acc)";
        statusEl.textContent = "❌ Connection failed: " + err.message;
      }
    });
  }

  var sBtn = $("#serverBtn");
  if (sBtn) sBtn.addEventListener("click", openServerModal);

  /* ============ initialization ============ */
  renderHeader();
  renderHome();
  checkServerHealth();
  syncCatalog();
  syncUserData();
  loadPaymentConfig();
})();
