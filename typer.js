// Gõ chữ Unicode (tiếng Việt có dấu) vào ô đang được chọn ở bất kỳ app nào, qua Windows SendInput.
// Dùng 1 tiến trình PowerShell chạy nền để mỗi lần gõ chỉ mất vài ms. Không đụng tới clipboard.
const { spawn } = require("child_process");

const CSHARP = `
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class UniTyper {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] p, int cb);
  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static uint Type(string s) {
    var l = new List<INPUT>();
    foreach (char c in s.Normalize(System.Text.NormalizationForm.FormC)) {
      if (c == '\\n') { l.Add(K(0x10,0,0)); l.Add(K(0x0D,0,0)); l.Add(K(0x0D,0,2)); l.Add(K(0x10,0,2)); } // Shift+Enter
      else { l.Add(K(0,c,4)); l.Add(K(0,c,6)); } // KEYEVENTF_UNICODE (+KEYUP)
    }
    return SendInput((uint)l.Count, l.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
}`;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
let ps = null;

function ensure() {
  if (ps) return ps;
  ps = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-"], { windowsHide: true });
  ps.on("exit", () => { ps = null; });
  ps.stdout.on("data", () => {}); ps.stderr.on("data", () => {});
  ps.stdin.write(`Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(CSHARP)}')))\n`);
  return ps;
}

function type(text) {
  if (!text) return;
  // chỉ gửi base64 (ký tự ASCII) qua stdin → không lỗi mã hoá, không chèn lệnh được
  ensure().stdin.write(`[void][UniTyper]::Type([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}')))\n`);
}

function stop() { ps?.stdin.end(); }

module.exports = { ensure, type, stop };
