const { contextBridge, ipcRenderer } = require("electron");

const LISTEN = ["dictation:toggle", "dictation:cancel", "dictation:done", "meeting:state", "bubble:collapse", "caption", "meet:asr", "ptt:start", "ptt:stop", "ptt:cancel"];

contextBridge.exposeInMainWorld("api", {
  // cấu hình + AI
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (cfg) => ipcRenderer.invoke("config:set", cfg),
  transcribe: (payload) => ipcRenderer.invoke("ai:transcribe", payload),
  summarize: (payload) => ipcRenderer.invoke("ai:summarize", payload),
  dictate: (payload) => ipcRenderer.invoke("ai:dictate", payload),
  meetAsrStart: (sources) => ipcRenderer.invoke("meet:asr-start", sources),
  meetAudio: (src, samples) => ipcRenderer.send("meet:audio", src, samples),
  meetAsrStop: (sources) => ipcRenderer.send("meet:asr-stop", sources),
  dictStart: (opts) => ipcRenderer.invoke("dict:start", opts),
  dictAudio: (samples) => ipcRenderer.send("dict:audio", samples),
  dictStop: (opts) => ipcRenderer.send("dict:stop", opts),
  // cửa sổ, file
  openMeetings: () => ipcRenderer.invoke("open:meetings"),
  showFile: (file) => ipcRenderer.invoke("open:file", file),
  showMain: () => ipcRenderer.send("main:show"),
  notify: (msg) => ipcRenderer.send("notify", msg),
  // cuộc họp
  toggleMeeting: () => ipcRenderer.send("meeting:toggle"),
  meetingState: (s) => ipcRenderer.send("meeting:state", s),
  // nút nổi
  bubbleExpand: (open) => ipcRenderer.invoke("bubble:expand", open),
  bubbleDragStart: () => ipcRenderer.send("bubble:drag-start"),
  bubbleDragMove: (dx, dy) => ipcRenderer.send("bubble:drag-move", dx, dy),
  bubbleDragEnd: () => ipcRenderer.send("bubble:drag-end"),
  bubbleMenu: () => ipcRenderer.send("bubble:menu"),
  bubbleDictState: (s) => ipcRenderer.send("bubble:dict-state", s),
  on: (channel, fn) => { if (LISTEN.includes(channel)) ipcRenderer.on(channel, (_e, ...args) => fn(...args)); },
});
