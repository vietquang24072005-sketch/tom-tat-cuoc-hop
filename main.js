const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, screen, Tray, Menu, globalShortcut, Notification, nativeImage, utilityProcess } = require("electron");
const path = require("path");
const fs = require("fs");
const gemini = require("./gemini");
const typer = require("./typer");

const HOTKEY = "Control+Shift+Space";
const ORB = 60, OPEN_W = 196; // kích thước nút nổi (thu gọn / mở menu)
const ICON = path.join(__dirname, "assets", "icon.png");
const CONFIG_FILE = () => path.join(app.getPath("userData"), "config.json");
const MEETINGS_DIR = () => path.join(app.getPath("documents"), "Bien ban hop");
const DEFAULTS = { provider: "9router", baseUrl: "http://localhost:20128/v1", apiKey: "", model: "ag/gemini-3.8-flash", bubble: null, showBubble: true, dictationMode: "instant" };

let mainWin = null, bubble = null, tray = null, caption = null;
let quitting = false;
let meeting = { recording: false, busy: false, elapsed: 0 };
let orbPos = null, dragStart = null;

// ---------- cấu hình ----------
function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE(), "utf8")) }; }
  catch { return { ...DEFAULTS }; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2), "utf8");
}
function patchConfig(patch) { const c = { ...loadConfig(), ...patch }; saveConfig(c); return c; }

function saveMeeting(summary, transcript) {
  fs.mkdirSync(MEETINGS_DIR(), { recursive: true });
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  const slug = (summary.tieu_de || "cuoc-hop").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50).toLowerCase() || "cuoc-hop";
  const file = path.join(MEETINGS_DIR(), `${stamp}_${slug}.md`);
  const markdown = gemini.toMarkdown(summary, transcript);
  fs.writeFileSync(file, markdown, "utf8");
  return { file, markdown };
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: "Tóm tắt cuộc họp", body, icon: ICON }).show();
}

// ---------- gõ bằng giọng nói tức thì (model tiếng Việt offline chạy ở tiến trình riêng) ----------
const unpacked = (p) => p.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
let asr = null, asrError = "";
let dictSess = null; // { typed, capNext }

function startAsr() {
  asr = utilityProcess.fork(unpacked(path.join(__dirname, "asr-worker.js")), [], {
    serviceName: "asr", stdio: "ignore",
    env: { ...process.env, ASR_MODEL_DIR: unpacked(path.join(__dirname, "models")) },
  });
  asr.on("message", onAsrMessage);
  asr.on("exit", () => { asr = null; if (!quitting) setTimeout(startAsr, 1000); });
}

// Viết thường, viết hoa đầu câu, đổi lệnh đọc dấu câu ("dấu phẩy", "xuống dòng"…) thành ký tự
function formatPhrase(raw, sess) {
  const cmd = (words) => new RegExp(`(^|\\s)${words}(?=\\s|$)`, "g");
  const t = raw.toLocaleLowerCase("vi").replace(/\s+/g, " ").trim()
    .replace(cmd("dấu chấm hỏi"), "?").replace(cmd("dấu chấm than"), "!")
    .replace(cmd("dấu chấm"), ".").replace(cmd("dấu phẩy"), ",")
    .replace(cmd("xuống dòng"), "\n").replace(/ ?\n ?/g, "\n").trim();
  if (!t) return "";
  const glue = !sess.typed || sess.typed.endsWith("\n") || /^[.,?!\n]/.test(t) ? "" : " ";
  let cap = sess.capNext, out = "";
  for (const ch of glue + t) {
    if (cap && /\p{L}/u.test(ch)) { out += ch.toLocaleUpperCase("vi"); cap = false; }
    else out += ch;
    if (/[.?!\n]/.test(ch)) cap = true;
  }
  sess.capNext = cap;
  return out;
}

function onAsrMessage(m) {
  if (m.type === "ready") { asrError = ""; return; }
  if (m.type === "error") { asrError = m.message; notify(m.message); return; }
  if (!dictSess) return;
  if (m.type === "partial") sendCaption({ partial: m.text.toLocaleLowerCase("vi") });
  else if (m.type === "final") {
    const out = formatPhrase(m.text, dictSess);
    if (out) { typer.type(out); dictSess.typed += out; }
    sendCaption({ partial: "" });
  } else if (m.type === "done") {
    const typed = dictSess.typed; dictSess = null;
    bubble.webContents.send("dictation:done", { text: typed });
    setTimeout(() => { if (!dictSess) caption?.hide(); }, typed ? 900 : 300);
  }
}

// ---------- khung phụ đề cạnh nút nổi ----------
const CAP_W = 460, CAP_H = 92;
function createCaption() {
  caption = new BrowserWindow({
    width: CAP_W, height: CAP_H, frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  caption.setAlwaysOnTop(true, "screen-saver");
  caption.setIgnoreMouseEvents(true);
  caption.loadFile(path.join(__dirname, "renderer", "caption.html"));
  caption.on("close", (e) => { if (!quitting) e.preventDefault(); });
}
function showCaption() {
  const wa = screen.getDisplayNearestPoint({ x: orbPos.x + ORB / 2, y: orbPos.y + ORB / 2 }).workArea;
  const onRight = orbPos.x + ORB / 2 > wa.x + wa.width / 2;
  let x = onRight ? orbPos.x + ORB - CAP_W : orbPos.x;
  let y = orbPos.y - CAP_H;
  if (y < wa.y) y = orbPos.y + ORB;
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - CAP_W);
  caption.setBounds({ x: Math.round(x), y: Math.round(y), width: CAP_W, height: CAP_H });
  caption.showInactive();
}
function sendCaption({ partial = "", status = "listening" }) {
  caption?.webContents.send("caption", { committed: dictSess?.typed || "", partial, status });
}

// ---------- cửa sổ chính ----------
function createMainWindow(show) {
  mainWin = new BrowserWindow({
    width: 1200, height: 800, minWidth: 820, minHeight: 560, show,
    title: "Tóm tắt cuộc họp", icon: ICON, autoHideMenuBar: true, backgroundColor: "#f6f7f9",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  mainWin.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWin.on("close", (e) => { if (!quitting) { e.preventDefault(); mainWin.hide(); } });
}
function showMain() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show(); mainWin.focus();
}

// ---------- nút nổi ----------
function defaultOrbPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - ORB - 24, y: wa.y + wa.height - ORB - 120 };
}
function clampOrb(p) {
  const wa = screen.getDisplayNearestPoint({ x: Math.round(p.x + ORB / 2), y: Math.round(p.y + ORB / 2) }).workArea;
  return { x: Math.min(Math.max(p.x, wa.x), wa.x + wa.width - ORB), y: Math.min(Math.max(p.y, wa.y), wa.y + wa.height - ORB) };
}
function placeBubble(expanded) {
  const wa = screen.getDisplayNearestPoint({ x: orbPos.x + ORB / 2, y: orbPos.y + ORB / 2 }).workArea;
  const dir = orbPos.x + OPEN_W > wa.x + wa.width ? "left" : "right";
  const width = expanded ? OPEN_W : ORB;
  const x = expanded && dir === "left" ? orbPos.x - (OPEN_W - ORB) : orbPos.x;
  bubble.setBounds({ x: Math.round(x), y: Math.round(orbPos.y), width, height: ORB });
  return dir;
}
function createBubble() {
  const cfg = loadConfig();
  orbPos = clampOrb(cfg.bubble || defaultOrbPos());
  bubble = new BrowserWindow({
    x: orbPos.x, y: orbPos.y, width: ORB, height: ORB,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  bubble.setAlwaysOnTop(true, "screen-saver");
  bubble.loadFile(path.join(__dirname, "renderer", "bubble.html"));
  bubble.once("ready-to-show", () => { if (loadConfig().showBubble !== false) bubble.showInactive(); });
  bubble.on("close", (e) => { if (!quitting) e.preventDefault(); });
}
function setBubbleVisible(v) {
  patchConfig({ showBubble: v });
  if (v) bubble.showInactive(); else bubble.hide();
  refreshTray();
}

// ---------- menu chung (chuột phải nút nổi + khay hệ thống) ----------
function loginItemArgs() { return app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"]; }
function buildMenu() {
  const openAtLogin = app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs() }).openAtLogin;
  return Menu.buildFromTemplate([
    { label: "Gõ bằng giọng nói\t(Ctrl+Shift+Space)", click: () => bubble.webContents.send("dictation:toggle") },
    { label: "Kiểu gõ giọng nói", submenu: [
      { label: "Tức thì — chữ hiện ngay khi nói (offline)", type: "radio", checked: loadConfig().dictationMode !== "ai", click: () => patchConfig({ dictationMode: "instant" }) },
      { label: "Chính xác hơn, có dấu câu — AI (chậm 3–5 giây)", type: "radio", checked: loadConfig().dictationMode === "ai", click: () => patchConfig({ dictationMode: "ai" }) },
    ] },
    { label: meeting.recording ? "Dừng ghi cuộc họp & tóm tắt" : "Ghi cuộc họp", enabled: !(meeting.busy && !meeting.recording), click: toggleMeeting },
    { label: "Mở cửa sổ biên bản", click: showMain },
    { type: "separator" },
    { label: "Hiện nút nổi", type: "checkbox", checked: bubble.isVisible(), click: (i) => setBubbleVisible(i.checked) },
    { label: "Khởi động cùng Windows", type: "checkbox", checked: openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, path: process.execPath, args: loginItemArgs() }) },
    { type: "separator" },
    { label: "Thoát", click: () => { quitting = true; app.quit(); } },
  ]);
}
function refreshTray() {
  if (!tray) return;
  tray.setToolTip(meeting.recording ? `Đang ghi cuộc họp · ${Math.floor(meeting.elapsed / 60)} phút` : "Tóm tắt cuộc họp");
  tray.setContextMenu(buildMenu());
}

// ---------- cuộc họp (chạy trong cửa sổ chính, kể cả khi đang ẩn) ----------
function toggleMeeting() {
  if (!loadConfig().apiKey) return showMain();
  mainWin.webContents.executeJavaScript("window.__toggleMeeting && window.__toggleMeeting()", true);
}

// ---------- khởi động ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMain());

  app.whenReady().then(() => {
    // getDisplayMedia → tự cấp âm thanh hệ thống (loopback) để thu tiếng Meet/Zalo/Teams…
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      callback({ video: sources[0], audio: "loopback" });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(["media", "display-capture"].includes(permission)));

    // cấu hình + AI
    const publicCfg = (c) => ({ provider: c.provider, baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKey, meetingsDir: MEETINGS_DIR() });
    ipcMain.handle("config:get", () => publicCfg(loadConfig()));
    ipcMain.handle("config:set", (_e, { provider, baseUrl, apiKey, model }) => {
      const c = loadConfig();
      if (provider && provider !== c.provider) c.apiKey = ""; // đổi nhà cung cấp thì key cũ không dùng được
      if (provider) c.provider = provider;
      if (baseUrl) c.baseUrl = baseUrl.trim();
      if (apiKey) c.apiKey = apiKey.trim();
      if (model) c.model = model.trim();
      saveConfig(c);
      return publicCfg(c);
    });
    ipcMain.handle("ai:transcribe", (_e, payload) => gemini.transcribe(loadConfig(), payload));
    ipcMain.handle("ai:summarize", async (_e, { title, transcript }) => {
      const summary = await gemini.summarize(loadConfig(), { title, transcript });
      return { summary, ...saveMeeting(summary, transcript) };
    });
    ipcMain.handle("ai:dictate", async (_e, { audio }) => {
      const cfg = loadConfig();
      if (!cfg.apiKey) { showMain(); throw new Error("Chưa có API key — mở Cài đặt trong cửa sổ chính"); }
      const text = await gemini.dictate(cfg, { audio });
      if (text) typer.type(text);
      setTimeout(() => caption?.hide(), 300);
      return text;
    });

    // cửa sổ, file
    ipcMain.handle("open:meetings", () => { fs.mkdirSync(MEETINGS_DIR(), { recursive: true }); return shell.openPath(MEETINGS_DIR()); });
    ipcMain.handle("open:file", (_e, file) => shell.showItemInFolder(file));
    ipcMain.on("main:show", showMain);
    ipcMain.on("notify", (_e, msg) => notify(msg));

    // cuộc họp
    ipcMain.on("meeting:toggle", toggleMeeting);
    ipcMain.on("meeting:state", (_e, s) => {
      const justStopped = meeting.recording && !s.recording;
      meeting = s;
      bubble?.webContents.send("meeting:state", s);
      if (justStopped) showMain();
      refreshTray();
    });

    // nút nổi
    ipcMain.handle("bubble:expand", (_e, open) => ({ dir: placeBubble(open) }));
    ipcMain.on("bubble:drag-start", () => { dragStart = { ...orbPos }; });
    ipcMain.on("bubble:drag-move", (_e, dx, dy) => {
      if (!dragStart) return;
      orbPos = { x: dragStart.x + dx, y: dragStart.y + dy };
      placeBubble(false);
    });
    ipcMain.on("bubble:drag-end", () => {
      dragStart = null;
      orbPos = clampOrb(orbPos); placeBubble(false);
      patchConfig({ bubble: orbPos });
    });
    ipcMain.on("bubble:menu", () => buildMenu().popup());

    // gõ bằng giọng nói
    ipcMain.handle("dict:start", () => {
      const mode = loadConfig().dictationMode === "ai" ? "ai" : "instant";
      if (mode === "instant" && (!asr || asrError)) {
        notify(asrError || "Bộ nhận giọng nói đang khởi động, thử lại sau vài giây");
        return { mode: "none" };
      }
      dictSess = mode === "instant" ? { typed: "", capNext: true } : null;
      if (mode === "instant") asr.postMessage({ type: "start" });
      showCaption();
      caption.webContents.send("caption", { committed: "", partial: "", status: mode === "ai" ? "ai" : "listening" });
      return { mode };
    });
    ipcMain.on("dict:audio", (_e, samples) => { if (dictSess && asr) asr.postMessage({ type: "audio", samples }); });
    ipcMain.on("dict:stop", (_e, { cancel } = {}) => {
      if (!dictSess) { if (cancel) caption?.hide(); return; }
      if (cancel) { dictSess = null; asr?.postMessage({ type: "stop" }); caption?.hide(); return; }
      sendCaption({ status: "finishing" });
      asr?.postMessage({ type: "stop" });
    });
    ipcMain.on("bubble:dict-state", (_e, s) => {
      // Esc huỷ chỉ đăng ký trong lúc đang nghe, để không chiếm phím Esc của app khác
      if (s === "rec") globalShortcut.register("Escape", () => bubble.webContents.send("dictation:cancel"));
      else if (globalShortcut.isRegistered("Escape")) globalShortcut.unregister("Escape");
    });

    const startHidden = process.argv.includes("--hidden");
    createMainWindow(!startHidden);
    createBubble();

    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.on("click", showMain);
    refreshTray();

    if (!globalShortcut.register(HOTKEY, () => bubble.webContents.send("dictation:toggle"))) {
      notify(`Phím tắt ${HOTKEY} đang bị app khác dùng. Bạn vẫn có thể bấm nút nổi để gõ bằng giọng nói.`);
    }
    typer.ensure(); // khởi động sẵn để lần gõ đầu tiên không bị chậm
    startAsr();
    createCaption();

    screen.on("display-removed", () => { orbPos = clampOrb(orbPos); placeBubble(false); });
  });

  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => { globalShortcut.unregisterAll(); typer.stop(); asr?.kill(); });
  app.on("window-all-closed", () => {}); // chạy nền ở khay hệ thống
}
