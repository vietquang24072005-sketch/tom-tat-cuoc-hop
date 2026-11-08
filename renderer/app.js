const $ = (id) => document.getElementById(id);
const els = {
  dot: $("dot"), status: $("status"), title: $("title"), useMic: $("useMic"), useSystem: $("useSystem"),
  chunkSec: $("chunkSec"), btnRecord: $("btnRecord"), meter: $("meter"), timer: $("timer"),
  transcript: $("transcript"), pending: $("pending"), btnClear: $("btnClear"),
  btnSummarize: $("btnSummarize"), btnCopy: $("btnCopy"), btnShow: $("btnShow"), summary: $("summary"),
  btnSettings: $("btnSettings"), btnFolder: $("btnFolder"), settings: $("settings"), apiKey: $("apiKey"), model: $("model"),
  toast: $("toast"),
};

const TARGET_RATE = 16000;
const SILENCE_RMS = 0.004;
let rec = null;            // trạng thái phiên ghi đang chạy
let queue = Promise.resolve();
let pendingCount = 0;
let lastMarkdown = "", lastFile = "";
let config = { hasKey: false, model: "" };
let stopping = false, summarizing = false;

// Báo trạng thái cuộc họp cho nút nổi + khay hệ thống
function pushMeeting() {
  window.api.meetingState({ recording: !!rec, busy: stopping || summarizing, elapsed: rec ? (Date.now() - rec.startedAt) / 1000 : 0 });
}

// ---------- tiện ích ----------
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
function toast(msg, ms = 3500) {
  if (document.hidden) window.api.notify(msg); // cửa sổ đang ẩn → hiện thông báo Windows
  els.toast.textContent = msg; els.toast.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => els.toast.classList.remove("show"), ms);
}
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function setPending(delta) {
  pendingCount += delta;
  els.pending.textContent = pendingCount > 0 ? `Đang chép ${pendingCount} đoạn…` : "";
}
function saveDraft() { try { localStorage.setItem("draft", els.transcript.value); localStorage.setItem("title", els.title.value); } catch {} }
function loadDraft() { try { els.transcript.value = localStorage.getItem("draft") || ""; els.title.value = localStorage.getItem("title") || ""; } catch {} }

function updateStatus() {
  const via = config.provider === "gemini" ? "Gemini API" : "9router";
  els.status.textContent = config.hasKey ? `${via} · ${config.model}` : "Chưa có API key — bấm ⚙ Cài đặt";
  els.status.classList.toggle("warn", !config.hasKey);
}

// ---------- âm thanh ----------
const { downsample, encodeWav, blobToBase64 } = window.AudioUtils;

async function startRecording() {
  if (!config.hasKey) { openSettings(); return toast("Hãy nhập API key trước"); }
  if (!els.useMic.checked && !els.useSystem.checked) return toast("Hãy chọn ít nhất một nguồn âm thanh");

  const streams = [];
  try {
    if (els.useSystem.checked) {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      display.getVideoTracks().forEach((t) => t.stop());
      if (!display.getAudioTracks().length) throw new Error("Không thu được âm thanh hệ thống");
      streams.push(display);
    }
    if (els.useMic.checked) {
      streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }));
    }
  } catch (e) {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    return toast("Không mở được nguồn âm thanh: " + cleanErr(e), 6000);
  }

  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("recorder-worklet.js");
  const node = new AudioWorkletNode(ctx, "collector", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit" });
  const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  const mute = ctx.createGain(); mute.gain.value = 0;
  for (const s of streams) { const src = ctx.createMediaStreamSource(s); src.connect(node); src.connect(analyser); }
  node.connect(mute).connect(ctx.destination);

  rec = { ctx, node, analyser, streams, parts: [], startedAt: Date.now(), chunkStart: 0 };
  node.port.onmessage = (e) => rec && rec.parts.push(e.data);

  const chunkMs = Number(els.chunkSec.value) * 1000;
  rec.flushTimer = setInterval(flushChunk, chunkMs);
  rec.clockTimer = setInterval(() => { els.timer.textContent = fmt((Date.now() - rec.startedAt) / 1000); pushMeeting(); }, 1000);
  const level = new Float32Array(analyser.fftSize);
  const draw = () => {
    if (!rec) { els.meter.style.width = "0"; return; }
    analyser.getFloatTimeDomainData(level);
    let peak = 0; for (const x of level) peak = Math.max(peak, Math.abs(x));
    els.meter.style.width = Math.min(100, peak * 140) + "%";
    requestAnimationFrame(draw);
  };
  draw();

  streams.forEach((s) => s.getTracks().forEach((t) => (t.onended = () => rec && stopRecording())));
  els.btnRecord.textContent = "■ Dừng & tóm tắt"; els.btnRecord.classList.add("stop");
  els.dot.classList.add("rec"); els.timer.textContent = "00:00";
  [els.useMic, els.useSystem, els.chunkSec].forEach((x) => (x.disabled = true));
  if (els.transcript.value.trim()) els.transcript.value = els.transcript.value.trimEnd() + "\n\n";
  pushMeeting();
  toast("Đang ghi âm cuộc họp…");
}

function flushChunk() {
  if (!rec || !rec.parts.length) return;
  const parts = rec.parts; rec.parts = [];
  const offset = rec.chunkStart; rec.chunkStart = (Date.now() - rec.startedAt) / 1000;
  const total = parts.reduce((n, p) => n + p.length, 0), all = new Float32Array(total);
  let pos = 0; for (const p of parts) { all.set(p, pos); pos += p.length; }
  let sq = 0; for (let i = 0; i < all.length; i++) sq += all[i] * all[i];
  if (Math.sqrt(sq / all.length) < SILENCE_RMS) return; // im lặng → không gửi, tiết kiệm API

  const wav = encodeWav(downsample(all, rec.ctx.sampleRate), TARGET_RATE);
  setPending(1);
  queue = queue.then(async () => {
    try {
      const audio = await blobToBase64(wav);
      let text = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try { text = await window.api.transcribe({ audio, mimeType: "audio/wav", previous: els.transcript.value }); break; }
        catch (e) { if (attempt === 1) throw e; await new Promise((r) => setTimeout(r, 1500)); }
      }
      if (text) {
        const ta = els.transcript, atBottom = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 30;
        ta.value += `[${fmt(offset)}] ${text}\n`;
        if (atBottom) ta.scrollTop = ta.scrollHeight;
        saveDraft();
      }
    } catch (e) { toast("Lỗi chép đoạn " + fmt(offset) + ": " + cleanErr(e), 6000); }
    finally { setPending(-1); }
  });
}

async function stopRecording() {
  if (!rec) return;
  clearInterval(rec.flushTimer); clearInterval(rec.clockTimer);
  flushChunk();
  const r = rec; rec = null;
  r.streams.forEach((s) => s.getTracks().forEach((t) => { t.onended = null; t.stop(); }));
  r.ctx.close();
  els.btnRecord.textContent = "● Bắt đầu ghi"; els.btnRecord.classList.remove("stop"); els.dot.classList.remove("rec");
  [els.useMic, els.useSystem, els.chunkSec].forEach((x) => (x.disabled = false));
  els.btnRecord.disabled = true;
  stopping = true; pushMeeting();
  toast("Đang chép nốt các đoạn cuối…");
  await queue;
  stopping = false; pushMeeting();
  els.btnRecord.disabled = false;
  if (els.transcript.value.trim()) summarize();
  else toast("Không ghi nhận được lời nói nào");
}

// ---------- tóm tắt ----------
function list(arr) { return arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="none">Không có</p>`; }
function renderSummary(s) {
  const tasks = s.viec_can_lam?.length
    ? `<table><thead><tr><th>Việc cần làm</th><th>Phụ trách</th><th>Hạn</th></tr></thead><tbody>${s.viec_can_lam
        .map((t) => `<tr><td>${esc(t.viec)}</td><td>${esc(t.nguoi_phu_trach)}</td><td>${esc(t.han)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="none">Không có</p>`;
  els.summary.classList.remove("empty");
  els.summary.innerHTML = `
    <h3>${esc(s.tieu_de || "Biên bản cuộc họp")}</h3>
    <p class="overview">${esc(s.tong_quan)}</p>
    <h4>Người tham gia</h4>${list(s.nguoi_tham_gia)}
    <h4>Điểm chính</h4>${list(s.diem_chinh)}
    <h4>Quyết định</h4>${list(s.quyet_dinh)}
    <h4>Việc cần làm</h4>${tasks}
    <h4>Vấn đề còn mở</h4>${list(s.van_de_mo)}`;
}

async function summarize() {
  const transcript = els.transcript.value.trim();
  if (!transcript) return toast("Transcript đang trống");
  if (!config.hasKey) { openSettings(); return toast("Hãy nhập API key trước"); }
  els.btnSummarize.disabled = true; els.btnSummarize.textContent = "Đang tóm tắt…";
  summarizing = true; pushMeeting();
  try {
    const { summary, markdown, file } = await window.api.summarize({ title: els.title.value.trim(), transcript });
    renderSummary(summary);
    lastMarkdown = markdown; lastFile = file;
    els.btnCopy.disabled = els.btnShow.disabled = false;
    toast("Đã lưu biên bản: " + file.split(/[\\/]/).pop());
  } catch (e) { toast("Lỗi tóm tắt: " + cleanErr(e), 7000); }
  finally { els.btnSummarize.disabled = false; els.btnSummarize.textContent = "Tóm tắt"; summarizing = false; pushMeeting(); }
}

// ---------- cài đặt ----------
const PROVIDER_DEFAULTS = {
  "9router": { model: "ag/gemini-3.8-flash", key: "sk-…", hint: "Mặc định ag/gemini-3.8-flash (đã thử: nghe được âm thanh). Dùng model ag/gemini-… vì model Claude/GPT không nghe được âm thanh." },
  gemini: { model: "gemini-2.5-flash", key: "AIza…", hint: "Mặc định gemini-2.5-flash. Key lấy tại aistudio.google.com." },
};
function syncProviderUI(resetModel) {
  const p = $("provider").value, d = PROVIDER_DEFAULTS[p], same = p === config.provider;
  $("baseUrlField").style.display = p === "9router" ? "" : "none";
  $("modelHint").textContent = d.hint;
  els.apiKey.placeholder = same && config.hasKey ? "Đã lưu key (để trống nếu không đổi)" : `Dán key ${d.key}`;
  if (resetModel) els.model.value = same ? config.model : d.model;
}
function openSettings() {
  window.api.showMain();
  $("provider").value = config.provider || "9router";
  $("baseUrl").value = config.baseUrl || "http://localhost:20128/v1";
  els.apiKey.value = "";
  syncProviderUI(true);
  els.settings.showModal();
}
$("provider").addEventListener("change", () => syncProviderUI(true));
els.settings.addEventListener("close", async () => {
  if (els.settings.returnValue !== "save") return;
  config = { ...config, ...(await window.api.setConfig({ provider: $("provider").value, baseUrl: $("baseUrl").value, apiKey: els.apiKey.value, model: els.model.value })) };
  updateStatus(); toast(config.hasKey ? "Đã lưu cài đặt" : "Đã lưu — nhưng chưa có API key");
});

// ---------- sự kiện ----------
els.btnRecord.onclick = () => (rec ? stopRecording() : startRecording());
// gọi từ nút nổi (qua main process)
window.__toggleMeeting = () => { if (stopping || summarizing) return; rec ? stopRecording() : startRecording(); };
els.btnSummarize.onclick = summarize;
els.btnCopy.onclick = async () => { await navigator.clipboard.writeText(lastMarkdown); toast("Đã sao chép biên bản (Markdown)"); };
els.btnShow.onclick = () => lastFile && window.api.showFile(lastFile);
els.btnFolder.onclick = () => window.api.openMeetings();
els.btnSettings.onclick = openSettings;
els.btnClear.onclick = () => { if (!els.transcript.value || confirm("Xoá toàn bộ transcript?")) { els.transcript.value = ""; saveDraft(); } };
els.transcript.addEventListener("input", saveDraft);
els.title.addEventListener("input", saveDraft);
window.addEventListener("beforeunload", (e) => { if (rec) { e.preventDefault(); e.returnValue = ""; } });

(async () => {
  loadDraft();
  config = await window.api.getConfig();
  updateStatus();
  if (!config.hasKey) setTimeout(openSettings, 300);
})();
