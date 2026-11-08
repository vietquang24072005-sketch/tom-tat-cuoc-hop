const $ = (id) => document.getElementById(id);
const els = {
  dot: $("dot"), status: $("status"), title: $("title"), useMic: $("useMic"), useSystem: $("useSystem"),
  chunkSec: $("chunkSec"), btnRecord: $("btnRecord"), meter: $("meter"), timer: $("timer"),
  transcript: $("transcript"), pending: $("pending"), btnClear: $("btnClear"),
  btnSummarize: $("btnSummarize"), btnCopy: $("btnCopy"), btnShow: $("btnShow"), summary: $("summary"),
  btnSettings: $("btnSettings"), btnFolder: $("btnFolder"), settings: $("settings"), apiKey: $("apiKey"), model: $("model"),
  toast: $("toast"), transMode: $("transMode"), chunkWrap: $("chunkWrap"), live: $("live"), template: $("template"),
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
function savePrefs() { try { localStorage.setItem("transMode", els.transMode.value); localStorage.setItem("template", els.template.value); } catch {} }
function loadPrefs() {
  try {
    const m = localStorage.getItem("transMode"), t = localStorage.getItem("template");
    if (m) els.transMode.value = m;
    if (t && [...els.template.options].some((o) => o.value === t)) els.template.value = t;
  } catch {}
}

function updateStatus() {
  const via = config.provider === "gemini" ? "Gemini API" : "9router";
  els.status.textContent = config.hasKey ? `${via} · ${config.model}` : "Chưa có API key — bấm ⚙ Cài đặt";
  els.status.classList.toggle("warn", !config.hasKey);
}

// ---------- âm thanh ----------
const { downsample, encodeWav, blobToBase64 } = window.AudioUtils;
const LABEL = { mic: "Tôi", sys: "Người khác" };

// Viết hoa chữ đầu, bỏ khoảng trắng thừa (model offline trả về chữ hoa toàn bộ)
function tidy(text) {
  const t = text.toLocaleLowerCase("vi").replace(/\s+/g, " ").trim();
  return t ? t[0].toLocaleUpperCase("vi") + t.slice(1) : "";
}

// Thêm 1 dòng vào transcript (giữ vị trí cuộn nếu người dùng đang đọc phía trên)
function addLine(t, src, text) {
  const ta = els.transcript, atBottom = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 30;
  const who = rec?.labeled && src ? `${LABEL[src]}: ` : "";
  ta.value += `[${fmt(t)}] ${who}${text}\n`;
  if (atBottom) ta.scrollTop = ta.scrollHeight;
  saveDraft();
}

// ----- lọc trùng: không đeo tai nghe thì micro thu lại tiếng loa → câu của "Người khác" bị chép 2 lần -----
const words = (t) => t.toLocaleLowerCase("vi").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function overlap(a, b) {
  const wa = words(a), bag = new Map();
  if (wa.length < 2) return 0;
  for (const w of words(b)) bag.set(w, (bag.get(w) || 0) + 1);
  let hit = 0;
  for (const w of wa) { const n = bag.get(w); if (n) { hit++; bag.set(w, n - 1); } }
  return hit / wa.length;
}
const isEcho = (micText, micT) => rec.recentSys.some((x) => Math.abs(x.t - micT) < 6 && overlap(micText, x.text) >= 0.6);

function onMeetAsr(m) {
  if (!rec || rec.mode !== "instant") return;
  if (m.type === "partial") { rec.partial[m.src] = m.text; renderLive(); return; }
  if (m.type === "done") { rec.doneWait.delete(m.src); if (!rec.doneWait.size) rec.onAllDone?.(); return; }
  if (m.type !== "final") return;
  rec.partial[m.src] = ""; renderLive();
  const text = tidy(m.text);
  if (!text) return;
  if (m.src === "sys" && rec.labeled) {
    rec.recentSys.push({ t: m.t, text });
    if (rec.recentSys.length > 30) rec.recentSys.shift();
    // câu micro đang chờ mà trùng với câu loa vừa đến → bỏ
    rec.heldMic = rec.heldMic.filter((h) => { if (Math.abs(h.t - m.t) < 6 && overlap(h.text, text) >= 0.6) { clearTimeout(h.timer); return false; } return true; });
    addLine(m.t, "sys", text);
  } else if (m.src === "mic" && rec.labeled) {
    // giữ câu micro 1,5 giây để chờ câu loa tương ứng (nếu là tiếng vọng)
    const h = { t: m.t, text };
    h.timer = setTimeout(() => releaseMic(h), 1500);
    rec.heldMic.push(h);
  } else addLine(m.t, null, text);
}
function releaseMic(h) {
  if (!rec) return;
  rec.heldMic = rec.heldMic.filter((x) => x !== h);
  if (!isEcho(h.text, h.t)) addLine(h.t, "mic", h.text);
}
function renderLive() {
  if (!rec) { els.live.textContent = ""; return; }
  const parts = Object.entries(rec.partial).filter(([, t]) => t).map(([src, t]) => (rec.labeled ? `${LABEL[src]}: ` : "") + tidy(t));
  els.live.textContent = parts.length ? "🎙 " + parts.join("   ·   ") : "";
}
window.api.on("meet:asr", onMeetAsr);

function syncModeUI() { els.chunkWrap.style.display = els.transMode.value === "ai" ? "" : "none"; }

async function startRecording() {
  const mode = els.transMode.value === "ai" ? "ai" : "instant";
  if (mode === "ai" && !config.hasKey) { openSettings(); return toast("Chế độ AI cần API key"); }
  if (!els.useMic.checked && !els.useSystem.checked) return toast("Hãy chọn ít nhất một nguồn âm thanh");

  const sources = [];
  try {
    if (els.useSystem.checked) {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      display.getVideoTracks().forEach((t) => t.stop());
      if (!display.getAudioTracks().length) throw new Error("Không thu được âm thanh hệ thống");
      sources.push({ src: "sys", stream: display });
    }
    if (els.useMic.checked) {
      sources.push({ src: "mic", stream: await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) });
    }
  } catch (e) {
    sources.forEach((s) => s.stream.getTracks().forEach((t) => t.stop()));
    return toast("Không mở được nguồn âm thanh: " + cleanErr(e), 6000);
  }

  const names = sources.map((s) => s.src);
  if (mode === "instant") {
    const r = await window.api.meetAsrStart(names);
    if (!r.ok) { sources.forEach((s) => s.stream.getTracks().forEach((t) => t.stop())); return toast(r.error, 6000); }
  }

  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("recorder-worklet.js");
  const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  const mute = ctx.createGain(); mute.gain.value = 0; mute.connect(ctx.destination);

  rec = {
    mode, ctx, analyser, sources, names, startedAt: Date.now(),
    labeled: names.length === 2,      // chỉ khi có cả micro lẫn loa mới biết chắc ai nói
    parts: {}, chunkStart: 0,          // chế độ AI
    partial: {}, recentSys: [], heldMic: [], doneWait: new Set(), // chế độ tức thì
  };
  for (const s of sources) {
    const node = new AudioWorkletNode(ctx, "collector", { channelCount: s.src === "sys" ? 2 : 1, channelCountMode: "explicit" });
    const srcNode = ctx.createMediaStreamSource(s.stream);
    srcNode.connect(node); srcNode.connect(analyser); node.connect(mute);
    rec.parts[s.src] = [];
    node.port.onmessage = (e) => {
      if (!rec) return;
      if (rec.mode === "instant") window.api.meetAudio(s.src, downsample(e.data, ctx.sampleRate));
      else rec.parts[s.src].push(e.data);
    };
  }

  if (mode === "ai") rec.flushTimer = setInterval(flushChunk, Number(els.chunkSec.value) * 1000);
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

  sources.forEach((s) => s.stream.getTracks().forEach((t) => (t.onended = () => rec && stopRecording())));
  els.btnRecord.textContent = "■ Dừng & tóm tắt"; els.btnRecord.classList.add("stop");
  els.dot.classList.add("rec"); els.timer.textContent = "00:00";
  [els.useMic, els.useSystem, els.chunkSec, els.transMode].forEach((x) => (x.disabled = true));
  if (els.transcript.value.trim()) els.transcript.value = els.transcript.value.trimEnd() + "\n\n";
  pushMeeting();
  toast(mode === "instant" ? "Đang ghi — lời nói hiện ngay trong transcript" : "Đang ghi âm cuộc họp (chế độ AI)…");
}

// Chế độ AI: mỗi nguồn gửi riêng 1 đoạn, nên biết đoạn nào là "Tôi", đoạn nào là "Người khác"
function flushChunk() {
  if (!rec || rec.mode !== "ai") return;
  const offset = rec.chunkStart; rec.chunkStart = (Date.now() - rec.startedAt) / 1000;
  const sampleRate = rec.ctx.sampleRate, labeled = rec.labeled;
  for (const src of rec.names) {
    const parts = rec.parts[src]; rec.parts[src] = [];
    if (!parts.length) continue;
    const all = AudioUtils.concat(parts);
    if (AudioUtils.rms(all) < SILENCE_RMS) continue; // im lặng → không gửi, tiết kiệm API
    const wav = encodeWav(downsample(all, sampleRate), TARGET_RATE);
    setPending(1);
    queue = queue.then(async () => {
      try {
        const audio = await blobToBase64(wav);
        let text = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          try { text = await window.api.transcribe({ audio, mimeType: "audio/wav", previous: els.transcript.value, single: labeled }); break; }
          catch (e) { if (attempt === 1) throw e; await new Promise((r) => setTimeout(r, 1500)); }
        }
        if (text) {
          const ta = els.transcript, atBottom = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 30;
          ta.value += `[${fmt(offset)}] ${labeled ? LABEL[src] + ": " : ""}${text}\n`;
          if (atBottom) ta.scrollTop = ta.scrollHeight;
          saveDraft();
        }
      } catch (e) { toast("Lỗi chép đoạn " + fmt(offset) + ": " + cleanErr(e), 6000); }
      finally { setPending(-1); }
    });
  }
}

async function stopRecording() {
  if (!rec) return;
  clearInterval(rec.flushTimer); clearInterval(rec.clockTimer);
  if (rec.mode === "ai") flushChunk();
  const r = rec;
  r.sources.forEach((s) => s.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); }));
  els.btnRecord.textContent = "● Bắt đầu ghi"; els.btnRecord.classList.remove("stop"); els.dot.classList.remove("rec");
  els.btnRecord.disabled = true;
  stopping = true; pushMeeting();

  if (r.mode === "instant") {
    // chờ model chốt nốt câu cuối của từng nguồn (tối đa 4 giây)
    await new Promise((resolve) => {
      r.doneWait = new Set(r.names); r.onAllDone = resolve;
      window.api.meetAsrStop(r.names);
      setTimeout(resolve, 4000);
    });
    for (const h of [...r.heldMic]) { clearTimeout(h.timer); releaseMic(h); }
  } else {
    toast("Đang chép nốt các đoạn cuối…");
    await queue;
  }
  r.ctx.close();
  rec = null; renderLive();
  [els.useMic, els.useSystem, els.chunkSec, els.transMode].forEach((x) => (x.disabled = false));
  stopping = false; pushMeeting();
  els.btnRecord.disabled = false;
  if (!els.transcript.value.trim()) return toast("Không ghi nhận được lời nói nào");
  if (!config.hasKey) { openSettings(); return toast("Đã chép xong. Nhập API key để tóm tắt"); }
  summarize();
}

// ---------- tóm tắt ----------
function list(arr) { return arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="none">Không có</p>`; }
function renderSummary(s) {
  const tasks = s.viec_can_lam?.length
    ? `<table><thead><tr><th>${esc(s.ten_viec || "Việc cần làm")}</th><th>Phụ trách</th><th>Hạn</th></tr></thead><tbody>${s.viec_can_lam
        .map((t) => `<tr><td>${esc(t.viec)}</td><td>${esc(t.nguoi_phu_trach)}</td><td>${esc(t.han)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="none">Không có</p>`;
  els.summary.classList.remove("empty");
  els.summary.innerHTML = `
    <span class="tag">${esc(s.loai_ten || "Họp chung")}</span>
    <h3>${esc(s.tieu_de || "Biên bản")}</h3>
    <p class="overview">${esc(s.tong_quan)}</p>
    ${(s.muc || []).map((m) => `<h4>${esc(m.tieu_de)}</h4>${list(m.y)}`).join("")}
    <h4>${esc(s.ten_viec || "Việc cần làm")}</h4>${tasks}`;
}

async function summarize() {
  const transcript = els.transcript.value.trim();
  if (!transcript) return toast("Transcript đang trống");
  if (!config.hasKey) { openSettings(); return toast("Hãy nhập API key trước"); }
  els.btnSummarize.disabled = true; els.btnSummarize.textContent = "Đang tóm tắt…";
  summarizing = true; pushMeeting();
  try {
    const { summary, markdown, file } = await window.api.summarize({ title: els.title.value.trim(), transcript, template: els.template.value });
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
els.transMode.addEventListener("change", () => { syncModeUI(); savePrefs(); });
els.template.addEventListener("change", savePrefs);
window.addEventListener("beforeunload", (e) => { if (rec) { e.preventDefault(); e.returnValue = ""; } });

(async () => {
  loadDraft(); loadPrefs(); syncModeUI();
  config = await window.api.getConfig();
  updateStatus();
  if (!config.hasKey) setTimeout(openSettings, 300);
})();
