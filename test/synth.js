// 테스트용 가짜 "밤 소리" 합성기
// 실제 코골이 녹음 없이도 검출기를 검증할 수 있도록 코골이, 호흡 멈춤, 말소리, 문소리,
// 선풍기 소음을 섞은 오디오를 만듭니다. Node 와 브라우저 둘 다에서 쓸 수 있어요.

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

const dbToAmp = (db) => 10 ** (db / 20);

/**
 * 시나리오 (기본 20분):
 *   0–60s     조용함
 *   60–360s   규칙적인 코골이
 *   360–420s  조용함
 *   420–720s  코골이 + 호흡 멈춤 4번 (20초 무음 → 크게 헉 하고 다시 시작)
 *   720–790s  말소리 (코골이로 세면 안 됨)
 *   790–800s  문 닫는 소리 2번
 *   800–900s  선풍기 켜짐 (바닥 소음 상승)
 *   900–1200s 작은 코골이
 */
export function synthNight({ sr = 16000, seed = 7 } = {}) {
  const rand = rng(seed);
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = rand();
    while (!v) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const dur = 1200;
  const n = dur * sr;
  const x = new Float32Array(n);
  const truth = { snores: [], apneas: [], talk: [720, 790], fan: [800, 900] };

  // 바닥 소음: 살짝 저역이 많은 잡음, 약 -62 dBFS
  let lp = 0;
  const floorAmp = dbToAmp(-62) * 1.6;
  for (let i = 0; i < n; i++) {
    lp = 0.85 * lp + 0.15 * gauss();
    x[i] = lp * floorAmp;
  }

  // 코골이 한 번 합성: 기본음 80–120Hz + 배음 + 거친 떨림 잡음
  function snore(t0, d, peakDb) {
    const f0 = 85 + rand() * 30;
    const amp = dbToAmp(peakDb);
    const i0 = Math.floor(t0 * sr), len = Math.floor(d * sr);
    const flutter = 25 + rand() * 15; // 연구개 떨림 (Hz)
    let nz = 0;
    for (let k = 0; k < len && i0 + k < n; k++) {
      const t = k / sr;
      const pos = k / len;
      const env = pos < 0.2 ? Math.sin((pos / 0.2) * Math.PI / 2) ** 2 : pos > 0.75 ? Math.cos(((pos - 0.75) / 0.25) * Math.PI / 2) ** 2 : 1;
      let s = 0;
      for (let h = 1; h <= 10; h++) s += Math.sin(2 * Math.PI * f0 * h * t + h) / h ** 0.9;
      nz = 0.7 * nz + 0.3 * gauss();
      const am = 0.6 + 0.4 * Math.sin(2 * Math.PI * flutter * t);
      x[i0 + k] += amp * env * (0.32 * s * am + 0.25 * nz);
    }
  }
  // 헉 하는 소리: 넓은 대역 잡음 + 낮은 음
  function gasp(t0, d, peakDb) {
    const amp = dbToAmp(peakDb);
    const i0 = Math.floor(t0 * sr), len = Math.floor(d * sr);
    for (let k = 0; k < len && i0 + k < n; k++) {
      const pos = k / len;
      const env = Math.sin(pos * Math.PI) ** 0.7;
      const t = k / sr;
      x[i0 + k] += amp * env * (0.5 * gauss() * 0.6 + 0.4 * Math.sin(2 * Math.PI * 140 * t));
    }
  }
  function breathingRun(from, to, peakDb, opts = {}) {
    let t = from;
    const pauses = opts.pauses || [];
    let p = 0;
    while (t < to - 2) {
      if (p < pauses.length && t >= pauses[p]) {
        const gapStart = t;
        t += 20; // 20초 동안 숨소리 없음
        truth.apneas.push(gapStart);
        gasp(t, 1.6, peakDb + 8);
        t += 3.2;
        p++;
        continue;
      }
      const d = 1.0 + rand() * 0.5;
      const db = peakDb + (rand() - 0.5) * 4;
      snore(t, d, db);
      truth.snores.push(t);
      t += 3.6 + (rand() - 0.5) * 0.8;
    }
  }

  breathingRun(60, 360, -36);
  breathingRun(420, 720, -34, { pauses: [470, 540, 610, 670] });

  // 말소리: 130Hz 성대음 + 포먼트(500/1500/2500Hz) 근처 배음 강조, 음절 4–5Hz
  {
    const [a, b] = truth.talk;
    let t = a;
    while (t < b - 1) {
      const sent = 2.5 + rand() * 4; // 한 문장 2.5–6.5초
      const i0 = Math.floor(t * sr), len = Math.floor(sent * sr);
      const f0 = 120 + rand() * 30;
      const amp = dbToAmp(-38);
      for (let k = 0; k < len && i0 + k < n; k++) {
        const tt = k / sr;
        const syl = Math.max(0, Math.sin(2 * Math.PI * 4.3 * tt)) ** 0.6;
        let s = 0;
        for (let h = 1; h <= 28; h++) {
          const f = f0 * h;
          const w = Math.exp(-(((f - 600) / 250) ** 2)) + 0.8 * Math.exp(-(((f - 1600) / 350) ** 2)) + 0.5 * Math.exp(-(((f - 2600) / 400) ** 2)) + 0.08;
          s += w * Math.sin(2 * Math.PI * f * tt + h * 0.7);
        }
        x[i0 + k] += amp * syl * s * 0.35;
      }
      t += sent + 0.6 + rand() * 1.2;
    }
  }
  // 문소리 (짧고 큰 넓은 대역 충격음)
  for (const t0 of [792, 796.5]) {
    const i0 = Math.floor(t0 * sr), len = Math.floor(0.35 * sr);
    for (let k = 0; k < len; k++) x[i0 + k] += dbToAmp(-20) * Math.exp(-k / (0.06 * sr)) * gauss();
  }
  // 선풍기: 넓은 대역 연속 잡음 (+15dB)
  {
    const [a, b] = truth.fan;
    let lp2 = 0;
    for (let i = a * sr; i < b * sr; i++) {
      lp2 = 0.5 * lp2 + 0.5 * gauss();
      x[i] += lp2 * dbToAmp(-47);
    }
  }
  breathingRun(905, 1195, -46);

  return { samples: x, sr, truth, durationSec: dur };
}

/** Float32 → 16-bit WAV (ArrayBuffer) */
export function toWav(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
