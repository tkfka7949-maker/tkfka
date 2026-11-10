// 잠소리 — 코골이 판정과 밤 전체 분석
//
// detector.js 가 만든 소리 이벤트 목록을 받아서
//   1) 코골이처럼 들리는 소리(후보)를 고르고
//   2) 숨 쉬는 리듬(1.8–10초 간격)으로 반복되는 후보만 진짜 코골이로 인정하고
//   3) 분 단위 코골이 시간, 강도, 구간, 호흡 멈춤 의심 이벤트를 계산한 뒤
//   4) 패턴을 읽어서 사람이 이해할 수 있는 결과 문장(findings)을 만듭니다.
// 분석은 저장된 이벤트로 언제든 다시 할 수 있어서, 민감도를 바꿔 재분석할 수 있습니다.

export const SENSITIVITY = {
  low:    { label: '낮음', minPk: 8, minLr: 0.55, maxCe: 900,  minCount: 5 },
  normal: { label: '보통', minPk: 6, minLr: 0.45, maxCe: 1100, minCount: 4 },
  high:   { label: '높음', minPk: 5, minLr: 0.42, maxCe: 1300, minCount: 3 },
};

export const RULES = {
  candMinDur: 0.25,  // 코골이 한 번의 최소 길이 (초)
  candMaxDur: 4,     // 최대 길이. 이보다 길면 말소리·TV 같은 연속 소음으로 봄
  maxFlat: 0.7,      // 스펙트럼 평탄도 상한 (너무 평평하면 바람·잡음)
  windowSec: 45,     // 리듬 확인 창 (앞뒤 45초)
  nbMin: 1.5,        // 이웃 코골이와의 간격 범위 (초)
  nbMax: 12,
  medMin: 1.8,       // 창 안 간격의 중간값 범위 = 호흡 주기 (분당 6–33회)
  medMax: 10,
  minuteMinSnores: 3, // 1분 안에 3번 이상이면 '코골이 1분'
  lvl2: 12,          // 바닥 소음 대비 dB: 12 이상 '중', 20 이상 '강'
  lvl3: 20,
  boutGap: 90,       // 90초 넘게 끊기면 다른 구간
  boutMin: 5,        // 5번 미만 구간은 무시
  noiseLongDur: 4,
  apnea: {
    ctxSec: 60,      // 멈춤 직전 60초 안에
    ctxMin: 3,       // 코골이가 3번 이상 규칙적으로 있었고
    minGap: 10,      // 10초 이상 (그리고 평소 간격의 2.5배 이상) 아무 소리가 없다가
    gapFactor: 2.5,
    weakMinGap: 15,  // 크게 다시 시작하지 않으면 15–45초일 때만 '약한 의심'
    weakMaxGap: 45,  //   (그보다 길게 조용하다 조용히 다시 고는 건 자세를 바꾼 경우가 많음)
    maxGap: 90,      // 90초 넘게 조용하면 그냥 코골이가 멈춘 것으로 봄
    resumeSec: 30,   // 30초 안에 코골이가 다시 2번 이상 이어져야 함
    loudDb: 3,       // 다시 시작하는 소리가 평소보다 3dB 이상 크면 '강한 의심'
    loudPostDb: 5,
  },
};

export const FACTORS = [
  { key: 'alcohol', label: '음주' },
  { key: 'lateMeal', label: '늦은 야식' },
  { key: 'tired', label: '많이 피곤함' },
  { key: 'congestion', label: '코막힘·감기' },
  { key: 'sedative', label: '수면제·진정제' },
  { key: 'side', label: '옆으로 자기' },
  { key: 'pillow', label: '베개 높임' },
  { key: 'nasal', label: '코 패치·스프레이' },
  { key: 'exercise', label: '운동함' },
];

export const SEV_LABEL = { good: '괜찮아요', info: '참고', warn: '주의', alert: '확인 필요' };

// ---------- 작은 도구들 ----------
export function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
const r1 = (x) => Math.round(x * 10) / 10;

export function fmtDur(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (!h) return `${mm}분`;
  return mm ? `${h}시간 ${mm}분` : `${h}시간`;
}
export function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- 1단계: 코골이 후보 ----------
export function isCandidate(e, s) {
  return (
    e.d >= RULES.candMinDur &&
    e.d <= RULES.candMaxDur &&
    e.pk >= s.minPk &&
    e.lr >= s.minLr &&
    e.ce <= s.maxCe &&
    e.sf <= RULES.maxFlat
  );
}

// ---------- 2단계: 호흡 리듬으로 확인 ----------
export function findSnores(events, s) {
  const cand = events.filter((e) => isCandidate(e, s));
  const out = [];
  let lo = 0, hi = 0;
  for (let i = 0; i < cand.length; i++) {
    const t = cand[i].t;
    while (cand[lo].t < t - RULES.windowSec) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < cand.length && cand[hi + 1].t <= t + RULES.windowSec) hi++;
    if (hi - lo + 1 < s.minCount) continue;

    const prev = i > 0 ? t - cand[i - 1].t : Infinity;
    const next = i + 1 < cand.length ? cand[i + 1].t - t : Infinity;
    const inRange = (g) => g >= RULES.nbMin && g <= RULES.nbMax;
    if (!inRange(prev) && !inRange(next)) continue;

    const iv = [];
    for (let j = lo + 1; j <= hi; j++) iv.push(cand[j].t - cand[j - 1].t);
    const m = median(iv);
    if (m < RULES.medMin || m > RULES.medMax) continue;
    out.push(cand[i]);
  }
  return out;
}

// ---------- 3단계: 밤 전체 분석 ----------
/**
 * @param night { start(ms), end(ms), excludeMin, events[], amb[], factors[] }
 * @param opts { sensitivity }
 */
export function analyzeNight(night, opts = {}) {
  const sensKey = opts.sensitivity || night.sensitivity || 'normal';
  const s = SENSITIVITY[sensKey] || SENSITIVITY.normal;
  const A = RULES.apnea;

  const durSec = Math.max(0, ((night.end ?? night.start) - night.start) / 1000);
  const exSec = Math.min(durSec, (night.excludeMin || 0) * 60);
  // 화면이 꺼져 오디오가 끊긴 구간은 분석 시간에서 뺌
  const gaps = night.gaps || [];
  const gapSec = gaps.reduce((s, [g0, g1]) => s + Math.max(0, Math.min(g1, durSec) - Math.max(g0, exSec)), 0);
  const anSec = Math.max(0, durSec - exSec - gapSec);
  const analyzedMin = anSec / 60;
  const hours = anSec / 3600;

  const events = (night.events || []).filter((e) => e.t >= exSec && e.t <= durSec);
  const snores = findSnores(events, s);

  // 분 단위 집계
  const nMin = Math.max(1, Math.ceil(durSec / 60));
  const minutes = Array.from({ length: nMin }, (_, i) => ({
    i, c: 0, pkSum: 0, lvl: 0, snore: false, ap: 0, ex: (i + 1) * 60 <= exSec,
    gap: gaps.some(([g0, g1]) => g0 <= i * 60 && g1 >= (i + 1) * 60),
  }));
  for (const e of snores) {
    const m = minutes[Math.floor(e.t / 60)];
    if (m) { m.c++; m.pkSum += e.pk; }
  }
  const levelMinutes = [0, 0, 0, 0];
  let snoreMinutes = 0;
  for (const m of minutes) {
    if (m.c >= RULES.minuteMinSnores) {
      m.snore = true;
      const avg = m.pkSum / m.c;
      m.lvl = avg >= RULES.lvl3 ? 3 : avg >= RULES.lvl2 ? 2 : 1;
      levelMinutes[m.lvl]++;
      snoreMinutes++;
    }
  }
  const snorePct = analyzedMin > 0 ? Math.min(100, (snoreMinutes / analyzedMin) * 100) : 0;

  // 코골이 구간 (bout)
  const bouts = [];
  let cur = null;
  for (const e of snores) {
    if (cur && e.t - cur.lastT <= RULES.boutGap) {
      cur.lastT = e.t; cur.t1 = e.t + e.d; cur.items.push(e);
    } else {
      if (cur) bouts.push(cur);
      cur = { t0: e.t, t1: e.t + e.d, lastT: e.t, items: [e] };
    }
  }
  if (cur) bouts.push(cur);
  const realBouts = bouts.filter((b) => b.items.length >= RULES.boutMin);
  const boutMins = realBouts.map((b) => (b.t1 - b.t0) / 60);

  // 리듬 규칙성 (구간 안 숨 간격의 변동계수) 과 크기 변동
  const cvs = [], cvW = [];
  for (const b of realBouts) {
    if (b.items.length < 10) continue;
    const iv = [];
    for (let j = 1; j < b.items.length; j++) {
      const g = b.items[j].t - b.items[j - 1].t;
      if (g <= RULES.nbMax) iv.push(g);
    }
    if (iv.length < 8) continue;
    cvs.push(std(iv) / mean(iv));
    cvW.push(iv.length);
  }
  const regularityCV = cvs.length
    ? cvs.reduce((acc, v, i) => acc + v * cvW[i], 0) / cvW.reduce((a, b) => a + b, 0)
    : null;
  const loudnessSD = snores.length >= 20 ? std(snores.map((e) => e.pk)) : null;
  const breathIv = [];
  for (let j = 1; j < snores.length; j++) {
    const g = snores[j].t - snores[j - 1].t;
    if (g <= RULES.nbMax) breathIv.push(g);
  }
  const breathIntervalMedian = breathIv.length >= 5 ? median(breathIv) : null;

  // 호흡 멈춤 의심
  const idxOf = new Map(events.map((e, i) => [e, i]));
  const apneas = [];
  let ctxLo = 0;
  for (let k = 0; k < snores.length; k++) {
    const a = snores[k];
    while (snores[ctxLo].t < a.t - A.ctxSec) ctxLo++;
    if (k - ctxLo + 1 < A.ctxMin) continue;
    const ctx = snores.slice(ctxLo, k + 1);
    const iv = [];
    for (let j = 1; j < ctx.length; j++) iv.push(ctx[j].t - ctx[j - 1].t);
    const tm = median(iv);
    if (!(tm >= RULES.medMin && tm <= RULES.medMax)) continue;

    const ia = idxOf.get(a);
    const r = events[ia + 1];
    if (!r) continue;
    const aEnd = a.t + a.d;
    const gap = r.t - aEnd;
    const thr = Math.max(A.minGap, A.gapFactor * tm);
    if (gap < thr || gap > A.maxGap) continue;
    if (gaps.some(([g0, g1]) => g0 < r.t && g1 > aEnd)) continue; // 녹음이 끊긴 탓에 조용했던 것



    let resumed = 0;
    for (let j = k + 1; j < snores.length && snores[j].t <= r.t + A.resumeSec; j++) {
      if (snores[j].t >= r.t - 0.01) resumed++;
    }
    if (resumed < 2) continue;

    const ctxPk = median(ctx.map((e) => e.pk));
    const ctxD = median(ctx.map((e) => e.d));
    let postMax = -Infinity;
    for (let j = ia + 1; j < events.length && j <= ia + 3 && events[j].t <= r.t + 15; j++) {
      postMax = Math.max(postMax, events[j].pk);
    }
    const loud = r.pk >= ctxPk + A.loudDb || postMax >= ctxPk + A.loudPostDb || r.d >= 1.8 * ctxD;
    if (!loud && (gap < Math.max(A.weakMinGap, thr) || gap > A.weakMaxGap)) continue;
    apneas.push({ t: Math.round(aEnd * 100) / 100, gap: r1(gap), r: r.t, strong: loud });
    const m = minutes[Math.floor(aEnd / 60)];
    if (m) m.ap++;
  }
  const strongCount = apneas.filter((x) => x.strong).length;
  const weakCount = apneas.length - strongCount;
  // 화면에 보이는 값(소수 첫째 자리)과 등급이 어긋나지 않게 먼저 반올림
  const apneaIndex = hours > 0 ? Math.round((apneas.length / hours) * 10) / 10 : 0;

  // 전반/후반, 4분위
  const quarters = [0, 0, 0, 0];
  const apHalves = [0, 0];
  for (const m of minutes) {
    if (!m.snore || m.ex) continue;
    const pos = anSec > 0 ? (m.i * 60 + 30 - exSec) / anSec : 0;
    quarters[Math.min(3, Math.max(0, Math.floor(pos * 4)))]++;
  }
  for (const ap of apneas) {
    const pos = anSec > 0 ? (ap.t - exSec) / anSec : 0;
    apHalves[pos < 0.5 ? 0 : 1]++;
  }
  const halves = [quarters[0] + quarters[1], quarters[2] + quarters[3]];

  // 소리 성질
  const peakFreqMedian = snores.length ? Math.round(median(snores.map((e) => e.pf))) : null;
  const centroidMedian = snores.length ? Math.round(median(snores.map((e) => e.ce))) : null;

  // 환경
  const longNoise = events.filter((e) => e.d > RULES.noiseLongDur).length;
  const noisePerHour = hours > 0 ? longNoise / hours : 0;
  const amb = (night.amb || []).slice(Math.floor(exSec / 60));
  const ambientMedian = amb.length ? r1(median(amb)) : null;

  const result = {
    sensitivity: sensKey,
    durSec, exSec, anSec, analyzedMin, gapSec, breathIntervalMedian,
    snores, snoreCount: snores.length,
    minutes, snoreMinutes, snorePct, levelMinutes,
    bouts: realBouts.map((b) => ({ t0: b.t0, t1: b.t1, n: b.items.length })),
    longestBoutMin: boutMins.length ? Math.max(...boutMins) : 0,
    medianBoutMin: boutMins.length ? median(boutMins) : 0,
    regularityCV, loudnessSD,
    apneas, strongCount, weakCount, apneaIndex, apHalves,
    quarters, halves,
    peakFreqMedian, centroidMedian,
    noisePerHour, ambientMedian,
    eventCount: events.length,
  };
  result.findings = buildFindings(result, night);
  return result;
}

// ---------- 4단계: 결과 문장 ----------
export function apneaBand(ix) {
  if (ix < 5) return { key: 'normal', label: '정상 범위', sev: 'good' };
  if (ix < 15) return { key: 'mild', label: '경도 수준', sev: 'warn' };
  if (ix < 30) return { key: 'moderate', label: '중등도 수준', sev: 'alert' };
  return { key: 'severe', label: '중증 수준', sev: 'alert' };
}

export function buildFindings(a, night = {}) {
  const f = [];
  const factors = night.factors || [];
  const p = a.snorePct;
  const pTxt = `${Math.round(p)}%`;

  if (a.analyzedMin < 120) {
    f.push({
      sev: 'info', title: '녹음 시간이 짧아요',
      body: `분석한 시간이 ${fmtDur(a.analyzedMin)}이에요. 2시간보다 짧으면 결과가 흔들릴 수 있으니 가능하면 밤 전체를 기록해 주세요.`,
    });
  }

  // 1. 코골이 양
  if (p < 5) {
    f.push({ sev: 'good', title: '코골이가 거의 없었어요', body: `코골이가 감지된 시간은 ${a.snoreMinutes}분(${pTxt})이에요.` });
  } else if (p < 20) {
    f.push({ sev: 'info', title: '가벼운 코골이', body: `밤의 ${pTxt}(${a.snoreMinutes}분) 동안 코를 골았어요. 가끔 고는 수준이에요.` });
  } else if (p < 50) {
    f.push({ sev: 'warn', title: '코골이가 잦은 편이에요', body: `밤의 ${pTxt}(${fmtDur(a.snoreMinutes)}) 동안 코를 골았어요. 이런 밤이 일주일에 3번 이상이면 습관성 코골이로 봐요.` });
  } else {
    f.push({ sev: 'alert', title: '밤의 절반 이상 코를 골았어요', body: `밤의 ${pTxt}(${fmtDur(a.snoreMinutes)}) 동안 코를 골았어요. 거의 밤새 기도가 좁아져 있었다는 뜻이에요.` });
  }

  if (a.snoreMinutes >= 10) {
    const share = a.levelMinutes[3] / a.snoreMinutes;
    if (share >= 0.3) {
      f.push({
        sev: 'warn', title: '큰 코골이 비중이 높아요',
        body: `코골이 시간의 ${Math.round(share * 100)}%가 '강' 단계였어요. 주변 소음보다 20dB 넘게 큰 소리라서 옆 사람 잠을 깨울 수 있는 크기예요.`,
      });
    }
  }

  // 2. 호흡 멈춤 의심
  if (a.snoreMinutes >= 5 || a.apneas.length) {
    const ix = a.apneaIndex;
    const band = apneaBand(ix);
    const detail = `강한 의심 ${a.strongCount}회, 약한 의심 ${a.weakCount}회로 시간당 ${ix.toFixed(1)}회예요.`;
    if (band.key === 'normal') {
      f.push({ sev: 'good', title: '호흡 멈춤 의심 패턴은 적었어요', body: `${detail} 코골이 도중 10초 넘게 소리가 끊겼다가 크게 다시 시작되는 패턴이 드물었어요.` });
    } else {
      const extra = {
        mild: '수면무호흡 경도 기준(시간당 5–15회)에 해당하는 빈도예요. 낮에 졸리거나 아침에 머리가 아프다면 수면다원검사를 받아보세요.',
        moderate: '수면무호흡 중등도 기준(시간당 15–30회)에 해당하는 빈도예요. 수면다원검사를 받아보길 권해요.',
        severe: '수면무호흡 중증 기준(시간당 30회 이상)에 해당하는 빈도예요. 가능한 빨리 수면 클리닉에서 검사를 받아보세요.',
      }[band.key];
      f.push({ sev: band.sev, title: `호흡 멈춤 의심: ${band.label}`, body: `${detail} ${extra}` });
    }
  }

  // 3. 시간대 치우침
  if (a.snoreMinutes >= 15) {
    const [h1, h2] = a.halves;
    if (h2 >= 2 * Math.max(1, h1)) {
      let body = `후반부 ${h2}분, 전반부 ${h1}분이에요. 새벽에는 렘수면이 길어지는데, 렘수면 때 목 근육이 가장 많이 풀려서 기도가 좁아지기 쉬워요.`;
      if (a.apHalves[1] >= 3 && a.apHalves[1] >= 2 * Math.max(1, a.apHalves[0])) {
        body += ' 호흡 멈춤 의심도 후반에 몰려 있어서, 렘수면 때 심해지는 수면무호흡인지 의사와 상의해볼 만해요.';
      }
      f.push({ sev: 'info', title: '새벽에 코골이가 몰려 있어요', body });
    } else if (h1 >= 2 * Math.max(1, h2)) {
      let body = `전반부 ${h1}분, 후반부 ${h2}분이에요. 술, 심한 피로, 수면제·진정제는 잠든 뒤 몇 시간 동안 목 근육을 더 느슨하게 만들어요.`;
      if (factors.includes('alcohol')) body += ' 이날 음주를 기록하셨어요. 술 마신 날과 안 마신 날을 비교해보세요.';
      else if (factors.includes('sedative')) body += ' 이날 수면제·진정제를 기록하셨어요.';
      f.push({ sev: 'info', title: '잠든 직후에 코골이가 몰려 있어요', body });
    }
  }

  // 4. 구간 모양 (자세 영향)
  if (a.bouts.length >= 4 && p >= 10 && p <= 75 && a.medianBoutMin >= 3 && a.medianBoutMin <= 45) {
    f.push({
      sev: 'info', title: '코골이가 켜졌다 꺼졌다 반복돼요',
      body: `${a.bouts.length}개 구간으로 나뉘고 한 구간이 보통 ${Math.round(a.medianBoutMin)}분 이어졌어요. 자세를 바꿀 때마다 코골이가 생겼다 사라지는 '자세성 코골이'에서 흔한 모양이에요. 똑바로 누우면 혀와 연구개가 중력 때문에 뒤로 처지거든요. 며칠은 '옆으로 자기'를 체크하고 녹음해서 비교해보세요.`,
    });
  }
  if (a.longestBoutMin >= 120) {
    f.push({
      sev: 'warn', title: '2시간 넘게 쉬지 않은 코골이',
      body: `가장 긴 구간이 ${fmtDur(a.longestBoutMin)}이었어요. 자세를 바꿔도 이어지는 코골이일 수 있어요.`,
    });
  }

  // 5. 리듬 규칙성
  if (a.regularityCV != null) {
    const irregular = a.regularityCV >= 0.45 || (a.loudnessSD ?? 0) >= 6;
    if (irregular) {
      f.push({
        sev: 'warn', title: '코골이 리듬이 불규칙해요',
        body: `숨 간격 변동이 ${Math.round(a.regularityCV * 100)}%, 소리 크기 변동이 ±${(a.loudnessSD ?? 0).toFixed(1)}dB예요. 간격과 크기가 들쭉날쭉하고 중간중간 끊기는 코골이는 단순 코골이보다 수면무호흡에서 더 자주 보여요.`,
      });
    } else if (a.regularityCV < 0.3 && a.apneaIndex < 5) {
      f.push({
        sev: 'good', title: '일정한 리듬의 코골이',
        body: `숨 간격 변동이 ${Math.round(a.regularityCV * 100)}%로 일정해요. 기도가 좁아져 떨리지만 막히지는 않는 단순 코골이에서 흔한 모양이에요.`,
      });
    }
  }

  // 6. 소리 높이
  if (a.snoreCount >= 30 && a.peakFreqMedian) {
    const pf = a.peakFreqMedian;
    const note = ' 휴대폰 마이크마다 특성이 달라서 참고용으로만 봐주세요.';
    if (pf < 300) {
      f.push({ sev: 'info', title: '낮고 울리는 코골이', body: `가장 센 주파수가 약 ${pf}Hz예요. 입천장 뒤쪽 부드러운 부분(연구개)이 떨릴 때 나는 낮은 소리와 비슷해요. 코가 막혀 입으로 숨 쉴 때 심해지기도 해요.${note}` });
    } else if (pf > 800) {
      f.push({ sev: 'info', title: '높고 날카로운 코골이', body: `가장 센 주파수가 약 ${pf}Hz예요. 혀뿌리나 후두개 쪽이 좁아질 때 나는 높은 소리와 비슷하고, 똑바로 누운 자세에서 심해지는 경우가 많아요.${note}` });
    } else {
      f.push({ sev: 'info', title: '중간 높이의 코골이', body: `가장 센 주파수가 약 ${pf}Hz예요. 연구개와 혀뿌리 쪽이 함께 떨리는 혼합형일 수 있어요.${note}` });
    }
  }

  // 7. 녹음 환경
  if (a.noisePerHour > 20 || (a.ambientMedian != null && a.ambientMedian > -40)) {
    f.push({
      sev: 'info', title: '주변 소음이 많았어요',
      body: `길게 이어진 소음이 시간당 ${Math.round(a.noisePerHour)}회 있었어요${a.ambientMedian != null ? ` (바닥 소음 중간값 ${a.ambientMedian} dBFS)` : ''}. 선풍기·에어컨·TV 소리가 크면 코골이를 놓치거나 잘못 셀 수 있어요.`,
    });
  }
  return f;
}

// ---------- 여러 밤 비교 ----------
/** rows: [{ night, a }] */
export function compareFactors(rows) {
  const out = [];
  for (const fac of FACTORS) {
    const yes = rows.filter((r) => (r.night.factors || []).includes(fac.key));
    const no = rows.filter((r) => !(r.night.factors || []).includes(fac.key));
    if (!yes.length || !no.length) continue;
    const pYes = mean(yes.map((r) => r.a.snorePct));
    const pNo = mean(no.map((r) => r.a.snorePct));
    const iYes = mean(yes.map((r) => r.a.apneaIndex));
    const iNo = mean(no.map((r) => r.a.apneaIndex));
    out.push({
      key: fac.key, label: fac.label,
      nYes: yes.length, nNo: no.length,
      pYes, pNo, diff: pYes - pNo, iYes, iNo,
      enough: yes.length >= 2 && no.length >= 2,
    });
  }
  return out.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
}

export function trendInsights(rows) {
  // rows: 최신순
  const out = [];
  const last7 = rows.slice(0, 7);
  if (last7.length >= 3) {
    const heavy = last7.filter((r) => r.a.snorePct >= 20).length;
    if (heavy >= 3) {
      out.push({ sev: 'warn', title: '습관성 코골이 패턴', body: `최근 ${last7.length}일 중 ${heavy}일이 코골이 20% 이상이었어요. 일주일에 3번 이상 코를 고는 습관성 코골이에 해당해요.` });
    }
    const highIx = last7.filter((r) => r.a.apneaIndex >= 5).length;
    if (highIx >= 2) {
      out.push({ sev: 'alert', title: '호흡 멈춤 의심이 반복돼요', body: `최근 ${last7.length}일 중 ${highIx}일이 시간당 5회 이상이었어요. 하룻밤 우연이 아니라 반복되는 패턴이라 수면다원검사를 권해요.` });
    }
  }
  return out;
}
