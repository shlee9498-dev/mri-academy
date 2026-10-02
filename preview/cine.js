/* ============================================================
   MRI ACADEMY · 시네마틱 다크 미리보기 공통 스크립트
   - 고정 전술 지도(캔버스 2D): 등고선 · 격자 · 자기장(파란 원)이 스크롤 따라 줄고,
     금색 플레이어 점이 다음 서클로 이동한다. 섹션 = 페이즈 1~6
   - 페이즈 HUD · 상단 진행 띠 · 등장 애니메이션 · 숫자 카운터 · 카드 빛 추적
   - 소리: Web Audio 로 직접 합성(파일 없음) · 기본 꺼짐 · 토글
   - 저사양/움직임 줄이기: 지도를 정지 화면으로, 3D 끔(html.lite)
   ============================================================ */
(function () {
  "use strict";
  var doc = document.documentElement;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var conn = navigator.connection || {};
  var lowEnd = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
               (navigator.deviceMemory && navigator.deviceMemory <= 4) || conn.saveData === true;
  var smallScreen = Math.min(screen.width, screen.height) < 500;
  var lite = reduce || (lowEnd && smallScreen);
  if (/[?&]lite=1/.test(location.search)) lite = true;
  if (lite) doc.classList.add("lite");
  window.MRI_LITE = lite;

  // ── 섹션(페이즈) ─────────────────────────────────────────
  var phases = Array.prototype.slice.call(document.querySelectorAll("[data-phase]"));
  var hud = document.querySelector(".hud");
  var bar = document.querySelector(".zonebar b");
  var top = document.querySelector(".top");

  // 자기장 설계: 페이즈마다 (중심 x, y, 반지름) — 지도 좌표 0..1, 반지름은 화면 짧은 변 기준
  var ZONES = [
    { x: 0.50, y: 0.50, r: 0.95 },
    { x: 0.58, y: 0.46, r: 0.62 },
    { x: 0.62, y: 0.52, r: 0.42 },
    { x: 0.57, y: 0.57, r: 0.28 },
    { x: 0.60, y: 0.54, r: 0.17 },
    { x: 0.62, y: 0.55, r: 0.08 },
    { x: 0.62, y: 0.55, r: 0.035 }
  ];
  // 플레이어 경로(금색 점) — 다음 서클 안쪽으로
  var PATH = [
    { x: 0.30, y: 0.30 }, { x: 0.44, y: 0.38 }, { x: 0.55, y: 0.47 },
    { x: 0.58, y: 0.55 }, { x: 0.60, y: 0.55 }, { x: 0.615, y: 0.548 }, { x: 0.62, y: 0.55 }
  ];

  // ── 지도 캔버스 ─────────────────────────────────────────
  var cv = document.getElementById("map");
  var ctx = cv && cv.getContext("2d");
  var W = 0, H = 0, DPR = 1, baseLayer = null;
  var progress = 0, shown = 0, phaseIdx = 0, t0 = performance.now();
  var trail = [];

  // 간단한 값 잡음(지형 높이)
  function hash(x, y) { var s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
  function noise(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function height(x, y) { return noise(x * 3, y * 3) * 0.6 + noise(x * 7, y * 7) * 0.3 + noise(x * 15, y * 15) * 0.1; }

  function mapRect() {
    // 지도는 화면보다 조금 크게, 짧은 변 기준 정사각형을 덮는다
    var s = Math.max(W, H) * 1.08;
    return { x: (W - s) / 2, y: (H - s) / 2, s: s };
  }

  function buildBase() {
    baseLayer = document.createElement("canvas");
    baseLayer.width = W * DPR; baseLayer.height = H * DPR;
    var g = baseLayer.getContext("2d");
    g.scale(DPR, DPR);
    var m = mapRect();
    // 바탕
    var bg = g.createRadialGradient(W * 0.6, H * 0.55, 0, W * 0.6, H * 0.55, Math.max(W, H) * 0.8);
    bg.addColorStop(0, "#0c1219"); bg.addColorStop(1, "#06080b");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // 등고선(마칭 스퀘어 간이판) — 해상도는 화면 크기에 맞춰
    var N = Math.round(Math.min(150, Math.max(70, m.s / 9)));
    var cell = m.s / N, field = [];
    for (var j = 0; j <= N; j++) { field[j] = []; for (var i = 0; i <= N; i++) field[j][i] = height(i / N, j / N); }
    var levels = 11;
    for (var L = 1; L < levels; L++) {
      var th = L / levels;
      g.strokeStyle = L % 5 === 0 ? "rgba(150,175,210,0.16)" : "rgba(150,175,210,0.07)";
      g.lineWidth = L % 5 === 0 ? 1 : 0.7;
      g.beginPath();
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        var a = field[y][x], b = field[y][x + 1], c = field[y + 1][x + 1], d = field[y + 1][x];
        var idx = (a > th ? 8 : 0) | (b > th ? 4 : 0) | (c > th ? 2 : 0) | (d > th ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        var px = m.x + x * cell, py = m.y + y * cell;
        var lerp = function (p, q) { return (th - p) / (q - p || 1e-6); };
        var T = [px + cell * lerp(a, b), py], R = [px + cell, py + cell * lerp(b, c)],
            B = [px + cell * lerp(d, c), py + cell], Lf = [px, py + cell * lerp(a, d)];
        var segs = { 1: [Lf, B], 2: [B, R], 3: [Lf, R], 4: [T, R], 5: [Lf, T, B, R], 6: [T, B], 7: [Lf, T],
                     8: [Lf, T], 9: [T, B], 10: [Lf, B, T, R], 11: [T, R], 12: [Lf, R], 13: [B, R], 14: [Lf, B] }[idx];
        for (var s = 0; s < segs.length; s += 2) { g.moveTo(segs[s][0], segs[s][1]); g.lineTo(segs[s + 1][0], segs[s + 1][1]); }
      }
      g.stroke();
    }
    // 격자 8×8 + 좌표(A~H, 1~8)
    g.strokeStyle = "rgba(170,190,220,0.08)"; g.lineWidth = 1;
    g.font = "600 11px 'Saira Condensed', sans-serif"; g.fillStyle = "rgba(170,190,220,0.28)";
    for (var k = 0; k <= 8; k++) {
      var gx = m.x + (m.s / 8) * k, gy = m.y + (m.s / 8) * k;
      g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, H); g.stroke();
      g.beginPath(); g.moveTo(0, gy); g.lineTo(W, gy); g.stroke();
      if (k < 8) {
        var lx = gx + m.s / 16, ly = gy + m.s / 16;
        if (lx > 0 && lx < W) g.fillText("ABCDEFGH"[k], lx - 3, Math.max(84, m.y + 14));
        if (ly > 0 && ly < H) g.fillText(String(k + 1), Math.max(12, m.x + 8), ly + 4);
      }
    }
    // 마을(작은 사각형 무리) — 몇 군데만
    var towns = [[0.22, 0.28], [0.61, 0.54], [0.74, 0.22], [0.36, 0.72], [0.82, 0.70], [0.48, 0.44]];
    g.fillStyle = "rgba(200,215,235,0.10)";
    towns.forEach(function (t, ti) {
      for (var q = 0; q < 14; q++) {
        var rx = m.x + (t[0] + (hash(ti, q) - 0.5) * 0.05) * m.s, ry = m.y + (t[1] + (hash(q, ti) - 0.5) * 0.05) * m.s;
        g.fillRect(rx, ry, 3 + hash(q, q + ti) * 5, 3 + hash(q + 1, ti) * 4);
      }
    });
    // 길(곡선 두 줄)
    g.strokeStyle = "rgba(200,215,235,0.07)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(m.x, m.y + m.s * 0.62);
    g.bezierCurveTo(m.x + m.s * 0.3, m.y + m.s * 0.5, m.x + m.s * 0.55, m.y + m.s * 0.68, m.x + m.s, m.y + m.s * 0.4); g.stroke();
    g.beginPath(); g.moveTo(m.x + m.s * 0.35, m.y);
    g.bezierCurveTo(m.x + m.s * 0.45, m.y + m.s * 0.35, m.x + m.s * 0.7, m.y + m.s * 0.5, m.x + m.s * 0.66, m.y + m.s); g.stroke();
  }

  function resize() {
    if (!cv) return;
    DPR = Math.min(window.devicePixelRatio || 1, lite ? 1 : 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildBase();
    draw(performance.now());
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function zoneAt(p) {
    var f = Math.max(0, Math.min(ZONES.length - 1.0001, p * (ZONES.length - 1)));
    var i = Math.floor(f), t = ease(f - i), a = ZONES[i], b = ZONES[i + 1];
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), r: lerp(a.r, b.r, t), next: b, i: i, t: t };
  }
  function playerAt(p) {
    var f = Math.max(0, Math.min(PATH.length - 1.0001, p * (PATH.length - 1)));
    var i = Math.floor(f), t = ease(f - i);
    return { x: lerp(PATH[i].x, PATH[i + 1].x, t), y: lerp(PATH[i].y, PATH[i + 1].y, t) };
  }

  function draw(now) {
    if (!ctx || !baseLayer) return;
    var m = mapRect(), S = Math.min(W, H), time = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(baseLayer, 0, 0, W, H);
    var z = zoneAt(shown);
    var cx = m.x + z.x * m.s, cy = m.y + z.y * m.s, r = z.r * S * 1.25;
    var nx = m.x + z.next.x * m.s, ny = m.y + z.next.y * m.s, nr = z.next.r * S * 1.25;

    // 자기장 바깥(파란 막) — 원 밖을 칠한다
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
    ctx.fillStyle = "rgba(47,125,255,0.10)"; ctx.fill();
    // 바깥 사선 무늬
    ctx.clip();
    ctx.strokeStyle = "rgba(47,125,255,0.07)"; ctx.lineWidth = 1;
    var off = lite ? 0 : (time * 14) % 22;
    for (var d = -H; d < W + H; d += 22) { ctx.beginPath(); ctx.moveTo(d + off, 0); ctx.lineTo(d + off - H, H); ctx.stroke(); }
    ctx.restore();

    // 자기장 경계(파란 선 · 은은한 빛)
    ctx.save();
    ctx.shadowColor = "rgba(47,125,255,0.8)"; ctx.shadowBlur = lite ? 0 : 18;
    ctx.strokeStyle = "rgba(80,150,255,0.85)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // 다음 안전 구역(흰 원) — 점선, 천천히 회전
    if (z.i < ZONES.length - 1) {
      ctx.save();
      ctx.setLineDash([6, 8]); ctx.lineDashOffset = lite ? 0 : -time * 8;
      ctx.strokeStyle = "rgba(240,245,255,0.55)"; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(nx, ny, nr, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // 플레이어(금색 점) + 이동 궤적
    var pl = playerAt(shown), px = m.x + pl.x * m.s, py = m.y + pl.y * m.s;
    if (!trail.length || Math.hypot(trail[trail.length - 1][0] - px, trail[trail.length - 1][1] - py) > 3) {
      trail.push([px, py]); if (trail.length > 90) trail.shift();
    }
    if (trail.length > 1) {
      ctx.save(); ctx.setLineDash([2, 5]);
      ctx.strokeStyle = "rgba(245,197,24,0.45)"; ctx.lineWidth = 1.4;
      ctx.beginPath(); trail.forEach(function (p, k) { k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); ctx.stroke();
      ctx.restore();
    }
    var pulse = lite ? 0 : (time % 1.6) / 1.6;
    ctx.save();
    ctx.strokeStyle = "rgba(245,197,24," + (0.6 * (1 - pulse)) + ")"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(px, py, 6 + pulse * 22, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowColor = "#f5c518"; ctx.shadowBlur = 14;
    ctx.fillStyle = "#f5c518"; ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // 라벨
    ctx.font = "700 11px 'Saira Condensed', sans-serif"; ctx.fillStyle = "rgba(245,197,24,0.9)";
    ctx.fillText("YOU", px + 10, py - 8);
  }

  // ── 스크롤 → 진행도 · 페이즈 ─────────────────────────────
  function readScroll() {
    var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    progress = Math.min(1, Math.max(0, window.scrollY / max));
    if (bar) bar.style.width = (progress * 100).toFixed(2) + "%";
    if (top) top.classList.toggle("solid", window.scrollY > 40);
    var mid = window.innerHeight * 0.45, cur = 0;
    phases.forEach(function (s, k) { if (s.getBoundingClientRect().top <= mid) cur = k; });
    if (cur !== phaseIdx) { phaseIdx = cur; onPhase(cur); }
  }
  var toast = document.createElement("div"); toast.className = "toast"; toast.setAttribute("role", "status");
  document.body.appendChild(toast);
  var TOAST = ["낙하했어요", "자기장이 줄어들어요", "다음 서클로 이동하세요", "안전 구역이 좁아져요", "마지막 서클이 가까워요", "최종 서클이에요"];
  var toastT = 0, booted = false;
  function onPhase(k) {
    if (hud) Array.prototype.forEach.call(hud.children, function (el, i) { el.classList.toggle("on", i === k); });
    Sound.blip(k);
    if (!booted) { booted = true; return; }           // 처음 열 때는 띄우지 않는다
    if (reduce || k === 0) return;
    toast.innerHTML = "<b>PHASE " + ("0" + (k + 1)).slice(-2) + "</b><span>" + TOAST[k] + "</span>";
    toast.classList.add("show"); clearTimeout(toastT);
    toastT = setTimeout(function () { toast.classList.remove("show"); }, 1900);
  }

  var running = false;
  function loop(now) {
    // 화면에 그려진 진행도를 스크롤 진행도로 부드럽게 따라가게(관성)
    shown += (progress - shown) * (lite ? 1 : 0.08);
    draw(now);
    if (!lite || Math.abs(progress - shown) > 0.0005) requestAnimationFrame(loop); else running = false;
  }
  function kick() { if (!running) { running = true; requestAnimationFrame(loop); } }

  window.addEventListener("scroll", function () { readScroll(); kick(); }, { passive: true });
  window.addEventListener("resize", function () { resize(); readScroll(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) kick(); });

  // ── 등장 애니메이션 · 카운터 · 사례 막대 ─────────────────
  function countUp(el) {
    var to = parseFloat(el.getAttribute("data-count")); if (!isFinite(to)) return;
    var dec = (el.getAttribute("data-count").split(".")[1] || "").length;
    if (reduce) { el.textContent = to.toLocaleString("ko-KR", { minimumFractionDigits: dec }); return; }
    var dur = 1400, st = performance.now();
    (function step(n) {
      var t = Math.min(1, (n - st) / dur), v = to * (1 - Math.pow(1 - t, 4));
      el.textContent = v.toLocaleString("ko-KR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
      if (t < 1) requestAnimationFrame(step);
    })(st);
  }
  var io = "IntersectionObserver" in window ? new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      e.target.querySelectorAll("[data-count]").forEach(countUp);
      io.unobserve(e.target);
    });
  }, { threshold: 0.18 }) : null;
  window.MRI_watch = function (el) { if (io) io.observe(el); else el.classList.add("in"); };
  document.querySelectorAll(".reveal,.case,.boss-ph,[data-counts]").forEach(window.MRI_watch);

  // ── 카드 · 버튼 빛 추적 ─────────────────────────────────
  if (!reduce) document.addEventListener("pointermove", function (e) {
    var el = e.target.closest && e.target.closest(".glass,.btn");
    if (!el) return;
    var r = el.getBoundingClientRect();
    el.style.setProperty("--mx", (e.clientX - r.left) + "px");
    el.style.setProperty("--my", (e.clientY - r.top) + "px");
  }, { passive: true });

  // ── 첫 화면 제목: 단어 단위로 등장 ───────────────────────
  var hero = document.querySelector(".hero");
  var h1 = hero && hero.querySelector("h1[data-split]");
  if (h1) {
    var k = 0;
    h1.querySelectorAll("[data-line]").forEach(function (line) {
      var words = line.textContent.trim().split(/\s+/);
      line.textContent = "";
      words.forEach(function (w, i) {
        // 글자는 textContent 로만 넣는다(HTML 로 다시 읽히지 않게)
        var outer = document.createElement("span"), inner = document.createElement("span");
        outer.className = "w"; inner.style.transitionDelay = (0.12 + 0.09 * k++) + "s"; inner.textContent = w;
        outer.appendChild(inner);
        if (i) line.appendChild(document.createTextNode(" "));
        line.appendChild(outer);
      });
    });
  }
  requestAnimationFrame(function () { setTimeout(function () { if (hero) hero.classList.add("go"); }, 60); });

  // ── 소리(Web Audio 합성 · 기본 꺼짐) ─────────────────────
  var Sound = (function () {
    var ac = null, master = null, on = false, bed = null;
    function ensure() {
      if (ac) return true;
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
      ac = new AC(); master = ac.createGain(); master.gain.value = 0; master.connect(ac.destination);
      // 바탕: 낮은 드론 두 개 + 바람(걸러낸 잡음)
      var lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420; lp.connect(master);
      [55, 82.4].forEach(function (f, i) {
        var o = ac.createOscillator(), gn = ac.createGain();
        o.type = i ? "triangle" : "sine"; o.frequency.value = f; o.detune.value = i ? 6 : -4;
        gn.gain.value = i ? 0.05 : 0.09; o.connect(gn); gn.connect(lp); o.start();
        var lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 0.07 + i * 0.05; lg.gain.value = 0.03;
        lfo.connect(lg); lg.connect(gn.gain); lfo.start();
      });
      var len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), ch = buf.getChannelData(0);
      for (var i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      var nz = ac.createBufferSource(); nz.buffer = buf; nz.loop = true;
      var bp = ac.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 700; bp.Q.value = 0.6;
      var ng = ac.createGain(); ng.gain.value = 0.018; nz.connect(bp); bp.connect(ng); ng.connect(master); nz.start();
      bed = { bp: bp };
      return true;
    }
    function set(v) {
      on = v;
      if (v && !ensure()) return;
      if (ac) { if (ac.state === "suspended") ac.resume(); master.gain.setTargetAtTime(v ? 0.55 : 0, ac.currentTime, 0.4); }
      try { localStorage.setItem("mri_sound", v ? "1" : "0"); } catch (e) {}
      document.querySelectorAll(".snd").forEach(function (b) {
        b.setAttribute("aria-pressed", String(v));
        var t = b.querySelector(".t"); if (t) t.textContent = v ? "소리 켜짐" : "소리 꺼짐";
      });
    }
    function tone(freq, dur, type, vol) {
      if (!on || !ac) return;
      var o = ac.createOscillator(), g = ac.createGain(), n = ac.currentTime;
      o.type = type || "sine"; o.frequency.setValueAtTime(freq, n);
      g.gain.setValueAtTime(0, n); g.gain.linearRampToValueAtTime(vol || 0.08, n + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, n + dur);
      o.connect(g); g.connect(master); o.start(n); o.stop(n + dur + 0.05);
    }
    return {
      toggle: function () { set(!on); },
      // 페이즈 바뀔 때: 자기장 줄어드는 신호음(두 음)
      blip: function (k) { tone(392 + k * 49, 0.5, "sine", 0.07); setTimeout(function () { tone(588 + k * 49, 0.6, "sine", 0.05); }, 110);
        if (bed && ac) bed.bp.frequency.setTargetAtTime(700 + k * 140, ac.currentTime, 0.8); },
      tick: function () { tone(1800, 0.05, "square", 0.012); },
      init: function () {
        document.querySelectorAll(".snd").forEach(function (b) { b.addEventListener("click", function () { Sound.toggle(); }); });
        // 저장된 선택이 켜짐이어도 자동 재생은 하지 않는다(브라우저 정책 · 첫 클릭 때 켠다)
        var saved = null; try { saved = localStorage.getItem("mri_sound"); } catch (e) {}
        if (saved === "1") document.addEventListener("pointerdown", function once() { document.removeEventListener("pointerdown", once); if (!on) set(true); }, { once: true });
        document.addEventListener("pointerover", function (e) { if (e.target.closest && e.target.closest(".btn")) Sound.tick(); });
      }
    };
  })();
  Sound.init();

  // ── 공개 지표(최근 30일) — 값이 숫자로 올 때만 연다 ──────
  (function () {
    var box = document.getElementById("stats"); if (!box) return;
    function ok(n) { return typeof n === "number" && isFinite(n) && n > 0; }
    fetch("https://mri-academy-production.up.railway.app/api/site-metrics", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !ok(d.students30) || !ok(d.games30)) return;
        box.querySelector("[data-k=students]").setAttribute("data-count", d.students30);
        box.querySelector("[data-k=games]").setAttribute("data-count", d.games30);
        box.hidden = false; window.MRI_watch(box);
      }).catch(function () {});
  })();

  resize(); readScroll(); onPhase(phaseIdx); kick();
})();
