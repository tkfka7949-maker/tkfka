// 잠소리 — 화면과 흐름
import { analyzeNight, FACTORS, SEV_LABEL, fmtDur, fmtClock, compareFactors, trendInsights, apneaBand } from './analysis.js';
import { NightRecorder, openMic, analyzeFile, ScreenLock } from './recorder.js';
import * as store from './storage.js';
import { timeline, hourly, trend } from './charts.js';
import { makeDemoNights } from './demo.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>';
const FACTOR_LABEL = Object.fromEntries(FACTORS.map((f) => [f.key, f.label]));
const DAY = ['일', '월', '화', '수', '목', '금', '토'];

const state = {
  nights: [],
  currentId: null,
  tonight: new Set(store.loadPref('tonight', [])),
  rec: null,
  mic: null,
  lock: new ScreenLock(),
  timers: [],
  clipSaves: [],
  clipUrls: [],
  cache: new Map(),
  visibleSince: Date.now(),
  statusUntil: 0,
  recovered: false,
};

// ---------- 공통 ----------
function analysisOf(night) {
  const key = [night.id, night.sensitivity, night.end, night.events.length, night.gaps?.length, night.excludeMin, night.factors.join()].join('|');
  let a = state.cache.get(key);
  if (!a) {
    a = analyzeNight(night);
    state.cache.set(key, a);
  }
  return a;
}

/** 자정 넘어 잠들어도 '어젯밤'으로 묶기 위해 12시간 당겨서 날짜를 정함 */
function nightDate(night) {
  return new Date(night.start - 12 * 3600000);
}
function nightLabel(night) {
  const d = nightDate(night);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAY[d.getDay()]}) 밤`;
}
function shortLabel(night) {
  const d = nightDate(night);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function durHtml(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60), mm = m % 60;
  if (!h) return `${mm}<small>분</small>`;
  return `${h}<small>시간</small>${mm ? ` ${mm}<small>분</small>` : ''}`;
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/** 되돌릴 수 없는 버튼은 두 번 눌러야 실행 */
function twoStep(btn, armedText, action) {
  const original = btn.textContent;
  let timer = 0;
  btn.addEventListener('click', async () => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = armedText;
      timer = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = original; }, 4000);
      return;
    }
    clearTimeout(timer);
    btn.classList.remove('armed');
    btn.textContent = original;
    await action();
  });
}

function renderChips(el, selected, onToggle) {
  el.innerHTML = FACTORS.map(
    (f) => `<button type="button" class="chip" data-key="${f.key}" aria-pressed="${selected.has(f.key)}">${CHECK}${esc(f.label)}</button>`,
  ).join('');
  el.onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    onToggle(b.dataset.key, on);
  };
}

function renderFindings(el, list, emptyText = '') {
  el.innerHTML = list.length
    ? list.map((f) => `<li class="finding"><span class="pill ${f.sev}">${SEV_LABEL[f.sev]}</span><span class="finding-title">${esc(f.title)}</span><p class="finding-body">${esc(f.body)}</p></li>`).join('')
    : emptyText ? `<li class="hint">${esc(emptyText)}</li>` : '';
}

// ---------- 탭 ----------
const TABS = ['record', 'report', 'history', 'health'];
function showTab(name) {
  if (!TABS.includes(name)) name = 'record';
  for (const v of TABS) $(`#view-${v}`).hidden = v !== name;
  $$('.tab').forEach((t) => {
    if (t.dataset.tab === name) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  store.savePref('tab', name);
  state.tab = name;
  window.scrollTo(0, 0);
  renderTab();
}
function renderTab() {
  if (state.tab === 'report') renderReport();
  else if (state.tab === 'history') renderHistory();
  else if (state.tab === 'health') renderHealth();
}

async function loadNights() {
  const nights = await store.listNights();
  for (const n of nights) {
    if (n.status === 'recording' && n.id !== state.rec?.night.id) {
      n.status = 'done';
      n.recovered = true;
      await store.putNight(n);
      state.recovered = true;
    }
  }
  state.nights = nights;
  if (!nights.some((n) => n.id === state.currentId)) state.currentId = nights[0]?.id ?? null;
}

// ---------- 녹음 ----------
function micErrorText(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return '마이크 권한이 거부됐어요. 주소창의 자물쇠(사이트 설정)에서 마이크를 허용한 뒤 다시 눌러 주세요.';
  if (e?.name === 'NotFoundError') return '마이크를 찾지 못했어요. 마이크가 있는 기기에서 열어 주세요.';
  if (e?.name === 'NotReadableError') return '다른 앱이 마이크를 쓰고 있어요. 통화나 녹음 앱을 닫고 다시 시도해 주세요.';
  return e?.message || '녹음을 시작하지 못했어요.';
}

async function startRecording() {
  const btn = $('#btnStart');
  const err = $('#micError');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = '마이크 준비 중…';
  try {
    let rec = null;
    const mic = await openMic({
      onSamples: (x) => rec?.feed(x),
      onEnded: () => nightStatus('마이크 연결이 끊겼어요. 다른 앱이 마이크를 쓰는지 확인하고 다시 시작해 주세요.', true),
      onState: (s) => { if (s !== 'running' && state.rec) nightStatus('오디오가 잠시 멈췄어요. 화면을 한 번 누르면 다시 이어져요.', true); },
    });
    rec = new NightRecorder({
      rate: mic.rate,
      startMs: Date.now(),
      factors: [...state.tonight],
      excludeMin: Number($('#excludeMin').value),
      sensitivity: $('#sensitivity').value,
      source: 'mic',
      label: mic.label,
    });
    rec.onClip = (c) => state.clipSaves.push(saveClip(c));
    rec.onLive = (a) => updateNightStats(a);
    state.rec = rec;
    state.mic = mic;
    await store.putNight(rec.night);
    navigator.storage?.persist?.().catch(() => {});
    await state.lock.on();
    openNight();
    state.timers.push(setInterval(tickNight, 1000));
    state.timers.push(setInterval(() => { if (state.rec) store.putNight(state.rec.night).catch(() => {}); }, 60000));
  } catch (e) {
    err.textContent = micErrorText(e);
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '녹음 시작';
  }
}

function saveClip(c) {
  return store.putClip({ id: `${c.nightId}-${c.kind}-${Math.round(c.t0 * 10)}`, ...c }).catch(() => {});
}

async function stopRecording() {
  const rec = state.rec;
  if (!rec) return;
  state.timers.forEach(clearInterval);
  state.timers = [];
  await state.mic?.stop();
  const night = rec.finish();
  state.rec = null;
  state.mic = null;
  await Promise.allSettled(state.clipSaves);
  state.clipSaves = [];
  await store.putNight(night);
  await state.lock.off();
  closeNight();
  await loadNights();
  state.currentId = night.id;
  showTab('report');
  const mins = (night.end - night.start) / 60000;
  toast(mins < 2 ? '녹음이 짧아서 분석할 내용이 거의 없어요' : '기록을 저장했어요');
}

function openNight() {
  $('#night').hidden = false;
  $('#dimmer').hidden = true;
  updateNightStats(null);
  tickNight();
}
function closeNight() {
  $('#night').hidden = true;
}

function nightStatus(msg, warn = false) {
  const el = $('#nightStatus');
  el.textContent = msg;
  el.classList.toggle('warn', warn);
  state.statusUntil = Date.now() + 60000;
}
function defaultStatus() {
  const rec = state.rec;
  const parts = [state.lock.active
    ? '화면이 켜진 채로 유지돼요. 충전기를 꽂아 두세요.'
    : '화면이 꺼지면 녹음이 멈출 수 있어요. 설정에서 자동 잠금을 꺼 주세요.'];
  const left = rec.night.excludeMin * 60 - rec.t;
  if (left > 0) parts.push(`처음 ${Math.ceil(left / 60)}분은 잠드는 시간이라 세지 않아요.`);
  return parts.join(' ');
}

function updateNightStats(a) {
  $('#nsMin').textContent = `${a?.snoreMinutes ?? 0}분`;
  $('#nsCount').textContent = `${a?.snoreCount ?? 0}회`;
  $('#nsAp').textContent = `${a?.apneas.length ?? 0}회`;
}

function tickNight() {
  const rec = state.rec;
  if (!rec) return;
  const now = Date.now();
  $('#nightClock').textContent = fmtClock(now);
  const el = (now - rec.night.start) / 60000;
  $('#nightElapsed').textContent = el < 1 ? '방금 시작했어요' : `${fmtDur(el)}째 듣고 있어요`;
  const ex = Math.max(0, Math.min(30, rec.det.lastExcess));
  $('#meterFill').style.width = `${(ex / 30) * 100}%`;

  // 화면이 꺼져 브라우저가 오디오를 멈췄던 시간 감지 → 그만큼 건너뛰고 기록
  if (document.visibilityState === 'visible' && now - state.visibleSince > 4000) {
    const lag = (now - rec.night.start) / 1000 - rec.t;
    if (lag > 15) {
      rec.skip(lag);
      nightStatus(`화면이 꺼졌던 ${fmtDur(lag / 60)} 동안 녹음이 멈췄어요. 자동 잠금을 꺼 두면 밤새 이어져요.`, true);
    }
  }
  if (now > state.statusUntil) {
    $('#nightStatus').textContent = defaultStatus();
    $('#nightStatus').classList.remove('warn');
  }
  // 화면 번인 방지: 1분마다 살짝 이동
  if (Math.floor(now / 1000) % 60 === 0) {
    const r = () => Math.round((Math.random() - 0.5) * 16);
    $('#nightInner').style.transform = `translate(${r()}px, ${r()}px)`;
    $('#dimText').style.transform = `translateX(${r() * 4}px)`;
  }
}

// ---------- 파일 분석 ----------
function setProg(p, text) {
  $('#fileBar').style.width = `${Math.round(p * 100)}%`;
  $('#fileText').textContent = text;
}
async function runFile(file = $('#fileInput').files?.[0]) {
  if (!file) { toast('분석할 녹음 파일을 먼저 골라 주세요'); return null; }
  const btn = $('#btnFile');
  btn.disabled = true;
  $('#fileProgress').hidden = false;
  setProg(0, file.size > 150e6 ? '파일을 읽는 중… 큰 파일이라 오래 걸리거나 실패할 수 있어요.' : '파일을 읽는 중…');
  const startVal = $('#fileStart').value;
  const saves = [];
  try {
    const night = await analyzeFile(file, {
      startMs: startVal ? new Date(startVal).getTime() : null,
      factors: [...state.tonight],
      excludeMin: 0,
      sensitivity: $('#sensitivity').value,
      onProgress: (p) => setProg(p, `분석 중… ${Math.round(p * 100)}%`),
      onClip: (c) => saves.push(saveClip(c)),
    });
    await Promise.allSettled(saves);
    await store.putNight(night);
    await loadNights();
    state.currentId = night.id;
    setProg(1, '분석을 마쳤어요');
    showTab('report');
    toast('파일 분석을 마쳤어요');
    return night;
  } catch (e) {
    setProg(0, e?.message || '분석하지 못했어요');
    return null;
  } finally {
    btn.disabled = false;
  }
}

async function loadDemo() {
  for (const n of makeDemoNights()) await store.putNight(n);
  await loadNights();
  state.currentId = state.nights.find((n) => n.demo)?.id ?? state.currentId;
  showTab('report');
  toast('예시 기록 7개를 불러왔어요. 비교 탭에서 지울 수 있어요.');
}

// ---------- 리포트 ----------
function currentNight() {
  return state.nights.find((n) => n.id === state.currentId) || state.nights[0];
}

function renderReport() {
  const empty = !state.nights.length;
  $('#reportEmpty').hidden = !empty;
  $('#reportBody').hidden = empty;
  if (empty) return;
  const night = currentNight();
  state.currentId = night.id;
  const a = analysisOf(night);

  $('#nightSelect').innerHTML = state.nights
    .map((n) => `<option value="${n.id}"${n.id === night.id ? ' selected' : ''}>${esc(nightLabel(n))} · 코골이 ${Math.round(analysisOf(n).snorePct)}%${n.demo ? ' · 예시' : ''}</option>`)
    .join('');
  $('#reSens').value = night.sensitivity || 'normal';
  const src = { mic: '이 기기 마이크로 녹음', file: `파일 분석${night.label ? ` (${night.label})` : ''}`, demo: '예시 기록' }[night.source] || '';
  $('#reportSub').textContent = `${fmtClock(night.start)} – ${fmtClock(night.end)} · ${src}${night.recovered ? ' · 중간에 끊겨 저장된 부분까지 분석' : ''}`;

  renderTiles(a, night);
  timeline($('#timeline'), a, night);
  renderFindings($('#findings'), a.findings, '아직 분석할 소리가 충분하지 않아요.');
  renderHourlyTable(hourly($('#hourly'), a, night));
  renderMetrics(a);
  renderClips(night);
  renderChips($('#nightFactors'), new Set(night.factors), async (k, on) => {
    night.factors = on ? [...new Set([...night.factors, k])] : night.factors.filter((x) => x !== k);
    await store.putNight(night);
    renderFindings($('#findings'), analysisOf(night).findings);
  });
  $('#nightNote').value = night.note || '';
}

function renderTiles(a, night) {
  const lv = a.levelMinutes;
  const band = apneaBand(a.apneaIndex);
  const seg = a.snoreMinutes
    ? `<div class="seg" aria-hidden="true">${[1, 2, 3].map((i) => (lv[i] ? `<i class="lv${i}" style="flex:${lv[i]}"></i>` : '')).join('')}</div>
       <div class="seg-legend"><span><i class="sw lv1"></i>약 ${lv[1]}분</span><span><i class="sw lv2"></i>중 ${lv[2]}분</span><span><i class="sw lv3"></i>강 ${lv[3]}분</span></div>`
    : '';
  const durMin = (night.end - night.start) / 60000;
  const notes = [a.exSec ? `처음 ${Math.round(a.exSec / 60)}분 제외` : '제외 없음'];
  if (a.gapSec > 60) notes.push(`끊김 ${fmtDur(a.gapSec / 60)}`);
  $('#tiles').innerHTML = `
    <div class="tile hero">
      <span class="tile-label">코골이 시간</span>
      <span class="tile-value">${a.snoreMinutes}<small>분</small></span>
      <span class="tile-sub">분석한 ${fmtDur(a.analyzedMin)} 중 ${Math.round(a.snorePct)}%</span>
      ${seg}
    </div>
    <div class="tile">
      <span class="tile-label">호흡 멈춤 의심</span>
      <span class="tile-value">${a.apneaIndex.toFixed(1)}<small>회/시간</small></span>
      <span><span class="pill ${band.sev}">${band.label}</span></span>
      <span class="tile-sub">밤새 ${a.apneas.length}회</span>
    </div>
    <div class="tile">
      <span class="tile-label">녹음 시간</span>
      <span class="tile-value">${durHtml(durMin)}</span>
      <span class="tile-sub">${notes.join(' · ')}</span>
    </div>`;
}

function renderHourlyTable(rows) {
  $('#hourlyTable').innerHTML = `<table class="data"><thead><tr><th>시간대</th><th>기록</th><th>코골이</th><th>강한 코골이</th><th>멈춤 의심</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${r.hour}시</td><td>${r.total}분</td><td>${r.snore}분</td><td>${r.loud}분</td><td>${r.ap}회</td></tr>`)
    .join('')}</tbody></table>`;
}

function renderMetrics(a) {
  const dash = '–';
  const items = [
    ['코골이 횟수', `${a.snoreCount.toLocaleString()}회`],
    ['평균 숨 간격', a.breathIntervalMedian ? `${a.breathIntervalMedian.toFixed(1)}초 (분당 ${Math.round(60 / a.breathIntervalMedian)}회)` : dash],
    ['숨 간격 변동', a.regularityCV != null ? `${Math.round(a.regularityCV * 100)}%` : dash],
    ['소리 크기 변동', a.loudnessSD != null ? `±${a.loudnessSD.toFixed(1)}dB` : dash],
    ['코골이 구간', a.bouts.length ? `${a.bouts.length}개` : dash],
    ['가장 긴 구간', a.longestBoutMin ? fmtDur(a.longestBoutMin) : dash],
    ['전반 / 후반', `${a.halves[0]}분 / ${a.halves[1]}분`],
    ['가장 센 주파수', a.peakFreqMedian ? `${a.peakFreqMedian}Hz` : dash],
    ['멈춤 의심 (강 / 약)', `${a.strongCount}회 / ${a.weakCount}회`],
    ['가장 긴 멈춤', a.apneas.length ? `${Math.round(Math.max(...a.apneas.map((x) => x.gap)))}초` : dash],
    ['바닥 소음', a.ambientMedian != null ? `${a.ambientMedian} dBFS` : dash],
    ['감지한 전체 소리', `${a.eventCount.toLocaleString()}개`],
  ];
  $('#metrics').innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

async function renderClips(night) {
  state.clipUrls.forEach((u) => URL.revokeObjectURL(u));
  state.clipUrls = [];
  const el = $('#clips');
  el.dataset.for = night.id;
  const clips = await store.listClips(night.id).catch(() => []);
  if (el.dataset.for !== night.id) return;
  if (!clips.length) {
    el.innerHTML = `<li class="none">${night.demo ? '예시 기록에는 소리 클립이 없어요. 실제로 녹음하면 여기에 들을 수 있는 클립이 생겨요.' : '저장된 클립이 없어요. 호흡 멈춤 의심 구간이나 큰 코골이가 있으면 자동으로 저장돼요.'}</li>`;
    return;
  }
  el.innerHTML = clips
    .map((c) => {
      const url = URL.createObjectURL(c.blob);
      state.clipUrls.push(url);
      const head = c.kind === 'apnea'
        ? `<span class="pill ${c.meta?.strong ? 'alert' : 'warn'}">호흡 멈춤 의심</span><span>${Math.round(c.meta?.gap ?? 0)}초 동안 조용함</span>`
        : '<span class="pill info">코골이 샘플</span>';
      return `<li class="clip"><div class="clip-head">${head}<span class="when">${fmtClock(night.start + c.t0 * 1000)} · ${Math.round(c.t1 - c.t0)}초</span></div><audio controls preload="none" src="${url}"></audio></li>`;
    })
    .join('');
}

// ---------- 비교 ----------
function renderHistory() {
  const empty = !state.nights.length;
  $('#historyEmpty').hidden = !empty;
  $('#historyBody').hidden = empty;
  if (empty) return;
  const rows = state.nights.map((n) => ({
    night: n,
    a: analysisOf(n),
    short: shortLabel(n),
    long: nightLabel(n),
    factorLabels: n.factors.map((k) => FACTOR_LABEL[k]).filter(Boolean),
  }));
  renderFindings($('#trendInsights'), trendInsights(rows));
  trend($('#trend'), rows.slice(0, 14).reverse(), { onPick: (id) => { state.currentId = id; showTab('report'); } });
  renderFactorTable(compareFactors(rows));
  $('#nightList').innerHTML = rows
    .map((r) => {
      const band = apneaBand(r.a.apneaIndex);
      const chips = (r.night.demo ? ['예시'] : []).concat(r.factorLabels).map((l) => `<span class="chip small">${esc(l)}</span>`).join('');
      return `<li><button type="button" class="night-item" data-id="${r.night.id}">
        <span class="night-date">${esc(r.long)}</span>
        <span class="night-pct">${Math.round(r.a.snorePct)}%<small>${r.a.snoreMinutes}분</small></span>
        <span class="night-meta">${fmtClock(r.night.start)}–${fmtClock(r.night.end)} <span class="pill ${band.sev}">멈춤 의심 ${r.a.apneaIndex.toFixed(1)}/시간</span>${chips}</span>
      </button></li>`;
    })
    .join('');
  $('#btnClearDemo').hidden = !state.nights.some((n) => n.demo);
}

function renderFactorTable(list) {
  const el = $('#factorTable');
  if (!list.length) {
    el.innerHTML = '<p class="hint">요인을 체크한 밤과 체크하지 않은 밤이 모두 있어야 비교할 수 있어요.</p>';
    return;
  }
  const maxAbs = Math.max(20, ...list.map((x) => Math.abs(x.diff)));
  el.innerHTML = `<div class="factor-rows">${list
    .map((x) => {
      const w = (Math.abs(x.diff) / maxAbs) * 50;
      const up = x.diff >= 0;
      const verdict = !x.enough ? '기록 더 필요' : Math.abs(x.diff) < 5 ? '차이 작음' : up ? '늘어남' : '줄어듦';
      return `<div class="factor-row">
        <span class="factor-name">${esc(x.label)}<small>${x.nYes}일 평균 ${Math.round(x.pYes)}% · 나머지 ${x.nNo}일 ${Math.round(x.pNo)}%</small></span>
        <span class="factor-bar" aria-hidden="true"><i class="${up ? 'up' : 'down'}" style="width:${w}%"></i></span>
        <span class="factor-diff">${up ? '+' : '−'}${Math.abs(Math.round(x.diff))}%p<small>${verdict}</small></span>
      </div>`;
    })
    .join('')}</div>
    <div class="factor-axis" aria-hidden="true"><span></span><span><span>← 줄어듦</span><span>늘어남 →</span></span><span></span></div>`;
}

// ---------- 건강 체크 (STOP-Bang) ----------
const SB_FIELDS = { S: '#sbS', T: '#sbT', O: '#sbO', P: '#sbP' };
function renderHealth() {
  const s = store.loadPref('stopbang', {});
  for (const [k, sel] of Object.entries(SB_FIELDS)) $(sel).checked = !!s[k];
  $('#sbAge').value = s.age ?? '';
  $('#sbSex').value = s.sex ?? '';
  $('#sbH').value = s.h ?? '';
  $('#sbW').value = s.w ?? '';
  $('#sbNeck').value = s.neck ?? '';

  const real = state.nights.filter((n) => !n.demo);
  const latest = real[0] ? { night: real[0], a: analysisOf(real[0]) } : null;
  const auto = $('#sbAuto');
  if (latest && latest.a.snorePct >= 20 && latest.a.levelMinutes[3] >= 10) {
    auto.textContent = `최근 기록(${nightLabel(latest.night)})에서 큰 코골이가 ${latest.a.levelMinutes[3]}분 확인됐어요.`;
    auto.hidden = false;
  } else auto.hidden = true;
  computeStopBang();
  $('#storageInfo').textContent = store.isPersistent()
    ? `기록 ${state.nights.length}개가 이 기기의 브라우저에만 저장돼 있고 어디에도 보내지 않아요. 브라우저 데이터를 지우면 함께 지워져요.`
    : '이 브라우저(사생활 보호 모드 등)에서는 기록을 저장할 수 없어서 새로고침하면 사라져요.';
}

function computeStopBang() {
  const num = (sel) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? v : null; };
  const s = {
    S: $('#sbS').checked, T: $('#sbT').checked, O: $('#sbO').checked, P: $('#sbP').checked,
    age: num('#sbAge'), sex: $('#sbSex').value, h: num('#sbH'), w: num('#sbW'), neck: num('#sbNeck'),
  };
  store.savePref('stopbang', s);
  const bmi = s.h && s.w ? s.w / (s.h / 100) ** 2 : null;
  const items = {
    S: s.S, T: s.T, O: s.O, P: s.P,
    B: bmi != null && bmi > 35,
    A: s.age != null && s.age > 50,
    N: s.neck != null && s.neck > 40,
    G: s.sex === 'm',
  };
  const score = Object.values(items).filter(Boolean).length;
  const stop = [items.S, items.T, items.O, items.P].filter(Boolean).length;
  let risk = score >= 5 ? 'high' : score >= 3 ? 'mid' : 'low';
  if (risk === 'mid' && stop >= 2 && (items.G || items.B || items.N)) risk = 'high';
  const R = {
    low: { label: '위험 낮음', sev: 'good', text: '수면무호흡 위험이 낮은 편이에요. 그래도 녹음에서 호흡 멈춤 의심이 반복되면 검사를 받아보세요.' },
    mid: { label: '위험 중간', sev: 'warn', text: '중간 위험이에요. 녹음 결과와 함께 보고, 낮에 졸리다면 수면 클리닉 상담을 권해요.' },
    high: { label: '위험 높음', sev: 'alert', text: '수면무호흡 위험이 높아요. 수면다원검사를 받아보길 권해요.' },
  }[risk];
  const missing = [s.age, s.sex || null, s.h, s.w, s.neck].some((v) => v == null);
  const real = state.nights.filter((n) => !n.demo);
  let combo = '';
  if (real.length) {
    const a = analysisOf(real[0]);
    if (a.apneaIndex >= 5 && risk !== 'low') combo = `최근 녹음(시간당 ${a.apneaIndex.toFixed(1)}회)과 설문 모두 수면무호흡 가능성을 가리켜요.`;
    else if (a.apneaIndex >= 5) combo = `설문 점수는 낮지만 최근 녹음에서 호흡 멈춤 의심이 시간당 ${a.apneaIndex.toFixed(1)}회였어요. 며칠 더 기록해 보세요.`;
  }
  $('#sbResult').innerHTML = `
    <div class="sb-score"><strong>${score}<small> / 8</small></strong><span class="pill ${R.sev}">${R.label}</span>${bmi ? `<span class="hint">BMI ${bmi.toFixed(1)}</span>` : ''}</div>
    <p class="body">${R.text}${combo ? ` ${combo}` : ''}</p>
    ${missing ? '<p class="hint">비어 있는 칸은 해당 없음으로 계산했어요.</p>' : ''}`;
}

// ---------- 시작 ----------
function bind() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) showTab(go.dataset.go);
    if (e.target.closest('[data-demo]')) loadDemo();
    const item = e.target.closest('.night-item');
    if (item) { state.currentId = item.dataset.id; showTab('report'); }
  });

  renderChips($('#factorChips'), state.tonight, (k, on) => {
    if (on) state.tonight.add(k); else state.tonight.delete(k);
    store.savePref('tonight', [...state.tonight]);
  });
  const ex = store.loadPref('excludeMin', null);
  if (ex != null) $('#excludeMin').value = String(ex);
  const sens = store.loadPref('sensitivity', null);
  if (sens) $('#sensitivity').value = sens;
  $('#excludeMin').addEventListener('change', (e) => store.savePref('excludeMin', Number(e.target.value)));
  $('#sensitivity').addEventListener('change', (e) => store.savePref('sensitivity', e.target.value));

  $('#btnStart').addEventListener('click', startRecording);
  $('#btnFile').addEventListener('click', () => runFile());
  twoStep($('#btnStop'), '한 번 더 누르면 끝나요', stopRecording);
  $('#btnDim').addEventListener('click', () => { $('#dimmer').hidden = false; });
  $('#dimmer').addEventListener('click', () => { $('#dimmer').hidden = true; state.mic?.resume(); });

  $('#nightSelect').addEventListener('change', (e) => { state.currentId = e.target.value; renderReport(); });
  $('#reSens').addEventListener('change', async (e) => {
    const n = currentNight();
    n.sensitivity = e.target.value;
    await store.putNight(n);
    renderReport();
    toast(`민감도 '${e.target.selectedOptions[0].textContent}'로 다시 분석했어요`);
  });
  $('#nightNote').addEventListener('change', async (e) => {
    const n = currentNight();
    n.note = e.target.value;
    await store.putNight(n);
    toast('메모를 저장했어요');
  });
  twoStep($('#btnDeleteNight'), '한 번 더 누르면 삭제돼요', async () => {
    await store.deleteNight(state.currentId);
    await loadNights();
    renderReport();
    toast('기록을 삭제했어요');
  });
  twoStep($('#btnClearDemo'), '한 번 더 누르면 지워요', async () => {
    for (const n of state.nights.filter((x) => x.demo)) await store.deleteNight(n.id);
    await loadNights();
    renderHistory();
    toast('예시 기록을 지웠어요');
  });
  twoStep($('#btnClearAll'), '한 번 더 누르면 모두 삭제돼요', async () => {
    await store.clearAll();
    await loadNights();
    renderHealth();
    toast('모든 기록을 삭제했어요');
  });
  $('#btnExport').addEventListener('click', () => {
    const data = JSON.stringify({ app: 'jamsori', exportedAt: new Date().toISOString(), nights: state.nights });
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `jamsori-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  $('#stopbang').addEventListener('input', computeStopBang);
  $('#stopbang').addEventListener('submit', (e) => e.preventDefault());

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      state.visibleSince = Date.now();
      if (state.rec) {
        await state.mic?.resume();
        if (state.lock.wanted) await state.lock.on();
      }
    } else if (state.rec) {
      store.putNight(state.rec.night).catch(() => {});
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (!state.rec) return;
    store.putNight(state.rec.night).catch(() => {});
    e.preventDefault();
    e.returnValue = '';
  });
  let rz = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => { if (state.tab === 'report' || state.tab === 'history') renderTab(); }, 200);
  });
}

// ---------- 아이폰 홈 화면 앱 ----------
function platformInfo() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  return { ios, standalone: !!standalone };
}
function renderInstallHints(info = platformInfo()) {
  $('#installCard').hidden = !(info.ios && !info.standalone && !store.loadPref('installHidden', false));
  $('#iosNightCard').hidden = !info.ios;
}

async function init() {
  bind();
  renderInstallHints();
  $('#btnInstallHide').addEventListener('click', () => {
    store.savePref('installHidden', true);
    $('#installCard').hidden = true;
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  await loadNights();
  if (!store.isPersistent()) $('#storeNote').hidden = false;
  showTab(store.loadPref('tab', 'record'));
  if (state.recovered) toast('지난 녹음이 중간에 끊겨서 저장된 부분까지 정리했어요');
}

// 개발·테스트용 손잡이 (브라우저 콘솔에서 __jamsori.runFile(file) 처럼 사용)
window.__jamsori = { state, runFile, loadDemo, renderInstallHints };

init();
