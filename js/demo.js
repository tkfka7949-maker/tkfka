// 잠소리 — 예시 기록 생성기
// 실제로 자면서 녹음하기 전에 리포트와 비교 화면이 어떻게 보이는지 확인할 수 있도록
// 7일치 가짜 밤 기록(소리 이벤트 목록)을 만듭니다. 모두 '예시'로 표시됩니다.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 음주한 날과 코막힌 날은 코골이가 많고, 옆으로 잔 날은 적은 사람의 일주일
const PLANS = [
  { day: 1, factors: ['alcohol', 'lateMeal'], hours: 7.2, load: 0.5, loud: 20, apnea: 0.011, shape: 'front', bed: 23.7 },
  { day: 2, factors: ['side'], hours: 6.9, load: 0.12, loud: 12.5, apnea: 0.001, shape: 'even', bed: 0.2 },
  { day: 3, factors: [], hours: 7.4, load: 0.3, loud: 15, apnea: 0.005, shape: 'back', bed: 23.4 },
  { day: 4, factors: ['tired', 'congestion'], hours: 6.6, load: 0.42, loud: 17, apnea: 0.007, shape: 'even', bed: 0.6 },
  { day: 5, factors: ['side', 'nasal'], hours: 7.0, load: 0.08, loud: 11.5, apnea: 0, shape: 'even', bed: 23.9 },
  { day: 6, factors: ['alcohol'], hours: 6.8, load: 0.46, loud: 19, apnea: 0.009, shape: 'front', bed: 0.4 },
  { day: 8, factors: [], hours: 7.3, load: 0.26, loud: 14.5, apnea: 0.004, shape: 'back', bed: 23.5 },
];

function makeNight(plan, idx, now) {
  const rand = rng(1000 + idx * 77);
  const g = () => (rand() + rand() + rand() - 1.5) / 0.5; // 대략 정규분포
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  // day일 전 '밤'에 잠듦. 자정을 넘겨 잠든 경우(bed < 12)는 그다음 날짜 새벽
  const start = base.getTime() - (plan.bed < 12 ? plan.day - 1 : plan.day) * 86400000 + plan.bed * 3600000;
  const dur = plan.hours * 3600;
  const events = [];
  const amb = [];
  const ex = 20 * 60;

  // 코골이 구간 배치
  const boutMean = 18 * 60;
  const quietMean = boutMean * (1 - plan.load) / plan.load;
  let t = ex + rand() * 10 * 60;
  while (t < dur - 120) {
    const pos = t / dur;
    const w = plan.shape === 'front' ? Math.max(0.25, 2.1 - pos * 2) : plan.shape === 'back' ? 0.3 + pos * 1.7 : 1;
    const boutLen = Math.max(4 * 60, (8 + rand() * 20) * 60 * w);
    const end = Math.min(dur - 30, t + boutLen);
    let s = t, lastAp = -1e9;
    const lift = plan.shape === 'back' ? pos * 4 : plan.shape === 'front' ? (1 - pos) * 4 : 0;
    while (s < end) {
      const apRate = plan.apnea * (plan.shape === 'back' ? 0.4 + pos * 1.4 : 1);
      if (rand() < apRate && s - lastAp > 45) {
        const gap = 12 + rand() * 24;
        s += gap;
        events.push({ t: +s.toFixed(2), d: +(2 + rand() * 0.8).toFixed(2), pk: +(plan.loud + lift + 8 + rand() * 4).toFixed(1), db: -30, fl: -58, lr: 0.52, hr: 0.3, ce: 980, sf: 0.36, pf: 150 });
        s += 3.2;
        lastAp = s;
        continue;
      }
      const pk = plan.loud + lift + g() * 3.6;
      events.push({
        t: +s.toFixed(2), d: +(1.1 + rand() * 0.5).toFixed(2), pk: +pk.toFixed(1), db: +(-58 + pk).toFixed(1), fl: -58,
        lr: +(0.68 + rand() * 0.14).toFixed(3), hr: 0.05, ce: Math.round(380 + rand() * 160), sf: 0.22, pf: Math.round(120 + rand() * 90),
      });
      s += 3.5 + g() * 0.35;
    }
    t = end + Math.max(90, quietMean * (0.4 + rand() * 1.2) / w);
  }

  // 뒤척임 등 코골이 아닌 소리
  const nNoise = Math.round(plan.hours * 6);
  for (let i = 0; i < nNoise; i++) {
    const nt = ex + rand() * (dur - ex);
    const long = rand() < 0.15;
    events.push({ t: +nt.toFixed(2), d: +(long ? 5 + rand() * 4 : 0.4 + rand() * 1.8).toFixed(2), pk: +(8 + rand() * 12).toFixed(1), db: -45, fl: -58, lr: 0.28, hr: 0.42, ce: 1900, sf: 0.62, pf: 800 });
  }
  events.sort((a, b) => a.t - b.t);
  // 겹치는 이벤트 정리
  const clean = [];
  for (const e of events) {
    const last = clean[clean.length - 1];
    if (last && e.t < last.t + last.d + 0.2) continue;
    clean.push(e);
  }

  let a = -58;
  for (let m = 0; m < Math.ceil(dur / 60); m++) {
    a += (rand() - 0.5) * 0.6;
    a = Math.max(-61, Math.min(-55, a));
    amb.push(+a.toFixed(1));
  }

  return {
    id: `demo-${plan.day}`,
    v: 1, demo: true,
    start, end: start + dur * 1000, rate: 16000, source: 'demo', label: '예시',
    factors: plan.factors, excludeMin: 20, sensitivity: 'normal',
    events: clean, amb, gaps: [], note: '', status: 'done',
  };
}

export function makeDemoNights(now = Date.now()) {
  return PLANS.map((p, i) => makeNight(p, i, now));
}
