// 잠소리 — 녹음 세션 (마이크 / 파일 공통)
//
// NightRecorder 는 샘플을 받아서 Detector 에 넘기고, 최근 120초 오디오를 링버퍼에 들고 있다가
// 호흡 멈춤 의심 구간이나 큰 코골이가 확인되면 그 부분만 짧은 WAV 클립으로 잘라 줍니다.
// 밤 전체 원본은 저장하지 않습니다.

import { Detector, decimationFactor } from './detector.js';
import { analyzeNight } from './analysis.js';

export const CLIP_LIMITS = { apnea: 12, snore: 6 };
const RING_SEC = 120;

export class NightRecorder {
  constructor({ rate, startMs, factors = [], excludeMin = 0, sensitivity = 'normal', source = 'mic', label = '' }) {
    this.rate = rate;
    this.night = {
      id: 'n' + startMs.toString(36) + Math.random().toString(36).slice(2, 6),
      v: 1,
      start: startMs,
      end: startMs,
      rate,
      source,
      label,
      factors: [...factors],
      excludeMin,
      sensitivity,
      events: [],
      amb: [],
      gaps: [],
      note: '',
      status: 'recording',
    };
    this.det = new Detector(rate, {}, (e) => this.night.events.push(e));
    this.ringLen = Math.round(rate * RING_SEC);
    this.ring = new Float32Array(this.ringLen);
    this.total = 0;
    this.nextMinute = 60;
    this.lastLive = 0;
    this.pending = [];
    this.clipped = new Set();
    this.clipCount = { apnea: 0, snore: 0 };
    this.lastSnoreClip = -1e9;
    this.live = null;
    this.onClip = null;
    this.onLive = null;
  }

  /** 녹음 시작부터 처리한 오디오 시간 (초) */
  get t() {
    return this.total / this.rate;
  }

  feed(x) {
    const pos = this.total % this.ringLen;
    const first = Math.min(x.length, this.ringLen - pos);
    this.ring.set(x.subarray(0, first), pos);
    if (first < x.length) this.ring.set(x.subarray(first), 0);
    this.total += x.length;

    this.det.push(x);
    this._tick();
  }

  /** 오디오가 끊겼던 시간을 건너뜀 (화면 꺼짐으로 브라우저가 멈췄던 경우) */
  skip(sec) {
    if (sec <= 0) return;
    const t0 = this.t;
    this.det.skip(sec);
    this.ring.fill(0);
    this.total += Math.round(sec * this.rate);
    this.night.gaps.push([Math.round(t0), Math.round(this.t)]);
    this._tick();
  }

  _tick() {
    while (this.t >= this.nextMinute) {
      this.night.amb.push(Math.round(this.det.floorDb * 10) / 10);
      this.nextMinute += 60;
    }
    this.night.end = this.night.start + this.t * 1000;
    if (this.t - this.lastLive >= 5) {
      this.lastLive = this.t;
      this._live();
    }
    if (this.pending.length) this._flushClips(false);
  }

  _live() {
    const a = analyzeNight(this.night);
    this.live = a;

    for (const ap of a.apneas) {
      const key = Math.round(ap.t);
      if (this.clipped.has(key) || this.clipCount.apnea >= CLIP_LIMITS.apnea) continue;
      this.clipped.add(key);
      this.clipCount.apnea++;
      this.pending.push({ kind: 'apnea', t0: Math.max(0, ap.t - 6), t1: ap.r + 8, meta: { gap: ap.gap, strong: ap.strong } });
    }

    // 큰 코골이 샘플: 40분에 한 번, 최대 6개
    if (this.clipCount.snore < CLIP_LIMITS.snore && this.t - this.lastSnoreClip > 40 * 60) {
      const recent = a.snores.filter((e) => e.t > this.t - 20 && e.pk >= 12);
      if (recent.length >= 2) {
        const e = recent[0];
        this.lastSnoreClip = this.t;
        this.clipCount.snore++;
        this.pending.push({ kind: 'snore', t0: Math.max(0, e.t - 2), t1: e.t + 12, meta: { pk: e.pk } });
      }
    }
    this.onLive?.(a);
  }

  _flushClips(force) {
    const now = this.t;
    const keep = [];
    for (const p of this.pending) {
      if (!force && now < p.t1) { keep.push(p); continue; }
      const got = this._extract(p.t0, Math.min(p.t1, now));
      if (got && got.pcm.length > this.rate) {
        this.onClip?.({
          nightId: this.night.id,
          kind: p.kind,
          t0: Math.round(got.t0 * 10) / 10,
          t1: Math.round(Math.min(p.t1, now) * 10) / 10,
          meta: p.meta,
          blob: encodeWav(got.pcm, this.rate),
        });
      }
    }
    this.pending = keep;
  }

  _extract(t0, t1) {
    const oldest = Math.max(0, this.t - RING_SEC + 0.5);
    t0 = Math.max(t0, oldest);
    if (t1 <= t0) return null;
    const i0 = Math.round(t0 * this.rate), i1 = Math.round(t1 * this.rate);
    const out = new Float32Array(i1 - i0);
    for (let i = i0, j = 0; i < i1; i++, j++) out[j] = this.ring[i % this.ringLen];
    return { pcm: out, t0 };
  }

  finish() {
    this.det.flush();
    this._flushClips(true);
    this.night.end = this.night.start + this.t * 1000;
    this.night.status = 'done';
    return this.night;
  }
}

/** PCM → 듣기 좋은 WAV (8kHz 근처로 줄이고 소리 크기를 맞춤) */
export function encodeWav(pcm, rate) {
  let data = pcm, sr = rate;
  if (rate > 12000) {
    const f = Math.round(rate / 8000);
    data = new Float32Array(Math.floor(pcm.length / f));
    for (let i = 0; i < data.length; i++) {
      let s = 0;
      for (let k = 0; k < f; k++) s += pcm[i * f + k];
      data[i] = s / f;
    }
    sr = rate / f;
  }
  let peak = 1e-6;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  const gain = Math.min(20, 0.9 / peak);
  const buf = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  const srInt = Math.round(sr);
  w(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, srInt, true); v.setUint32(28, srInt * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i] * gain));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** 마이크 열기. 브라우저의 소음 제거·자동 음량은 코골이를 지워버릴 수 있어서 끕니다. */
export async function openMic({ onSamples, onEnded, onState }) {
  if (!window.isSecureContext) {
    throw new Error('마이크는 https 주소나 localhost에서만 쓸 수 있어요. README의 "휴대폰에서 쓰기"를 참고해 주세요.');
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 브라우저는 마이크 녹음을 지원하지 않아요.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: 'playback' });
  if (ctx.state === 'suspended') await ctx.resume();
  const factor = decimationFactor(ctx.sampleRate);
  const rate = ctx.sampleRate / factor;
  const src = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);

  let node;
  try {
    await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url).href);
    node = new AudioWorkletNode(ctx, 'jamsori-capture', {
      processorOptions: { factor }, numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    node.port.onmessage = (e) => onSamples(e.data);
  } catch {
    // 오래된 브라우저용 대체 경로
    node = ctx.createScriptProcessor(4096, 1, 1);
    let acc = 0, n = 0;
    node.onaudioprocess = (ev) => {
      const inp = ev.inputBuffer.getChannelData(0);
      const out = new Float32Array(Math.ceil(inp.length / factor) + 1);
      let j = 0;
      for (let i = 0; i < inp.length; i++) {
        acc += inp[i];
        if (++n === factor) { out[j++] = acc / factor; acc = 0; n = 0; }
      }
      onSamples(out.subarray(0, j));
    };
  }
  src.connect(node);
  node.connect(sink);

  const track = stream.getAudioTracks()[0];
  track?.addEventListener('ended', () => onEnded?.());
  ctx.onstatechange = () => onState?.(ctx.state);

  return {
    rate,
    ctx,
    label: track?.label || '',
    async resume() {
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    },
    async stop() {
      try { src.disconnect(); node.disconnect(); } catch { /* 이미 끊김 */ }
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => {});
    },
  };
}

/** 화면 꺼짐 방지 (지원하는 브라우저에서만) */
export class ScreenLock {
  constructor() {
    this.sentinel = null;
    this.wanted = false;
  }
  get supported() {
    return 'wakeLock' in navigator;
  }
  get active() {
    return !!this.sentinel && !this.sentinel.released;
  }
  async on() {
    this.wanted = true;
    if (!this.supported) return false;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      return true;
    } catch {
      return false;
    }
  }
  async off() {
    this.wanted = false;
    try { await this.sentinel?.release(); } catch { /* 무시 */ }
    this.sentinel = null;
  }
}

/** 녹음 파일 분석: 16kHz 로 디코딩해서 같은 파이프라인에 흘려보냄 */
export async function analyzeFile(file, { startMs = null, factors = [], excludeMin = 0, sensitivity = 'normal', onProgress, onClip } = {}) {
  const buf = await file.arrayBuffer();
  const rate = 16000;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, rate, rate);
  const audio = await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(buf, res, rej);
    if (p && p.then) p.then(res, rej);
  }).catch(() => {
    throw new Error('이 파일 형식을 읽지 못했어요. m4a, mp3, wav 파일로 다시 시도해 주세요.');
  });
  const durMs = audio.duration * 1000;
  const start = startMs ?? (file.lastModified ? file.lastModified - durMs : Date.now() - durMs);
  const rec = new NightRecorder({ rate, startMs: start, factors, excludeMin, sensitivity, source: 'file', label: file.name });
  rec.onClip = onClip;

  const chs = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chs.push(audio.getChannelData(c));
  const step = 2048;
  const tmp = new Float32Array(step);
  let lastYield = performance.now();
  for (let i = 0; i < audio.length; i += step) {
    const len = Math.min(step, audio.length - i);
    if (chs.length === 1) {
      rec.feed(chs[0].subarray(i, i + len));
    } else {
      for (let k = 0; k < len; k++) {
        let s = 0;
        for (const ch of chs) s += ch[i + k];
        tmp[k] = s / chs.length;
      }
      rec.feed(tmp.subarray(0, len));
    }
    if (performance.now() - lastYield > 60) {
      onProgress?.(i / audio.length);
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  onProgress?.(1);
  return rec.finish();
}
