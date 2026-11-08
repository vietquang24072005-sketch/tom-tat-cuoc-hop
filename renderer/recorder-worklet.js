// Gom mẫu âm thanh (đã trộn hệ thống + micro) và gửi về luồng chính theo khối 4096 mẫu.
class Collector extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const ch0 = input[0], ch1 = input[1];
      for (let i = 0; i < ch0.length; i++) {
        this.buf[this.n++] = ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("collector", Collector);
