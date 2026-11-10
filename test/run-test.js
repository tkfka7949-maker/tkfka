// 검출기 + 분석기 자동 테스트:  node test/run-test.js
import { Detector } from '../js/detector.js';
import { analyzeNight, findSnores, SENSITIVITY } from '../js/analysis.js';
import { synthNight } from './synth.js';

const { samples, sr, truth, durationSec } = synthNight();
const events = [];
const det = new Detector(sr, {}, (e) => events.push(e));
const t0 = Date.now();
for (let i = 0; i < samples.length; i += 2048) det.push(samples.subarray(i, i + 2048));
det.flush();
const ms = Date.now() - t0;

const night = { start: Date.UTC(2026, 10, 9, 15, 0), end: Date.UTC(2026, 10, 9, 15, 0) + durationSec * 1000, events, amb: [] };
const a = analyzeNight(night);

const inRange = (t, [x, y]) => t >= x && t < y;
const snoreTimes = a.snores.map((e) => e.t);
const hits = truth.snores.filter((t) => snoreTimes.some((s) => Math.abs(s - t) < 0.6)).length;
const falseTalk = snoreTimes.filter((t) => inRange(t, truth.talk)).length;
const falseFan = snoreTimes.filter((t) => inRange(t, [truth.fan[0], truth.fan[1]])).length;
const falseOther = snoreTimes.filter((t) => !truth.snores.some((s) => Math.abs(s - t) < 0.6)).length;
const apHits = truth.apneas.filter((g) => a.apneas.some((ap) => Math.abs(ap.t - g) < 3)).length;

console.log(`처리 시간: ${ms}ms (오디오 ${durationSec}s, 소리 이벤트 ${events.length}개)`);
console.log(`코골이: 정답 ${truth.snores.length}회 / 찾음 ${a.snoreCount}회 / 맞힘 ${hits}회 / 엉뚱한 곳 ${falseOther}회`);
console.log(`  말소리 구간 오검출 ${falseTalk}회, 선풍기 구간 오검출 ${falseFan}회`);
console.log(`호흡 멈춤: 정답 ${truth.apneas.length}회 / 찾음 ${a.apneas.length}회 (강 ${a.strongCount}, 약 ${a.weakCount}) / 맞힘 ${apHits}회`);
console.log(`코골이 시간 ${a.snoreMinutes}분 / 분석 ${a.analyzedMin.toFixed(1)}분 (${a.snorePct.toFixed(1)}%), 강도별 분: ${a.levelMinutes.slice(1).join('/')}`);
console.log(`구간 ${a.bouts.length}개, 규칙성 CV ${a.regularityCV?.toFixed(2)}, 주파수 중간값 ${a.peakFreqMedian}Hz`);
console.log('결과 문장:');
for (const f of a.findings) console.log(`  [${f.sev}] ${f.title}`);

for (const key of Object.keys(SENSITIVITY)) {
  const n = findSnores(events.filter((e) => e.t >= 0), SENSITIVITY[key]).length;
  console.log(`민감도 ${key}: 코골이 ${n}회`);
}

// 진단용: 말소리 구간 이벤트 특징
if (process.argv.includes('--debug')) {
  const show = (label, range) => {
    console.log(`-- ${label}`);
    for (const e of events.filter((e) => inRange(e.t, range)).slice(0, 12)) console.log(JSON.stringify(e));
  };
  show('snore', [60, 80]);
  show('gasp', [490, 500]);
  show('talk', truth.talk);
  show('door/fan', [790, 830]);
  show('quiet snore', [905, 925]);
}

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fail++; };
check(hits / truth.snores.length >= 0.9, '코골이 90% 이상 검출');
check(falseOther <= 3, '코골이 아닌 소리를 코골이로 센 횟수 3회 이하');
check(falseTalk === 0, '말소리를 코골이로 세지 않음');
check(apHits === truth.apneas.length, '호흡 멈춤 4번 모두 검출');
check(a.apneas.length === truth.apneas.length, '호흡 멈춤 과다 검출 없음 (조용한 휴식 구간은 세지 않음)');

// 녹음 세션: 실시간처럼 흘려보내면서 클립이 잘 잘리는지
const { NightRecorder } = await import('../js/recorder.js');
const rec = new NightRecorder({ rate: sr, startMs: night.start });
const clips = [];
rec.onClip = (c) => clips.push(c);
for (let i = 0; i < samples.length; i += 2048) rec.feed(samples.subarray(i, i + 2048));
const recNight = rec.finish();
const apClips = clips.filter((c) => c.kind === 'apnea');
console.log(`클립: 호흡 멈춤 ${apClips.length}개, 코골이 ${clips.length - apClips.length}개, 길이 ${apClips.map((c) => Math.round(c.t1 - c.t0) + 's').join(' ')}`);
check(apClips.length === truth.apneas.length, '호흡 멈춤마다 확인용 클립 저장');
check(apClips.every((c) => c.t0 < truth.apneas.find((g) => Math.abs(g - c.t0 - 6) < 4) && c.t1 - c.t0 >= 25), '클립에 멈추기 전 코골이부터 다시 시작까지 담김');
check(apClips.every((c) => c.blob.size > 1000 && c.blob.type === 'audio/wav'), '클립이 WAV 파일로 만들어짐');
check(recNight.events.length === events.length, '세션 경로와 직접 검출 결과가 같음');

// 화면 꺼짐으로 오디오가 끊긴 경우: 끊긴 동안을 호흡 멈춤으로 세면 안 됨
const rec2 = new NightRecorder({ rate: sr, startMs: night.start });
const cut = 150 * sr;
for (let i = 0; i < cut; i += 2048) rec2.feed(samples.subarray(i, Math.min(cut, i + 2048)));
rec2.skip(40);
for (let i = cut + 40 * sr; i < 360 * sr; i += 2048) rec2.feed(samples.subarray(i, i + 2048));
const a2 = analyzeNight(rec2.finish());
check(a2.apneas.length === 0, '녹음이 끊긴 40초는 호흡 멈춤으로 세지 않음');
check(Math.abs(a2.gapSec - 40) < 1, '끊긴 시간을 분석 시간에서 뺌');

process.exit(fail ? 1 : 0);
