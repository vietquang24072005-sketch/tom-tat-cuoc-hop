// Tiến trình riêng: nhận giọng nói tiếng Việt offline (sherpa-onnx), không làm đứng giao diện.
// Chạy được nhiều luồng cùng lúc, mỗi luồng có id riêng (vd "dict", "meet-mic", "meet-sys").
// Nhận: {type:"start", id} | {type:"audio", id, samples: Float32Array 16 kHz} | {type:"stop", id}
// Gửi:  {type:"ready"} | {type:"partial", id, text} | {type:"final", id, text, t} | {type:"done", id} | {type:"error", message}
//       (t = thời điểm bắt đầu câu, tính bằng giây từ lúc start)
const path = require("path");
const sherpa = require("sherpa-onnx-node");

const RATE = 16000;
const FRAME = 480;                 // 30 ms
const PREROLL = RATE * 0.3;        // giữ 300 ms trước khi bắt đầu nói để không mất âm đầu
const END_SILENCE_MS = 550;        // im lặng bao lâu thì chốt câu
const PARTIAL_EVERY = RATE * 0.25; // cập nhật chữ tạm mỗi 250 ms âm thanh
const MAX_SEGMENT = RATE * 20;

const MODEL_DIR = path.join(process.env.ASR_MODEL_DIR || path.join(__dirname, "models"), "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09");
let recognizer = null;
const post = (m) => process.parentPort.postMessage(m);

function load() {
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(MODEL_DIR, "encoder.int8.onnx"),
        decoder: path.join(MODEL_DIR, "decoder.onnx"),
        joiner: path.join(MODEL_DIR, "joiner.int8.onnx"),
      },
      tokens: path.join(MODEL_DIR, "tokens.txt"),
      numThreads: 2, provider: "cpu", debug: 0,
    },
    decodingMethod: "greedy_search",
  });
}

function decode(samples) {
  if (!samples.length) return "";
  const s = recognizer.createStream();
  // thêm 0.2 s im lặng cuối để model không cắt mất từ cuối
  const padded = new Float32Array(samples.length + RATE * 0.2);
  padded.set(samples);
  s.acceptWaveform({ sampleRate: RATE, samples: padded });
  recognizer.decode(s);
  return recognizer.getResult(s).text.trim();
}

const concat = (arr, len) => { const o = new Float32Array(len); let p = 0; for (const a of arr) { o.set(a, p); p += a.length; } return o; };

class Session {
  constructor(id) {
    this.id = id;
    this.pending = new Float32Array(0); // mẫu chưa đủ 1 frame
    this.pre = []; this.preLen = 0;     // đệm trước khi nói
    this.seg = []; this.segLen = 0;     // câu đang nói
    this.speaking = false; this.silenceMs = 0; this.sinceDecode = 0;
    this.noise = 0.004; this.lastPartial = "";
    this.total = 0; this.segStart = 0;  // đếm mẫu để tính thời điểm câu
  }

  finalize() {
    if (!this.segLen) return;
    const text = decode(concat(this.seg, this.segLen));
    const t = this.segStart / RATE;
    this.seg = []; this.segLen = 0; this.speaking = false; this.silenceMs = 0; this.sinceDecode = 0; this.lastPartial = "";
    if (text) post({ type: "final", id: this.id, text, t });
    else post({ type: "partial", id: this.id, text: "" });
  }

  frame(f) {
    this.total += f.length;
    let sq = 0; for (let i = 0; i < f.length; i++) sq += f[i] * f[i];
    const rms = Math.sqrt(sq / f.length);
    const voiced = rms > Math.max(0.01, this.noise * 3);

    if (!this.speaking) {
      this.noise = this.noise * 0.97 + Math.min(rms, 0.05) * 0.03; // ước lượng tiếng ồn nền
      this.pre.push(f); this.preLen += f.length;
      while (this.preLen - this.pre[0].length >= PREROLL) this.preLen -= this.pre.shift().length;
      if (voiced) {
        this.speaking = true;
        this.segStart = this.total - this.preLen;
        this.seg = this.pre; this.segLen = this.preLen; this.pre = []; this.preLen = 0;
        this.silenceMs = 0; this.sinceDecode = 0;
      }
      return;
    }

    this.seg.push(f); this.segLen += f.length; this.sinceDecode += f.length;
    this.silenceMs = voiced ? 0 : this.silenceMs + (f.length / RATE) * 1000;

    if (this.silenceMs >= END_SILENCE_MS || this.segLen >= MAX_SEGMENT) return this.finalize();
    if (this.sinceDecode >= PARTIAL_EVERY) {
      this.sinceDecode = 0;
      const text = decode(concat(this.seg, this.segLen));
      if (text !== this.lastPartial) { this.lastPartial = text; post({ type: "partial", id: this.id, text }); }
    }
  }

  audio(samples) {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending); all.set(samples, this.pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) this.frame(all.subarray(i, i + FRAME).slice());
    this.pending = all.slice(i);
  }

  stop() {
    if (this.speaking) {
      if (this.pending.length) { this.seg.push(this.pending); this.segLen += this.pending.length; }
      this.finalize();
    }
  }
}

const sessions = new Map();

process.parentPort.on("message", (e) => {
  const msg = e.data;
  const id = msg.id || "dict";
  try {
    if (msg.type === "start") sessions.set(id, new Session(id));
    else if (msg.type === "audio") sessions.get(id)?.audio(msg.samples);
    else if (msg.type === "stop") {
      sessions.get(id)?.stop();
      sessions.delete(id);
      post({ type: "done", id });
    }
  } catch (err) {
    post({ type: "error", message: err.message });
  }
});

try { load(); post({ type: "ready" }); }
catch (err) { post({ type: "error", message: "Không tải được model giọng nói: " + err.message }); }
