// Tiến trình riêng: nhận giọng nói tiếng Việt offline (sherpa-onnx), không làm đứng giao diện.
// Nhận: {type:"start"} | {type:"audio", samples: Float32Array 16 kHz} | {type:"stop"}
// Gửi:  {type:"ready"} | {type:"partial", text} | {type:"final", text} | {type:"done"} | {type:"error", message}
const path = require("path");
const sherpa = require("sherpa-onnx-node");

const RATE = 16000;
const FRAME = 480;              // 30 ms
const PREROLL = RATE * 0.3;     // giữ 300 ms trước khi bắt đầu nói để không mất âm đầu
const END_SILENCE_MS = 550;     // im lặng bao lâu thì chốt câu
const PARTIAL_EVERY = RATE * 0.25; // cập nhật chữ tạm mỗi 250 ms âm thanh
const MAX_SEGMENT = RATE * 20;

const MODEL_DIR = path.join(process.env.ASR_MODEL_DIR || path.join(__dirname, "models"), "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09");
let recognizer = null;

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

// ---------- trạng thái 1 phiên đọc ----------
let st = null;
function reset() {
  st = {
    pending: new Float32Array(0), // mẫu chưa đủ 1 frame
    pre: [], preLen: 0,           // đệm trước khi nói
    seg: [], segLen: 0,           // câu đang nói
    speaking: false, silenceMs: 0, sinceDecode: 0,
    noise: 0.004, lastPartial: "",
  };
}
const concat = (arr, len) => { const o = new Float32Array(len); let p = 0; for (const a of arr) { o.set(a, p); p += a.length; } return o; };

function finalize() {
  if (!st.segLen) return;
  const text = decode(concat(st.seg, st.segLen));
  st.seg = []; st.segLen = 0; st.speaking = false; st.silenceMs = 0; st.sinceDecode = 0; st.lastPartial = "";
  if (text) process.parentPort.postMessage({ type: "final", text });
  else process.parentPort.postMessage({ type: "partial", text: "" });
}

function onFrame(f) {
  let sq = 0; for (let i = 0; i < f.length; i++) sq += f[i] * f[i];
  const rms = Math.sqrt(sq / f.length);
  const thr = Math.max(0.01, st.noise * 3);
  const voiced = rms > thr;

  if (!st.speaking) {
    st.noise = st.noise * 0.97 + Math.min(rms, 0.05) * 0.03; // ước lượng tiếng ồn nền
    st.pre.push(f); st.preLen += f.length;
    while (st.preLen - st.pre[0].length >= PREROLL) st.preLen -= st.pre.shift().length;
    if (voiced) {
      st.speaking = true;
      st.seg = st.pre; st.segLen = st.preLen; st.pre = []; st.preLen = 0; st.silenceMs = 0; st.sinceDecode = 0;
    }
    return;
  }

  st.seg.push(f); st.segLen += f.length; st.sinceDecode += f.length;
  st.silenceMs = voiced ? 0 : st.silenceMs + (f.length / RATE) * 1000;

  if (st.silenceMs >= END_SILENCE_MS || st.segLen >= MAX_SEGMENT) return finalize();
  if (st.sinceDecode >= PARTIAL_EVERY) {
    st.sinceDecode = 0;
    const text = decode(concat(st.seg, st.segLen));
    if (text !== st.lastPartial) { st.lastPartial = text; process.parentPort.postMessage({ type: "partial", text }); }
  }
}

function onAudio(samples) {
  const all = new Float32Array(st.pending.length + samples.length);
  all.set(st.pending); all.set(samples, st.pending.length);
  let i = 0;
  for (; i + FRAME <= all.length; i += FRAME) onFrame(all.subarray(i, i + FRAME).slice());
  st.pending = all.slice(i);
}

process.parentPort.on("message", (e) => {
  const msg = e.data;
  try {
    if (msg.type === "start") reset();
    else if (msg.type === "audio" && st) onAudio(msg.samples);
    else if (msg.type === "stop" && st) {
      if (st.speaking) { if (st.pending.length) { st.seg.push(st.pending); st.segLen += st.pending.length; } finalize(); }
      st = null;
      process.parentPort.postMessage({ type: "done" });
    }
  } catch (err) {
    process.parentPort.postMessage({ type: "error", message: err.message });
  }
});

try { load(); process.parentPort.postMessage({ type: "ready" }); }
catch (err) { process.parentPort.postMessage({ type: "error", message: "Không tải được model giọng nói: " + err.message }); }
