"use strict";
// 킬내기 결과 포스터(docs/killrace-api.md §1.9 · 소관 GmI · 카지노 트랙 휴면 중 MRIacademy 대행) — 대회 최종 순위 한 장.
// 그리기 = SVG 문자열 → PNG(@resvg/resvg-js · 브라우저를 띄우지 않는다). 글꼴 = fonts/Pretendard-*.otf(SIL OFL 1.1 · 저장소 동봉 ·
//   파일 경로로 직접 넘긴다 · 시스템 글꼴 안 씀). sharp 는 복기 사진 쪽이 SVG 해독기를 프로세스 전체에서 막아 둬서(review-api.cjs) 쓰지 않는다.
// 숫자는 전부 killrace.players()(개인 기록 화면 · 점수판과 같은 계산)에서 받는다 — 여기서 점수를 다시 세지 않는다.
// 머리 오른쪽 위 GmI 로고(img/gmi-logo.png) · 맨 아래 「GmI 클랜 입단 안내」 띠 + 디스코드 QR(오너 10/6 · 계약 §1.9).
// 닉은 인게임(스팀) 닉만 쓴다. 디스코드 닉 · 계정 번호 · 경매 가격 · 상금은 이 그림에 넣지 않는다.
// 게시: 오너가 /킬내기포스터 켜기 로 채널을 고른 뒤에만, 창 끝 + 45분(막판 집계 끝)이 지난 회차를 한 번 올린다.
//   설정 = ops_state 'killrace:poster' { on, channelId } · 회차 표시 = ops_state 'killrace:poster:<id>' { status, at, … } (env · DDL 없음).
//   표시는 올리기 전에 삽입으로 잡는다(같은 키가 있으면 삽입이 실패 = 다른 인스턴스가 먼저 잡음) — 같은 회차를 두 번 올리지 않는다.
//   그리기 · 올리기가 실패하면 표시를 failed 로 바꾸고 로그만 남긴다(다시 해 보지 않는다). 집계 · 점수판과는 따로 돈다.
const fs = require("fs");
const path = require("path");

const W = 1080;
const C = {                      // killnaegi-*.html 라이트 테마와 같은 값
  bg: "#F5F6F8", card: "#FFFFFF", line: "#E3E6EB", ink: "#172033", inkDim: "#4E5869", inkFaint: "#6B7484",
  accent: "#2F6FEB", accentSoft: "#EAF1FF", accentInk: "#1D4FB8", red: "#D93A2B", cream: "#FFF4E0", creamLine: "#F1E3C4", sun: "#F59E0B",
};
const FONT = "Pretendard";
const TOP_N = 5;                 // 개인 킬 상위 — 5위 동점이면 같이 싣되 7줄까지
const TOP_MAX_ROWS = 7;
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

// GmI 로고(오너 10/6 · img/gmi-logo.png · 480×429 · 배경 투명) — 그릴 때 한 번 읽어 data URI 로 넣는다. 파일이 없으면 로고 없이 그린다
const LOGO_FILE = path.join(__dirname, "img", "gmi-logo.png");
const LOGO_RATIO = 480 / 429;
let logoUri;                     // undefined = 아직 안 읽음 · null = 못 읽음
function logoDataUri() {
  if (logoUri === undefined) {
    try { logoUri = "data:image/png;base64," + fs.readFileSync(LOGO_FILE).toString("base64"); } catch (e) { logoUri = null; }
  }
  return logoUri;
}
// 마무리 칸 — GmI 클랜 입단 안내(오너 10/6). 기준 줄은 오너가 준 글 그대로만 싣는다(비어 있으면 제목 · 안내 · QR 만, 3줄까지).
//   기준 · 안내 글 = 오너가 룰 영상 녹음에서 말한 세 줄(지휘 10/7 전달). 초대 주소는 만료 없는 초대(오너 10/7 확인)
const RECRUIT = {
  title: "GmI 클랜 입단 안내",
  lines: ["마스터 · 평딜 200 이상 → 정식 클랜원", "다이아 · 평딜 170 이상 → 레슨생 트랙"],
  cta: "QR 찍고 디스코드로 오세요",
  link: "discord.gg/YfZD8d22wJ",
};
// GmI 디스코드 초대 QR(https://discord.gg/YfZD8d22wJ) — 버전 3 · 29×29 · 오류 정정 Q · 마스크 2 · 한 줄 = 한 행 · 1 = 검은 칸.
//   저장소 밖에서 한 번 만들어 붙였다(node-qrcode 1.5.4 · 저장소 의존성 아님) · 다른 구현(jsQR 1.4.0)으로 되읽어 같은 주소인지 봤다.
//   주소가 바뀌면 다시 만들어 붙이고 RECRUIT.link 도 같이 고친다
const GMI_QR = [
  "11111110100111111001101111111",
  "10000010010101100110001000001",
  "10111010010011011001001011101",
  "10111010001111010100101011101",
  "10111010101100010011101011101",
  "10000010111110110100101000001",
  "11111110101010101010101111111",
  "00000000010001101000000000000",
  "01111111010101010001100110001",
  "01000101110011111011010111001",
  "00010011000110111110011001100",
  "00100101001111100001011000010",
  "01110111010100110100010100111",
  "01001001111101001111111011011",
  "11110011111001110110000100000",
  "01001100111101100010110011001",
  "10001111111011110010110111100",
  "11001100111001011111001111111",
  "10011110100100100100001001100",
  "10001101011011101000101111000",
  "10010111100010000100111111001",
  "00000000110000000100100011011",
  "11111110100001110101101010000",
  "10000010101110111111100011011",
  "10111010100111011000111111101",
  "10111010111000010011110100100",
  "10111010100000011111111111010",
  "10000010111001010010111011010",
  "11111110001101010101010010100",
];
const QR_M = 6, QR_QUIET = 4;    // 칸 6px · 둘레 흰 칸 4개(QR 규격 최소 여백)

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const minus = (n) => (n < 0 ? "−" + Math.abs(n) : String(n));
const signed = (n) => (n > 0 ? "+" + n : n < 0 ? "−" + Math.abs(n) : "0");
const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const kst = (ms) => new Date(ms + 9 * 3600e3);
const hm = (ms) => { const d = kst(ms); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); };
const dateLine = (start, end) => { const d = kst(start); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DAYS[d.getUTCDay()]}) ${hm(start)}~${hm(end)}`; };
const roundOf = (name) => { const m = /(\d+)\s*회/.exec(name || ""); return m ? m[1] + "회" : ""; };

// 글자 폭 어림(글꼴 크기 1 기준) — 그리기 전에 잘라야 해서 대충 잰다. 한글 1 · 대문자 · 숫자 0.62 · 소문자 0.55 · 그 밖 0.45
function units(s) {
  let u = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    u += c >= 0x1100 && (c <= 0x11ff || (c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3)) ? 1
      : /[A-Z0-9]/.test(ch) ? 0.62 : /[a-z]/.test(ch) ? 0.55 : 0.45;
  }
  return u;
}
// maxPx 안에 들어가게 — 먼저 글꼴을 minSize 까지 줄이고, 그래도 넘치면 뒤를 「…」 로 자른다
function fit(text, size, maxPx, minSize = size) {
  let s = String(text || "");
  let sz = size;
  while (sz > minSize && units(s) * sz > maxPx) sz -= 2;
  if (units(s) * sz <= maxPx) return { text: s, size: sz };
  const chars = [...s];
  while (chars.length > 1 && (units(chars.join("")) + 1) * sz > maxPx) chars.pop();
  return { text: chars.join("") + "…", size: sz };
}

// players() 결과 → 그림에 들어갈 값만.
// MVP = 판당 킬 + 판당 딜 100당 1점 1위(지휘 10/7 — 많이 돈 팀이 유리한 합계 방식은 안 쓴다) · 그 회차에서 MVP_MIN_GAMES 판 이상 뛴 선수만 후보.
//   같으면 판당 킬 · 판당 딜 · 판 수 많은 쪽 · 적은 사망 · 닉 순. 비교는 소수 넷째 자리까지 맞춰서 한다(부동소수 오차로 순서가 흔들리지 않게)
const MVP_MIN_GAMES = 4;
const per = (n, games) => (games > 0 ? (Number(n) || 0) / games : 0);
function mvpRating(p) { const g = Number(p.games) || 0; return per((Number(p.kills) || 0) + (Number(p.damage) || 0) / 100, g); }
const q4 = (x) => Math.round(x * 10000);
function posterData(p) {
  const ev = (p && p.event) || {};
  const teams = ((p && p.teams) || []).map((t) => ({ rank: t.rank, name: t.name, total: Number(t.total) || 0, kills: Number(t.kills) || 0,
    games: Number(t.games) || 0, bonus: Number(t.bonus) || 0 }));
  const all = ((p && p.byKills) || []).filter((x) => (Number(x.games) || 0) > 0);
  const top = all.filter((x) => x.rank <= TOP_N && x.kills > 0).slice(0, TOP_MAX_ROWS)
    .map((x) => ({ rank: x.rank, ign: x.ign, team: x.team, kills: x.kills }));
  const cands = all.filter((x) => (Number(x.games) || 0) >= MVP_MIN_GAMES);
  const best = cands.slice().sort((a, b) => q4(mvpRating(b)) - q4(mvpRating(a)) || q4(per(b.kills, b.games)) - q4(per(a.kills, a.games))
    || q4(per(b.damage, b.games)) - q4(per(a.damage, a.games)) || b.games - a.games || a.deaths - b.deaths || String(a.ign).localeCompare(String(b.ign)))[0];
  const mvp = best && mvpRating(best) > 0
    ? { ign: best.ign, team: best.team, kills: best.kills, damage: best.damage, games: best.games,
      perGame: Math.round(mvpRating(best) * 100) / 100, kpg: Math.round(per(best.kills, best.games) * 10) / 10, dpg: Math.round(per(best.damage, best.games)) } : null;
  return { name: ev.name || "", round: roundOf(ev.name), date: Number.isFinite(ev.start) && Number.isFinite(ev.end) ? dateLine(ev.start, ev.end) : "",
    teams, top, mvp, mvpFew: !mvp && all.length > 0 && !cands.length };
}

const t = (x, y, size, weight, fill, body, extra = "") =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}"${extra}>${body}</text>`;

const PAD = 40;
const logoImg = (x, y, h, uri) => `<image x="${x}" y="${y}" width="${Math.round(h * LOGO_RATIO)}" height="${h}" href="${uri}"/>`;
// QR — 가로로 이어진 검은 칸을 한 조각으로 그린다(crispEdges · 칸 사이에 틈이 안 생기게)
function qrPath(x0, y0, m, fill) {
  let dd = "";
  GMI_QR.forEach((row, r) => {
    for (let c = 0; c < row.length;) {
      if (row[c] !== "1") { c++; continue; }
      let e = c;
      while (e < row.length && row[e] === "1") e++;
      dd += `M${x0 + c * m} ${y0 + r * m}h${(e - c) * m}v${m}h-${(e - c) * m}z`;
      c = e;
    }
  });
  return `<path d="${dd}" fill="${fill}" shape-rendering="crispEdges"/>`;
}
// 마무리 칸(남색 띠) — 왼쪽 글(제목 · 기준 줄 · 안내 · 주소) · 오른쪽 흰 카드에 QR. 띠 높이를 돌려준다
function recruitBand(out, y0, rc) {
  const card = (GMI_QR.length + QR_QUIET * 2) * QR_M;
  const lines = (rc.lines || []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 3);
  const n = lines.length;
  const textH = 44 + 26 + n * 44 + (n ? 14 : 6) + 34 + 40;        // 제목 · 기준 줄 · 안내 · 주소 기준선 간격의 합
  const BH = Math.max(card, textH) + 76;
  out.push(`<rect x="0" y="${y0}" width="${W}" height="${BH}" fill="${C.ink}"/>`);
  const cardX = W - PAD - card, cardY = y0 + Math.round((BH - card) / 2);
  out.push(`<rect x="${cardX}" y="${cardY}" width="${card}" height="${card}" rx="14" fill="#FFFFFF"/>`,
    qrPath(cardX + QR_QUIET * QR_M, cardY + QR_QUIET * QR_M, QR_M, C.ink));
  const tx = PAD + 12, maxW = cardX - 40 - tx;
  let ty = y0 + Math.round((BH - textH) / 2) + 35;
  const hd = fit(rc.title, 44, maxW, 30);
  out.push(t(tx, ty, hd.size, 800, "#FFFFFF", esc(hd.text)));
  ty += 26;
  for (const s of lines) {
    ty += 44;
    const f = fit(s, 28, maxW - 26, 22);
    out.push(`<circle cx="${tx + 7}" cy="${ty - 10}" r="5" fill="${C.sun}"/>`, t(tx + 26, ty, f.size, 600, "#FFFFFF", esc(f.text)));
  }
  ty += (n ? 14 : 6) + 34;
  const ca = fit(rc.cta, 26, maxW, 20);
  out.push(t(tx, ty, ca.size, 600, "#C9D1DE", esc(ca.text)));
  ty += 40;
  const lk = fit(rc.link, 28, maxW, 20);
  out.push(t(tx, ty, lk.size, 800, C.sun, esc(lk.text)));
  return BH;
}

// opts 는 시험용(로고 없이 · 기준 줄 바꿔 그리기) — 게시 · 미리 보기는 기본값으로 그린다
function posterSvg(d, { logo = logoDataUri(), recruit = RECRUIT } = {}) {
  const out = [];
  const CW = W - PAD * 2;
  // ── 머리 ──
  const HEAD = 290;
  out.push(`<rect x="0" y="0" width="${W}" height="${HEAD}" fill="${C.cream}"/>`, `<rect x="0" y="${HEAD - 2}" width="${W}" height="2" fill="${C.creamLine}"/>`);
  if (d.date) out.push(t(PAD + 12, 76, 28, 600, C.inkDim, esc(d.date)));
  const title = d.round ? `킬내기 <tspan fill="${C.sun}">${esc(d.round)}</tspan> 최종 순위` : "킬내기 최종 순위";
  out.push(t(PAD + 8, 170, 86, 800, C.ink, title));
  const nm = fit(d.name, 32, CW - 24, 24);
  out.push(t(PAD + 12, 238, nm.size, 600, C.inkDim, esc(nm.text)));
  // 오른쪽 위 로고(190×170) — 날짜 · 제목 줄의 오른쪽 빈자리. 제목은 세 자리 회차여도 x ≈ 830 에서 끝나고(로고 850~), 대회 이름 줄(238) 위에서 끝난다
  const LOGO_H = 170;
  if (logo) out.push(logoImg(W - PAD - Math.round(LOGO_H * LOGO_RATIO), 30, LOGO_H, logo));
  // ── 팀 순위 ──
  let y = HEAD + 34;
  const ROW = 88, TH = 64;
  const tableH = TH + Math.max(1, d.teams.length) * ROW + 8;
  out.push(`<rect x="${PAD}" y="${y}" width="${CW}" height="${tableH}" rx="24" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>`);
  const col = { rank: PAD + 58, name: PAD + 112, total: PAD + 610, kills: PAD + 740, games: PAD + 840, bonus: PAD + CW - 34 };
  const hy = y + 44;
  out.push(t(col.rank, hy, 24, 600, C.inkFaint, "순위", ` text-anchor="middle"`), t(col.name, hy, 24, 600, C.inkFaint, "팀"),
    t(col.total, hy, 24, 600, C.inkFaint, "점수", ` text-anchor="end"`), t(col.kills, hy, 24, 600, C.inkFaint, "킬", ` text-anchor="end"`),
    t(col.games, hy, 24, 600, C.inkFaint, "판", ` text-anchor="end"`), t(col.bonus, hy, 24, 600, C.inkFaint, "시작 보너스", ` text-anchor="end"`));
  d.teams.forEach((tm, i) => {
    const ry = y + TH + i * ROW;
    if (tm.rank === 1) out.push(`<rect x="${PAD + 10}" y="${ry + 4}" width="${CW - 20}" height="${ROW - 8}" rx="16" fill="${C.cream}" stroke="${C.sun}" stroke-width="2"/>`);
    else out.push(`<rect x="${PAD + 24}" y="${ry}" width="${CW - 48}" height="1.5" fill="${C.line}"/>`);
    const by = ry + ROW / 2 + 15;
    out.push(t(col.rank, by + 2, 46, 800, tm.rank === 1 ? C.sun : C.ink, String(tm.rank), ` text-anchor="middle"`));
    const n = fit(tm.name, 38, col.total - col.name - 150, 28);
    out.push(t(col.name, by, n.size, 800, C.ink, esc(n.text)));
    out.push(t(col.total, by + 2, 50, 800, tm.total < 0 ? C.red : C.ink, minus(tm.total), ` text-anchor="end"`));
    out.push(t(col.kills, by, 34, 600, C.inkDim, String(tm.kills), ` text-anchor="end"`));
    out.push(t(col.games, by, 34, 600, C.inkDim, String(tm.games), ` text-anchor="end"`));
    out.push(t(col.bonus, by, 34, 600, tm.bonus < 0 ? C.red : tm.bonus > 0 ? C.accentInk : C.inkFaint, tm.bonus ? signed(tm.bonus) : "–", ` text-anchor="end"`));
  });
  if (!d.teams.length) out.push(t(W / 2, y + TH + ROW / 2 + 12, 32, 600, C.inkFaint, "등록된 팀이 없어요", ` text-anchor="middle"`));
  y += tableH + 28;
  // ── 개인 킬 상위 · MVP ──
  const LW = 600, RX = PAD + LW + 20, RW = CW - LW - 20;
  const LROW = 56;
  const leftH = 92 + Math.max(1, d.top.length) * LROW + 20;
  const boxH = Math.max(leftH, 460);
  out.push(`<rect x="${PAD}" y="${y}" width="${LW}" height="${boxH}" rx="24" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>`);
  out.push(t(PAD + 32, y + 58, 34, 800, C.ink, "개인 킬 TOP 5"));
  d.top.forEach((p, i) => {
    const ry = y + 92 + i * LROW + 38;
    out.push(t(PAD + 48, ry, 30, 800, p.rank === 1 ? C.sun : C.ink, String(p.rank), ` text-anchor="middle"`));
    const tn = fit(p.team, 22, 110, 18);
    out.push(t(PAD + LW - 126, ry, tn.size, 600, C.inkFaint, esc(tn.text), ` text-anchor="end"`));
    const ig = fit(p.ign, 30, LW - 126 - 84 - Math.min(110, units(tn.text) * tn.size) - 20, 22);
    out.push(t(PAD + 84, ry, ig.size, 600, C.ink, esc(ig.text)));
    out.push(t(PAD + LW - 32, ry, 34, 800, C.ink, `${p.kills}<tspan font-size="24" font-weight="600" fill="${C.inkFaint}"> 킬</tspan>`, ` text-anchor="end"`));
  });
  if (!d.top.length) out.push(t(PAD + 32, y + 140, 28, 600, C.inkFaint, "킬 기록이 아직 없어요"));
  out.push(`<rect x="${RX}" y="${y}" width="${RW}" height="${boxH}" rx="24" fill="${C.accentSoft}"/>`);
  out.push(`<rect x="${RX + 30}" y="${y + 30}" width="96" height="44" rx="22" fill="${C.accent}"/>`, t(RX + 78, y + 61, 26, 800, "#FFFFFF", "MVP", ` text-anchor="middle"`));
  if (d.mvp) {
    const mv = fit(d.mvp.ign, 44, RW - 60, 26);
    out.push(t(RX + 30, y + 138, mv.size, 800, C.ink, esc(mv.text)));
    const mt = fit(d.mvp.team, 28, RW - 60, 22);
    out.push(t(RX + 30, y + 180, mt.size, 600, C.accentInk, esc(mt.text)));
    out.push(t(RX + 30, y + 290, 104, 800, C.accentInk, `${d.mvp.perGame.toFixed(2)}<tspan font-size="36" font-weight="600" fill="${C.inkDim}"> 점</tspan>`));
    const st = fit(`판당 킬 ${d.mvp.kpg.toFixed(1)} · 판당 딜 ${comma(d.mvp.dpg)}`, 26, RW - 60, 20);
    out.push(t(RX + 30, y + 338, st.size, 600, C.ink, esc(st.text)));
    out.push(t(RX + 30, y + 374, 22, 600, C.inkDim, `킬 ${d.mvp.kills}  딜 ${comma(d.mvp.damage)}  ${d.mvp.games}판`));
    out.push(t(RX + 30, y + 410, 20, 600, C.inkFaint, "판당 킬 + 판당 딜 100당 1점"));
    out.push(t(RX + 30, y + 438, 20, 600, C.inkFaint, `${MVP_MIN_GAMES}판 이상 뛴 사람만 후보예요`));
  } else out.push(t(RX + 30, y + 140, 28, 600, C.inkDim, d.mvpFew ? `${MVP_MIN_GAMES}판 이상 뛴 사람이 없어요` : "기록이 아직 없어요"));
  y += boxH + 44;
  out.push(t(W / 2, y, 24, 600, C.inkFaint, "점수는 킬내기 점수판과 같은 계산이에요", ` text-anchor="middle"`));
  y += 40;
  // ── 마무리 — GmI 클랜 입단 안내 · 디스코드 QR ──
  const H = y + recruitBand(out, y, recruit);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>` + out.join("") + "</svg>";
}

// ── PNG — @resvg/resvg-js 는 그릴 때만 불러온다(없거나 깨져도 서버 · 봇 · 집계는 뜬다 · 포스터만 「못 그려요」) ──
const FONT_FILES = ["Pretendard-ExtraBold.otf", "Pretendard-SemiBold.otf"].map((f) => path.join(__dirname, "fonts", f));
let Resvg = null, resvgError = null;
function loadResvg() {
  if (!Resvg && !resvgError) {
    try { Resvg = require("@resvg/resvg-js").Resvg; }
    catch (e) { resvgError = String((e && e.message) || "load_failed").split("\n")[0].slice(0, 120); }
  }
  return Resvg;
}
function renderPng(svg) {
  const R = loadResvg();
  if (!R) throw Object.assign(new Error(`renderer_missing ${resvgError || ""}`.trim()), { code: "renderer_missing" });
  return new R(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: FONT }, fitTo: { mode: "original" } }).render().asPng();
}

// ── 슬래시 명령(GmI 길드 · server.js registerLessonCmd 가 킬내기 명령 뒤에 붙인다) — 오너 전용 ──
const CMD = "킬내기포스터";
const COMMANDS = [{
  name: CMD,
  description: "[오너] 킬내기 최종 순위 포스터 — 미리 보기 · 자동 게시 켜기 · 끄기 · 지금 한 번 게시",
  options: [
    { type: 1, name: "미리보기", description: "나만 보이게 받아 봐요(채널에는 안 올라가요)",
      options: [{ type: 4, name: "회차", description: "대회 번호(비우면 지금 대회)", required: false, min_value: 1, max_value: 9999 }] },
    { type: 1, name: "켜기", description: "대회가 끝나고 45분 뒤 이 채널에 한 번 자동으로 올려요",
      options: [{ type: 7, name: "채널", description: "올릴 채널", required: true, channel_types: [0, 5] }] },
    { type: 1, name: "끄기", description: "자동 게시를 꺼요(미리 보기는 그대로 돼요)" },
    { type: 1, name: "게시", description: "고른 채널에 지금 한 번 올려요(이미 올린 회차는 다시 안 올려요)",
      options: [{ type: 4, name: "회차", description: "대회 번호", required: true, min_value: 1, max_value: 9999 }] },
  ],
}];

const GRACE_MS = 45 * 60e3;          // killrace-live.cjs 와 같은 값 — 창 끝 + 45분 = 막판 집계가 끝난 때
const LATE_MS = 6 * 3600e3;          // 그 뒤 6시간 안에만 자동 게시(켜기 전에 끝난 옛 회차를 몰아 올리지 않게)
const CFG_KEY = "killrace:poster";
const markKey = (id) => `killrace:poster:${id}`;
const liveKey = (id) => `killrace:live:${id}`;
const codeErr = (code) => Object.assign(new Error(code), { code });
const shortErr = (e) => String((e && (e.code || e.message)) || e || "error").replace(/\?\S*/g, "?…").split("\n")[0].slice(0, 80);
const postText = (d) => `🎉 ${d.name || "킬내기"} 최종 순위예요`;

// deps: killrace(createKillrace 결과 · players · eventById · currentEvent) · sbSelect · sbInsert · sbUpsert · getClient() · env · now · log · render(선택 · 시험용)
function createPoster(deps) {
  const { killrace, sbSelect, sbInsert, sbUpsert } = deps;
  const getClient = deps.getClient || (() => null);
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const log = deps.log || console;
  const render = deps.render || renderPng;
  const iso = (ms) => new Date(ms).toISOString();
  let busy = false;

  async function readKey(key) {
    const rows = await sbSelect("ops_state", `select=value&key=eq.${encodeURIComponent(key)}&limit=1`);
    return rows.length && rows[0].value && typeof rows[0].value === "object" ? rows[0].value : null;
  }
  const writeKey = (key, value) => sbUpsert("ops_state", { key, value, updated_at: iso(now()) }, "key");
  async function loadCfg() {
    const v = (await readKey(CFG_KEY)) || {};
    return { on: v.on === true, channelId: typeof v.channelId === "string" && /^\d{5,25}$/.test(v.channelId) ? v.channelId : null };
  }
  async function saveCfg(patch) {
    const value = { ...(await loadCfg()), ...patch, at: iso(now()) };
    await writeKey(CFG_KEY, value);
    return value;
  }
  async function draw(eventId) {
    const d = posterData(await killrace.players({ eventId }));
    return { d, png: render(posterSvg(d)) };
  }

  // 한 회차 올리기. 표시를 먼저 잡고(삽입) 그린 뒤 올린다 — 실패하면 failed 로 남기고 끝(다시 안 한다)
  async function postEvent(ev, cfg, { manual = false } = {}) {
    const mark = await readKey(markKey(ev.id));
    if (mark && (!manual || mark.status === "posted" || mark.status === "posting")) {
      return { ok: false, code: mark.status === "posted" ? "already_posted" : "already_tried", mark };
    }
    const claim = { status: "posting", at: iso(now()), ...(manual ? { manual: true } : {}) };
    if (mark) await writeKey(markKey(ev.id), claim);              // 오너가 실패 · 건너뜀 회차를 손으로 다시 올릴 때만
    else {
      try { await sbInsert("ops_state", { key: markKey(ev.id), value: claim, updated_at: claim.at }); }
      catch (e) {
        if (e && e.status === 409) return { ok: false, code: "claimed_elsewhere" };   // 같은 키가 이미 있다 — 배포가 겹친 다른 인스턴스가 먼저 잡았다
        log.warn(`[killrace-poster] claim_failed event=${ev.id} ${shortErr(e)}`);       // 표시를 못 잡았으면 그리지도 않는다(다음 차례에 표시부터 다시)
        return { ok: false, code: "claim_failed" };
      }
    }
    try {
      const { d, png } = await draw(ev.id);
      if (!d.teams.length) {
        await writeKey(markKey(ev.id), { status: "skipped", at: iso(now()), reason: "no_teams" });
        return { ok: false, code: "no_teams" };
      }
      const client = getClient();
      if (!client) throw codeErr("bot_offline");
      const ch = await client.channels.fetch(cfg.channelId);
      if (!ch || typeof ch.send !== "function") throw codeErr("channel_unusable");
      const msg = await ch.send({ content: postText(d), files: [{ attachment: png, name: `killrace-${ev.id}.png` }] });
      await writeKey(markKey(ev.id), { status: "posted", at: iso(now()), channelId: cfg.channelId, messageId: msg && msg.id ? String(msg.id) : null, ...(manual ? { manual: true } : {}) });
      log.log(`[killrace-poster] posted event=${ev.id} bytes=${png.length}${manual ? " manual" : ""}`);
      return { ok: true };
    } catch (e) {
      const why = shortErr(e);
      try { await writeKey(markKey(ev.id), { status: "failed", at: iso(now()), error: why }); } catch (e2) { /* 표시는 posting 으로 남는다 = 다시 안 올린다 */ }
      log.warn(`[killrace-poster] post_failed event=${ev.id} ${why}`);
      return { ok: false, code: "failed", error: why };
    }
  }

  // 1분마다(server.js · 집계 tick 과 따로) — 켜져 있고 채널이 있을 때만. 창 끝 + 45분이 지난(6시간 안) 회차 중 표시 없는 것을 올린다
  async function tick() {
    if (busy) return "busy";
    busy = true;
    try {
      const cfg = await loadCfg();
      if (!cfg.on || !cfg.channelId) return "off";
      if (!getClient()) return "no_bot";                          // 봇이 아직 안 떴으면 표시를 잡지 않고 다음 차례에 본다
      const t = now();
      const q = (ms) => encodeURIComponent(iso(ms));
      const evs = await sbSelect("event_defs", `select=id,name,window_start,window_end&window_end=lte.${q(t - GRACE_MS)}&window_end=gt.${q(t - GRACE_MS - LATE_MS)}&order=window_end.asc&limit=5`);
      let posted = 0;
      for (const e of evs) {
        if (await readKey(markKey(e.id))) continue;
        const ev = { id: e.id, name: e.name, start: Date.parse(e.window_start), end: Date.parse(e.window_end) };
        // 마지막 집계가 실패로 끝났으면 최종 순위가 아닐 수 있다 — 올리지 않고 건너뜀 표시(오너가 고친 뒤 /킬내기포스터 게시 로 올린다)
        const lv = await readKey(liveKey(ev.id));
        if (lv && lv.run && lv.run.ok === false) {
          try { await sbInsert("ops_state", { key: markKey(ev.id), value: { status: "skipped", at: iso(t), reason: "last_run_failed" }, updated_at: iso(t) }); } catch (e2) { /* 먼저 잡혔다 */ }
          log.warn(`[killrace-poster] skipped event=${ev.id} last_run_failed`);
          continue;
        }
        if ((await postEvent(ev, cfg)).ok) posted++;
      }
      return posted ? `posted:${posted}` : "idle";
    } catch (e) { log.warn("[killrace-poster] tick_failed", shortErr(e)); return "error"; }
    finally { busy = false; }
  }

  async function handle(itx) {
    if (!itx || typeof itx.isChatInputCommand !== "function" || !itx.isChatInputCommand() || itx.commandName !== CMD) return;
    if (!env.MRI_OWNER_ID || itx.user.id !== env.MRI_OWNER_ID) return itx.reply({ content: "오너 전용 명령이에요", ephemeral: true });
    if (!env.SUPABASE_URL) return itx.reply({ content: "DB 연결 전이라 아직 못 써요", ephemeral: true });
    await itx.deferReply({ ephemeral: true });
    try {
      const sub = itx.options.getSubcommand();
      if (sub === "미리보기") {
        const id = itx.options.getInteger("회차");
        const ev = id ? await killrace.eventById(id) : await killrace.currentEvent();
        const { png } = await draw(ev.id);
        const cfg = await loadCfg();
        return itx.editReply({ content: `미리 보기예요. 채널에는 안 올라갔어요\n자동 게시 ${cfg.on && cfg.channelId ? `켜짐 · <#${cfg.channelId}>` : "꺼짐"}`,
          files: [{ attachment: png, name: `killrace-${ev.id}-preview.png` }] });
      }
      if (sub === "켜기") {
        const ch = itx.options.getChannel("채널");
        const me = itx.client && itx.client.user;
        const perms = ch && typeof ch.permissionsFor === "function" && me ? ch.permissionsFor(me) : null;
        if (perms && !perms.has(["ViewChannel", "SendMessages", "AttachFiles"])) {
          return itx.editReply({ content: `봇이 <#${ch.id}> 에 사진을 못 올려요. 채널 권한(보기 · 메시지 보내기 · 파일 첨부)을 열어 주세요` });
        }
        await saveCfg({ on: true, channelId: String(ch.id) });
        return itx.editReply({ content: `자동 게시를 켰어요. 대회가 끝나고 45분 뒤 <#${ch.id}> 에 한 번 올라가요` });
      }
      if (sub === "끄기") {
        await saveCfg({ on: false });
        return itx.editReply({ content: "자동 게시를 껐어요. 미리 보기는 그대로 돼요" });
      }
      if (sub === "게시") {
        const ev = await killrace.eventById(itx.options.getInteger("회차"));
        const cfg = await loadCfg();
        if (!cfg.channelId) return itx.editReply({ content: "올릴 채널이 아직 없어요. /킬내기포스터 켜기 로 채널을 먼저 골라 주세요" });
        const r = await postEvent(ev, cfg, { manual: true });
        return itx.editReply({ content: r.ok ? `<#${cfg.channelId}> 에 올렸어요` : r.code === "already_posted" ? "이 회차는 이미 올렸어요"
          : r.code === "no_teams" ? "이 회차는 팀이 없어서 안 올렸어요" : `못 올렸어요 (${r.error || r.code})` });
      }
      return itx.editReply({ content: "모르는 명령이에요" });
    } catch (e) {
      log.warn("[killrace-poster] command_failed", shortErr(e));
      return itx.editReply({ content: e && e.userMsg ? e.userMsg : "포스터를 못 만들었어요. 잠시 후 다시 해볼까요?" }).catch(() => {});
    }
  }

  return { tick, handle, draw, postEvent, loadCfg };
}

module.exports = {
  COMMANDS, createPoster, posterData, posterSvg, renderPng,
  _test: { fit, units, dateLine, roundOf, minus, signed, mvpRating, MVP_MIN_GAMES, postText, GRACE_MS, LATE_MS, CFG_KEY, markKey, FONT_FILES,
    RECRUIT, GMI_QR, LOGO_FILE, logoDataUri },
};
