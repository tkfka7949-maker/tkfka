// 잠소리 — 오디오 캡처 워크렛
// 마이크 샘플을 받아 채널을 합치고 정수 배수로 줄여서(예: 48kHz → 16kHz) 2048개씩 메인 스레드로 보냅니다.

class JamsoriCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.factor = Math.max(1, options.processorOptions?.factor || 1);
    this.acc = 0;
    this.n = 0;
    this.buf = new Float32Array(2048);
    this.i = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const chs = input.length;
    const len = input[0].length;
    for (let s = 0; s < len; s++) {
      let v = 0;
      for (let c = 0; c < chs; c++) v += input[c][s];
      this.acc += v / chs;
      if (++this.n === this.factor) {
        this.buf[this.i++] = this.acc / this.factor;
        this.acc = 0;
        this.n = 0;
        if (this.i === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(2048);
          this.i = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('jamsori-capture', JamsoriCapture);
