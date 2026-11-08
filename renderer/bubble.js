// Nút nổi: gõ bằng giọng nói + điều khiển ghi cuộc họp
const bridge = window.api;
const bar = document.getElementById("bar");
const orb = document.getElementById("orb");
const aDict = document.getElementById("aDict");
const aMeet = document.getElementById("aMeet");
const aOpen = document.getElementById("aOpen");
const meetTime = document.getElementById("meetTime");

const MAX_DICTATION_MS = 2 * 60 * 1000;
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

let dictState = "idle"; // idle | rec | busy
let dict = null;
let expanded = false;
let meeting = { recording: false, busy: false, elapsed: 0 };
let flashTimer = null;

// ---------- hiển thị ----------
function setOrb(cls) {
  orb.classList.remove("rec", "busy", "ok", "err", "empty");
  if (cls) orb.classList.add(cls);
}
function setDictState(s) {
  dictState = s;
  clearTimeout(flashTimer);
  setOrb(s === "idle" ? "" : s);
  orb.title = s === "rec" ? "Đang nghe… bấm để dừng và gõ (Esc: huỷ)" : s === "busy" ? "Đang chuyển giọng nói thành chữ…" : "Bấm: mở menu · Kéo: di chuyển · Chuột phải: tuỳ chọn";
  bridge.bubbleDictState(s);
}
function flash(kind, msg) {
  setDictState("idle");
  setOrb(kind);
  if (msg) orb.title = msg;
  flashTimer = setTimeout(() => setOrb(""), kind === "err" ? 3000 : 1300);
}
async function setExpanded(v) {
  if (expanded === v) return;
  expanded = v;
  const { dir } = await bridge.bubbleExpand(v);
  bar.classList.toggle("left", dir === "left");
  bar.classList.toggle("open", v);
}
function renderMeeting() {
  bar.classList.toggle("meeting", meeting.recording);
  aMeet.disabled = meeting.busy && !meeting.recording;
  aMeet.title = meeting.recording ? "Dừng ghi & tóm tắt" : meeting.busy ? "Đang tóm tắt…" : "Ghi cuộc họp";
  meetTime.textContent = meeting.recording ? fmt(meeting.elapsed) : "";
}

// ---------- gõ bằng giọng nói ----------
// Chế độ "instant": gửi âm thanh liên tục (16 kHz) cho model offline → chữ hiện ngay, gõ vào ô mỗi khi ngừng nói.
// Chế độ "ai": ghi xong cả đoạn rồi gửi AI (chậm hơn, có dấu câu).
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
let audioCtx = null;
async function prepareAudio() {
  if (!audioCtx) {
    audioCtx = (async () => {
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule("recorder-worklet.js");
      return ctx;
    })();
  }
  return audioCtx;
}
prepareAudio(); // chuẩn bị sẵn để bấm là nghe ngay

let starting = null, stopWanted = false, doneTimer = null;

function startDictation() {
  if (dictState !== "idle" || starting) return;
  setExpanded(false);
  setDictState("rec"); // đổi màu ngay lập tức
  stopWanted = false;
  starting = (async () => {
    const micP = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const [ctx, start] = await Promise.all([prepareAudio(), bridge.dictStart()]);
    if (start.mode === "none") { micP.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {}); return flash("err", "Bộ nhận giọng nói chưa sẵn sàng"); }
    let stream;
    try { stream = await micP; }
    catch (e) { bridge.dictStop({ cancel: true }); return flash("err", "Không mở được micro: " + e.message); }
    if (ctx.state !== "running") await ctx.resume();

    const node = new AudioWorkletNode(ctx, "collector", { channelCount: 1, channelCountMode: "explicit" });
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
    const src = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(node); src.connect(analyser); node.connect(mute).connect(ctx.destination);

    dict = { mode: start.mode, stream, src, node, mute, analyser, parts: [], startedAt: Date.now(), sampleRate: ctx.sampleRate };
    node.port.onmessage = (e) => {
      if (!dict) return;
      if (dict.mode === "instant") bridge.dictAudio(AudioUtils.downsample(e.data, dict.sampleRate));
      else dict.parts.push(e.data);
    };
    dict.autoStop = setTimeout(() => stopDictation(false), dict.mode === "instant" ? 10 * 60 * 1000 : MAX_DICTATION_MS);

    const buf = new Float32Array(analyser.fftSize);
    const draw = () => {
      if (!dict) { orb.style.setProperty("--lvl", 0); return; }
      dict.analyser.getFloatTimeDomainData(buf);
      let peak = 0; for (const x of buf) peak = Math.max(peak, Math.abs(x));
      orb.style.setProperty("--lvl", Math.min(1, peak * 3).toFixed(2));
      requestAnimationFrame(draw);
    };
    draw();
  })().catch((e) => flash("err", cleanErr(e))).finally(() => {
    starting = null;
    if (stopWanted) stopDictation(stopWanted === "cancel");
  });
}

async function stopDictation(cancel) {
  if (starting) { stopWanted = cancel ? "cancel" : "stop"; return; }
  if (!dict) { if (dictState === "rec") setDictState("idle"); return; }
  const d = dict; dict = null;
  clearTimeout(d.autoStop);
  d.node.port.onmessage = null;
  d.src.disconnect(); d.node.disconnect(); d.mute.disconnect();
  d.stream.getTracks().forEach((t) => t.stop());

  if (d.mode === "instant") {
    bridge.dictStop({ cancel });
    if (cancel) return setDictState("idle");
    setDictState("busy");
    clearTimeout(doneTimer);
    doneTimer = setTimeout(() => dictState === "busy" && setDictState("idle"), 5000);
    return; // chờ "dictation:done"
  }

  // chế độ AI
  bridge.dictStop({ cancel: true });
  if (cancel) return setDictState("idle");
  const seconds = (Date.now() - d.startedAt) / 1000;
  const samples = AudioUtils.concat(d.parts);
  if (seconds < 0.5 || AudioUtils.rms(samples) < 0.003) return flash("empty", "Không nghe thấy tiếng nói");
  setDictState("busy");
  try {
    const audio = await AudioUtils.toWavBase64([samples], d.sampleRate);
    const text = await bridge.dictate({ audio });
    text ? flash("ok", "Đã gõ: " + text.slice(0, 80)) : flash("empty", "Không nhận ra lời nói");
  } catch (e) {
    flash("err", cleanErr(e));
  }
}

bridge.on("dictation:done", ({ text }) => {
  clearTimeout(doneTimer);
  if (dictState !== "busy") return;
  text ? flash("ok", "Đã gõ: " + text.slice(-80)) : flash("empty", "Không nghe thấy tiếng nói");
});

function toggleDictation() {
  if (dictState === "rec") stopDictation(false);
  else if (dictState === "idle") startDictation();
}

// ---------- kéo thả + bấm ----------
let press = null;
orb.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  try { orb.setPointerCapture(e.pointerId); } catch {}
  press = { x: e.screenX, y: e.screenY, moved: false };
  bridge.bubbleDragStart();
});
orb.addEventListener("pointermove", (e) => {
  if (!press) return;
  const dx = e.screenX - press.x, dy = e.screenY - press.y;
  if (!press.moved && Math.hypot(dx, dy) < 4) return;
  if (!press.moved) { press.moved = true; setExpanded(false); }
  bridge.bubbleDragMove(dx, dy);
});
orb.addEventListener("pointerup", () => {
  if (!press) return;
  const wasDrag = press.moved; press = null;
  if (wasDrag) return bridge.bubbleDragEnd();
  if (dictState === "rec") stopDictation(false);
  else if (dictState === "idle") setExpanded(!expanded);
});
orb.addEventListener("contextmenu", (e) => { e.preventDefault(); bridge.bubbleMenu(); });

aDict.onclick = () => startDictation();
aMeet.onclick = () => { bridge.toggleMeeting(); setExpanded(false); };
aOpen.onclick = () => { bridge.showMain(); setExpanded(false); };

// ---------- tín hiệu từ main ----------
bridge.on("dictation:toggle", toggleDictation);
bridge.on("dictation:cancel", () => stopDictation(true));
bridge.on("meeting:state", (s) => { meeting = s; renderMeeting(); });
bridge.on("bubble:collapse", () => setExpanded(false));
renderMeeting();
