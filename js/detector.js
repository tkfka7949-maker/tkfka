// 잠소리 — 소리 이벤트 검출기 (스트리밍)
//
// 마이크(또는 파일)에서 들어오는 PCM 샘플을 받아서
//   1) 64ms 프레임마다 소리 크기(dB)와 주파수 스펙트럼을 계산하고
//   2) 주변 소음(바닥 소음)을 계속 추적하면서
//   3) 바닥 소음보다 뚜렷하게 커진 구간을 하나의 "소리 이벤트"로 잘라냅니다.
// 이벤트마다 길이, 크기, 저주파 비율, 무게중심 주파수 같은 특징을 붙여서 내보내고,
// 그게 코골이인지 판단하는 일은 analysis.js 가 맡습니다.
// 원본 오디오는 저장하지 않고 이 특징값들만 저장합니다.

export const DETECTOR_DEFAULTS = {
  targetRate: 16000, // 분석용 샘플레이트 (마이크 입력을 이 근처로 줄임)
  frameSec: 0.064,   // 프레임 길이
  onDb: 5,           // 바닥 소음보다 이만큼(dB) 커지면 소리 시작
  offDb: 2.5,        // 이 아래로 내려가면 소리 끝 후보
  hangSec: 0.16,     // 끝났다고 확정하기 전 기다리는 시간 (짧은 끊김은 하나로 합침)
  minDur: 0.2,       // 이보다 짧은 소리는 버림 (딸깍 소리 등)
  maxDur: 30,        // 이보다 길면 강제로 끊음 (계속되는 소음)
};

/** 입력 샘플레이트를 목표 샘플레이트 근처로 줄일 정수 배수 */
export function decimationFactor(sampleRate, target = DETECTOR_DEFAULTS.targetRate) {
  return Math.max(1, Math.round(sampleRate / target));
}

/** 간단한 radix-2 FFT (제자리 계산) */
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }
  transform(re, im) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step], wi = this.sin[k * step];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

export class Detector {
  /**
   * @param {number} sampleRate 들어올 샘플의 샘플레이트
   * @param {object} opts DETECTOR_DEFAULTS 덮어쓰기
   * @param {(e: object) => void} onEvent 소리 이벤트가 끝날 때마다 호출
   */
  constructor(sampleRate, opts = {}, onEvent = () => {}) {
    this.sr = sampleRate;
    this.cfg = { ...DETECTOR_DEFAULTS, ...opts };
    this.onEvent = onEvent;

    const N = 2 ** Math.round(Math.log2(this.cfg.frameSec * sampleRate));
    this.N = N;
    this.H = N / 2;
    this.hopSec = this.H / sampleRate;
    this.fft = new FFT(N);
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.nb = N / 2 + 1;
    this.P = new Float64Array(this.nb);

    const df = sampleRate / N;
    const nyq = sampleRate / 2;
    this.df = df;
    this.k60 = Math.max(1, Math.ceil(60 / df));
    this.k800 = Math.floor(800 / df);
    this.k2000 = Math.min(N / 2, Math.floor(2000 / df));
    this.k4000 = Math.min(N / 2, Math.floor(Math.min(4000, nyq * 0.95) / df));
    this.kTop = Math.min(N / 2, Math.floor(Math.min(7000, nyq * 0.95) / df));

    this.pending = new Float32Array(N * 8);
    this.pendLen = 0;
    this.frameIdx = 0;
    this.floor = null;
    this.hist = [-100, -100, -100];
    this.lastDb = -100;
    this.lastExcess = 0;
    this.active = null;
    this.hangFrames = Math.max(1, Math.round(this.cfg.hangSec / this.hopSec));
    this.maxFrames = Math.round(this.cfg.maxDur / this.hopSec);
  }

  /** 지금까지 처리한 오디오 시간(초) */
  get time() {
    return this.frameIdx * this.hopSec;
  }

  get floorDb() {
    return this.floor ?? -100;
  }

  push(samples) {
    const need = this.pendLen + samples.length;
    if (need > this.pending.length) {
      const bigger = new Float32Array(Math.max(need, this.pending.length * 2));
      bigger.set(this.pending.subarray(0, this.pendLen));
      this.pending = bigger;
    }
    this.pending.set(samples, this.pendLen);
    this.pendLen = need;

    let off = 0;
    while (this.pendLen - off >= this.N) {
      this._frame(this.pending, off);
      off += this.H;
    }
    if (off > 0) {
      this.pending.copyWithin(0, off, this.pendLen);
      this.pendLen -= off;
    }
  }

  /** 녹음이 끝날 때 진행 중인 소리를 마무리 */
  flush() {
    if (this.active) this._close();
  }

  /** 오디오가 끊겼던 시간만큼 시계를 건너뜀 (그 사이 소리는 분석하지 않음) */
  skip(sec) {
    this.flush();
    this.pendLen = 0;
    this.frameIdx += Math.round(sec / this.hopSec);
  }

  _frame(buf, off) {
    const { N, re, im, win, P } = this;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const x = buf[off + i];
      sum += x * x;
      re[i] = x * win[i];
      im[i] = 0;
    }
    const db = 20 * Math.log10(Math.sqrt(sum / N) + 1e-9);
    this.fft.transform(re, im);
    for (let k = 0; k < this.nb; k++) P[k] = re[k] * re[k] + im[k] * im[k];

    // 3프레임(약 0.1초) 평균으로 깜빡임 줄이기
    this.hist[this.frameIdx % 3] = db;
    const sdb = (this.hist[0] + this.hist[1] + this.hist[2]) / 3;

    // 바닥 소음 추적: 내려갈 땐 빠르게, 올라갈 땐 아주 천천히(약 16초 시정수)
    const t = this.time;
    if (this.floor === null) this.floor = db;
    const warm = t < 3;
    const rate = db < this.floor ? (warm ? 0.2 : 0.08) : warm ? 0.2 : 0.002;
    this.floor += rate * (db - this.floor);

    const excess = this.frameIdx < 3 ? 0 : sdb - this.floor;
    this.lastDb = sdb;
    this.lastExcess = excess;

    const a = this.active;
    if (!a) {
      if (excess >= this.cfg.onDb) {
        this.active = {
          start: this.frameIdx,
          lastAbove: this.frameIdx,
          off: 0,
          spec: new Float64Array(this.nb),
          n: 0,
          peakEx: excess,
          peakDb: sdb,
          floor: this.floor,
        };
        this._accumulate(this.active, excess, sdb);
      }
    } else {
      if (excess >= this.cfg.offDb) {
        a.off = 0;
        a.lastAbove = this.frameIdx;
        this._accumulate(a, excess, sdb);
      } else {
        a.off++;
      }
      if (a.off >= this.hangFrames || this.frameIdx - a.start >= this.maxFrames) this._close();
    }
    this.frameIdx++;
  }

  _accumulate(a, excess, sdb) {
    const s = a.spec, P = this.P;
    for (let k = 0; k < this.nb; k++) s[k] += P[k];
    a.n++;
    if (excess > a.peakEx) a.peakEx = excess;
    if (sdb > a.peakDb) a.peakDb = sdb;
  }

  _close() {
    const a = this.active;
    this.active = null;
    const d = (a.lastAbove - a.start + 1) * this.hopSec;
    if (d < this.cfg.minDur) return;

    const s = a.spec;
    let total = 0, low = 0, cNum = 0, high = 0;
    for (let k = this.k60; k <= this.kTop; k++) {
      total += s[k];
      cNum += s[k] * k * this.df;
      if (k <= this.k800) low += s[k];
      if (k > this.k2000) high += s[k];
    }
    // 스펙트럼 평탄도 (잡음일수록 1에 가깝고, 화음 성분이 뚜렷할수록 0에 가까움)
    let logSum = 0, linSum = 0, cnt = 0;
    for (let k = this.k60; k <= this.k4000; k++) {
      logSum += Math.log(s[k] + 1e-20);
      linSum += s[k];
      cnt++;
    }
    const flat = cnt && linSum > 0 ? Math.exp(logSum / cnt) / (linSum / cnt) : 1;
    // 가장 센 주파수 (60–2000Hz, 3칸 평활)
    let pf = 0, best = -1;
    for (let k = this.k60 + 1; k < this.k2000; k++) {
      const v = s[k - 1] + s[k] + s[k + 1];
      if (v > best) { best = v; pf = k * this.df; }
    }

    this.onEvent({
      t: r2(a.start * this.hopSec), // 시작 시각 (녹음 시작 기준 초)
      d: r2(d),                      // 길이 (초)
      pk: r1(a.peakEx),              // 바닥 소음보다 얼마나 컸는지 (dB)
      db: r1(a.peakDb),              // 최대 크기 (dBFS, 보정 안 된 값)
      fl: r1(a.floor),               // 그때의 바닥 소음 (dBFS)
      lr: total > 0 ? r3(low / total) : 0,   // 800Hz 이하 에너지 비율
      hr: total > 0 ? r3(high / total) : 0,  // 2000Hz 이상 에너지 비율
      ce: total > 0 ? Math.round(cNum / total) : 0, // 무게중심 주파수 (Hz)
      sf: r3(flat),                  // 스펙트럼 평탄도
      pf: Math.round(pf),            // 가장 센 주파수 (Hz)
    });
  }
}
