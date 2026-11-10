// 잠소리 — 차트 (손으로 그리는 SVG)
// 색은 모두 CSS 변수(styles.css)에서 가져와서 다크/라이트 모드를 따라갑니다.

import { fmtClock } from './analysis.js';

const LV = ['', '약', '중', '강'];

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 위가 둥근 막대 (아래는 기준선에 붙어 각짐) */
function colPath(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function makeTip(el) {
  let tip = el.querySelector('.tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    el.appendChild(tip);
  }
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.hidden = false;
      const w = tip.offsetWidth, cw = el.clientWidth;
      const left = Math.max(0, Math.min(cw - w, x - w / 2));
      tip.style.left = left + 'px';
      tip.style.top = Math.max(0, y - tip.offsetHeight - 10) + 'px';
    },
    hide() { tip.hidden = true; },
  };
}

function hookHover(el, svg, onMove, tip) {
  const hit = svg.querySelector('.hit');
  const hl = svg.querySelector('.hl');
  const handle = (ev) => {
    const r = svg.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const res = onMove(x);
    if (!res) { tip.hide(); hl?.setAttribute('width', 0); return; }
    if (hl) { hl.setAttribute('x', res.x); hl.setAttribute('width', res.w); }
    tip.show(res.html, res.cx, res.ty);
  };
  hit.addEventListener('pointermove', handle);
  hit.addEventListener('pointerdown', handle);
  hit.addEventListener('pointerleave', () => { tip.hide(); hl?.setAttribute('width', 0); });
}

/** 밤사이 흐름: 막대 높이 = 분당 코골이 횟수, 색 = 강도, 빨간 삼각형 = 호흡 멈춤 의심 */
export function timeline(el, a, night) {
  const W = Math.max(280, el.clientWidth || 640);
  const H = 176;
  const padL = 30, padR = 6, padT = 24;
  const plotH = 118;
  const base = padT + plotH;
  const laneY = base + 12;
  const plotW = W - padL - padR;
  const N = a.minutes.length;
  const binMin = Math.max(1, Math.ceil(N / Math.floor(plotW / 4)));
  const nb = Math.ceil(N / binMin);
  const bins = [];
  for (let b = 0; b < nb; b++) {
    const ms = a.minutes.slice(b * binMin, (b + 1) * binMin);
    let c = 0, lvl = 0, ap = 0, sm = 0, ex = true, gap = true;
    for (const m of ms) {
      if (m.snore) { c += m.c; sm++; lvl = Math.max(lvl, m.lvl); }
      ap += m.ap;
      ex = ex && m.ex;
      gap = gap && m.gap;
    }
    bins.push({ m0: b * binMin, m1: b * binMin + ms.length, rate: c / ms.length, lvl, ap, sm, ex, gap, n: ms.length });
  }
  const maxRate = Math.max(...bins.map((b) => b.rate), 0);
  const ymax = Math.max(20, Math.ceil(maxRate / 5) * 5);
  const y = (v) => base - (v / ymax) * plotH;
  const bw = plotW / nb;
  const gapPx = bw >= 4 ? 1 : 0.5;

  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="밤사이 분당 코골이 횟수와 강도">`;
  // 제외 구간 / 끊긴 구간
  const exEnd = bins.findIndex((b) => !b.ex);
  if (exEnd > 0) {
    s += `<rect class="ex" x="${padL}" y="${padT}" width="${exEnd * bw}" height="${plotH}"/>`;
    if (exEnd * bw > 34) s += `<text class="ax" x="${padL + 4}" y="${padT + 13}">제외</text>`;
  }
  bins.forEach((b, i) => { if (b.gap) s += `<rect class="gapr" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${plotH}"/>`; });
  // 격자
  for (const v of [0, ymax / 2, ymax]) {
    s += `<line class="${v === 0 ? 'base' : 'grid'}" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text class="ax" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  s += `<text class="ax" x="0" y="11">회/분</text>`;
  // 시각 눈금
  const startMs = night.start;
  const endMs = startMs + N * 60000;
  const hourMs = 3600000;
  const step = plotW / (N / 60) < 46 ? 2 : 1;
  let tick = Math.ceil(startMs / hourMs) * hourMs;
  for (; tick < endMs; tick += hourMs) {
    const h = new Date(tick).getHours();
    if (h % step) continue;
    const x = padL + ((tick - startMs) / 60000 / N) * plotW;
    s += `<line class="grid" x1="${x}" x2="${x}" y1="${base}" y2="${base + 4}"/>`;
    s += `<text class="ax" x="${x}" y="${H - 4}" text-anchor="middle">${h}시</text>`;
  }
  // 하이라이트 (호버)
  s += `<rect class="hl" x="0" y="${padT}" width="0" height="${plotH + 22}"/>`;
  // 막대
  bins.forEach((b, i) => {
    if (b.rate <= 0) return;
    const x = padL + i * bw + gapPx / 2;
    const w = Math.max(0.8, bw - gapPx);
    const top = y(b.rate);
    const h = base - top;
    s += bw >= 8 ? `<path class="lv${b.lvl}" d="${colPath(x, top, w, h, 4)}"/>` : `<rect class="lv${b.lvl}" x="${x}" y="${top}" width="${w}" height="${h}"/>`;
  });
  // 호흡 멈춤 의심
  bins.forEach((b, i) => {
    if (!b.ap) return;
    const cx = padL + (i + 0.5) * bw;
    s += `<path class="ap" d="M${cx},${laneY - 5} L${cx + 5},${laneY + 4} L${cx - 5},${laneY + 4} Z"/>`;
  });
  s += `<rect class="hit" x="${padL}" y="0" width="${plotW}" height="${H}"/>`;
  s += '</svg>';
  el.innerHTML = s;
  const svg = el.querySelector('svg');
  const tip = makeTip(el);
  hookHover(el, svg, (x) => {
    const i = Math.floor((x - padL) / bw);
    const b = bins[i];
    if (!b) return null;
    const t0 = fmtClock(startMs + b.m0 * 60000), t1 = fmtClock(startMs + b.m1 * 60000);
    const amb = night.amb?.[b.m0];
    let html = `<b>${t0}–${t1}</b>`;
    if (b.ex) html += '<span>잠드는 시간으로 보고 제외</span>';
    else if (b.gap) html += '<span>녹음이 끊긴 구간</span>';
    else if (b.sm) html += `<span>코골이 ${b.rate.toFixed(1)}회/분 · 강도 ${LV[b.lvl]}</span><span>코골이 ${b.sm}분 / ${b.n}분</span>`;
    else html += '<span>코골이 없음</span>';
    if (b.ap) html += `<span class="tip-ap">호흡 멈춤 의심 ${b.ap}회</span>`;
    if (amb != null && !b.ex) html += `<span class="tip-mute">바닥 소음 ${amb} dBFS</span>`;
    return { x: padL + i * bw, w: bw, cx: padL + (i + 0.5) * bw, ty: padT + 6, html };
  }, tip);
}

/** 시간대별: 시계 기준 1시간마다 코골이 분 */
export function hourly(el, a, night) {
  const rows = hourlyRows(a, night);
  const W = Math.max(280, el.clientWidth || 640);
  const H = 176;
  const padL = 30, padR = 6, padT = 24, plotH = 118;
  const base = padT + plotH;
  const plotW = W - padL - padR;
  const n = rows.length || 1;
  const slot = plotW / n;
  const bw = Math.min(24, slot * 0.62);
  const maxV = Math.max(...rows.map((r) => r.snore), 0);
  const ymax = Math.min(60, Math.max(10, Math.ceil(maxV / 10) * 10));
  const y = (v) => base - (v / ymax) * plotH;
  const peak = rows.reduce((best, r, i) => (r.snore > (rows[best]?.snore ?? -1) ? i : best), 0);

  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="시간대별 코골이 분">`;
  for (const v of [0, ymax / 2, ymax]) {
    s += `<line class="${v === 0 ? 'base' : 'grid'}" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text class="ax" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  s += `<text class="ax" x="0" y="11">분</text>`;
  s += `<rect class="hl" x="0" y="${padT}" width="0" height="${plotH}"/>`;
  rows.forEach((r, i) => {
    const cx = padL + (i + 0.5) * slot;
    if (r.snore > 0) s += `<path class="lv2" d="${colPath(cx - bw / 2, y(r.snore), bw, base - y(r.snore), 4)}"/>`;
    if (r.ap) s += `<path class="ap" d="M${cx},${base + 4} L${cx + 4},${base + 11} L${cx - 4},${base + 11} Z"/>`;
    if (n <= 12 || i % 2 === 0) s += `<text class="ax" x="${cx}" y="${H - 2}" text-anchor="middle">${r.hour}시</text>`;
    if (i === peak && r.snore > 0) s += `<text class="val" x="${cx}" y="${y(r.snore) - 6}" text-anchor="middle">${r.snore}분</text>`;
  });
  s += `<rect class="hit" x="${padL}" y="0" width="${plotW}" height="${H}"/>`;
  s += '</svg>';
  el.innerHTML = s;
  const svg = el.querySelector('svg');
  const tip = makeTip(el);
  hookHover(el, svg, (x) => {
    const i = Math.floor((x - padL) / slot);
    const r = rows[i];
    if (!r) return null;
    const html = `<b>${r.hour}시대</b><span>코골이 ${r.snore}분 / 기록 ${r.total}분</span><span>강한 코골이 ${r.loud}분</span>${r.ap ? `<span class="tip-ap">호흡 멈춤 의심 ${r.ap}회</span>` : ''}`;
    return { x: padL + i * slot, w: slot, cx: padL + (i + 0.5) * slot, ty: Math.min(y(r.snore), base - 20), html };
  }, tip);
  return rows;
}

export function hourlyRows(a, night) {
  const map = new Map();
  for (const m of a.minutes) {
    const ms = night.start + m.i * 60000;
    const d = new Date(ms);
    const key = Math.floor(ms / 3600000);
    if (!map.has(key)) map.set(key, { hour: d.getHours(), total: 0, snore: 0, loud: 0, ap: 0 });
    const r = map.get(key);
    if (m.ex || m.gap) continue;
    r.total++;
    if (m.snore) r.snore++;
    if (m.lvl === 3) r.loud++;
    r.ap += m.ap;
  }
  return [...map.values()].filter((r) => r.total > 0);
}

/** 여러 밤: 밤별 코골이 비율 */
export function trend(el, rows, { onPick } = {}) {
  // rows: 오래된 순 [{ night, a }]
  const W = Math.max(280, el.clientWidth || 640);
  const H = 180;
  const padL = 34, padR = 6, padT = 18, plotH = 124;
  const base = padT + plotH;
  const plotW = W - padL - padR;
  const n = rows.length || 1;
  const slot = plotW / n;
  const bw = Math.min(24, slot * 0.6);
  const maxV = Math.max(...rows.map((r) => r.a.snorePct), 0);
  const ymax = Math.min(100, Math.max(20, Math.ceil(maxV / 20) * 20));
  const y = (v) => base - (v / ymax) * plotH;
  const latest = rows.length - 1;

  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="밤별 코골이 비율">`;
  for (const v of [0, ymax / 2, ymax]) {
    s += `<line class="${v === 0 ? 'base' : 'grid'}" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text class="ax" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
  }
  s += `<rect class="hl" x="0" y="${padT}" width="0" height="${plotH}"/>`;
  rows.forEach((r, i) => {
    const cx = padL + (i + 0.5) * slot;
    const v = r.a.snorePct;
    if (v > 0) s += `<path class="${i === latest ? 'lv3' : 'lv2'}" d="${colPath(cx - bw / 2, y(v), bw, base - y(v), 4)}"/>`;
    if (n <= 10 || i % 2 === latest % 2) s += `<text class="ax" x="${cx}" y="${H - 2}" text-anchor="middle">${esc(r.short)}</text>`;
    if (i === latest) s += `<text class="val" x="${cx}" y="${y(v) - 6}" text-anchor="middle">${Math.round(v)}%</text>`;
  });
  s += `<rect class="hit" x="${padL}" y="0" width="${plotW}" height="${H}"/>`;
  s += '</svg>';
  el.innerHTML = s;
  const svg = el.querySelector('svg');
  const tip = makeTip(el);
  hookHover(el, svg, (x) => {
    const i = Math.floor((x - padL) / slot);
    const r = rows[i];
    if (!r) return null;
    const facs = r.factorLabels?.length ? `<span class="tip-mute">${esc(r.factorLabels.join(', '))}</span>` : '';
    const html = `<b>${esc(r.long)}</b><span>코골이 ${Math.round(r.a.snorePct)}% (${r.a.snoreMinutes}분)</span><span>호흡 멈춤 의심 ${r.a.apneaIndex.toFixed(1)}회/시간</span>${facs}`;
    return { x: padL + i * slot, w: slot, cx: padL + (i + 0.5) * slot, ty: Math.min(y(r.a.snorePct), base - 20), html };
  }, tip);
  if (onPick) {
    svg.querySelector('.hit').addEventListener('click', (ev) => {
      const r = svg.getBoundingClientRect();
      const i = Math.floor((ev.clientX - r.left - padL) / slot);
      if (rows[i]) onPick(rows[i].night.id);
    });
  }
}
