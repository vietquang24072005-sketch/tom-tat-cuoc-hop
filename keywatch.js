// Theo dõi việc GIỮ phím Shift (toàn hệ thống) để bật "giữ để nói".
// Chỉ kích hoạt khi Shift được giữ MỘT MÌNH đủ lâu — gõ chữ hoa (Shift+A) hay Shift+click không bị ảnh hưởng.
// Phát sự kiện: "start" (đã giữ đủ lâu) · "stop" (thả Shift) · "cancel" (đang nói mà bấm thêm phím khác)
const { spawn } = require("child_process");
const { EventEmitter } = require("events");

const CSHARP = `
using System; using System.Runtime.InteropServices; using System.Diagnostics; using System.Threading;
public static class KeyWatch {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  // đang nhấn HOẶC vừa được bấm kể từ lần kiểm tra trước (bắt cả lần bấm rất nhanh)
  static bool Hit(int vk) { return (GetAsyncKeyState(vk) & 0x8001) != 0; }
  // which: 1 = Shift trái, 2 = Shift phải, 3 = cả hai
  public static void Run(int which, int holdMs) {
    bool held = false, dirty = false, started = false, armed = false; var sw = new Stopwatch();
    bool[] baseline = new bool[256];
    while (true) {
      bool l = Down(0xA0), r = Down(0xA1);
      bool target = which == 1 ? l : which == 2 ? r : (l || r);
      bool otherShift = which == 1 ? r : which == 2 ? l : false;
      if (!armed) { if (!target) armed = true; Thread.Sleep(12); continue; } // Shift đang kẹt sẵn → chờ thả ra trước
      if (target) {
        if (!held) {
          held = true; dirty = false; started = false; sw.Restart();
          // ghi nhận các phím đang (bị kẹt) nhấn sẵn để bỏ qua; chỉ tính phím mới bấm trong lúc giữ Shift
          for (int vk = 1; vk <= 0xFE; vk++) baseline[vk] = Down(vk);
          dirty = otherShift || Down(0x01) || Down(0x02);
        }
        if (!dirty) {
          if (otherShift) dirty = true;
          else for (int vk = 1; vk <= 0xFE; vk++) {
            if (vk == 0x10 || vk == 0xA0 || vk == 0xA1 || vk == 0xE7) continue; // Shift, VK_PACKET (chữ app tự gõ)
            short st = GetAsyncKeyState(vk);
            bool d = (st & 0x8000) != 0;
            if ((st & 0x8001) != 0 && !(d && baseline[vk])) { dirty = true; break; }
            if (!d) baseline[vk] = false; // phím kẹt đã nhả → lần sau bấm lại sẽ được tính
          }
          if (dirty && started) { Console.WriteLine("C"); started = false; }
        }
        if (!dirty && !started && sw.ElapsedMilliseconds >= holdMs) { started = true; Console.WriteLine("S"); }
      } else if (held) {
        held = false;
        if (started) { Console.WriteLine("E"); started = false; }
      }
      Thread.Sleep(12);
    }
  }
}`;

const KEYS = { left: 1, right: 2, both: 3 };
const HOLD_MS = 250;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

class KeyWatcher extends EventEmitter {
  constructor() { super(); this.ps = null; this.key = "off"; this.stopping = false; }

  setKey(key) {
    this.key = KEYS[key] ? key : "off";
    this.kill();
    if (this.key !== "off") this.spawn();
  }

  spawn() {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-"], { windowsHide: true });
    this.ps = ps;
    let buf = "";
    ps.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line === "S") this.emit("start");
        else if (line === "E") this.emit("stop");
        else if (line === "C") this.emit("cancel");
      }
    });
    ps.stderr.on("data", () => {});
    ps.on("exit", () => {
      if (this.ps !== ps) return;
      this.ps = null;
      if (!this.stopping && this.key !== "off") setTimeout(() => !this.ps && this.spawn(), 2000); // tự chạy lại nếu bị tắt
    });
    ps.stdin.write(`Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(CSHARP)}')))\n`);
    ps.stdin.write(`[KeyWatch]::Run(${KEYS[this.key]}, ${HOLD_MS})\n`);
  }

  kill() { const ps = this.ps; this.ps = null; ps?.kill(); }
  stop() { this.stopping = true; this.kill(); }
}

module.exports = new KeyWatcher();
