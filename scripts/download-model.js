// Tải model nhận giọng nói tiếng Việt (sherpa-onnx, ~26 MB) vào thư mục models/ — tự chạy sau `npm install`.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const NAME = "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09";
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${NAME}.tar.bz2`;
const MODELS = path.join(__dirname, "..", "models");
const TARGET = path.join(MODELS, NAME);

(async () => {
  if (fs.existsSync(path.join(TARGET, "encoder.int8.onnx"))) return console.log("Model giọng nói đã có sẵn.");
  fs.mkdirSync(MODELS, { recursive: true });
  const archive = path.join(MODELS, `${NAME}.tar.bz2`);
  console.log("Đang tải model giọng nói tiếng Việt (~26 MB)…");
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Tải model lỗi HTTP ${res.status}`);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  // chạy trong thư mục models với tên file tương đối (tránh lỗi đường dẫn "D:\" với GNU tar)
  execFileSync("tar", ["-xjf", path.basename(archive)], { cwd: MODELS, stdio: "inherit" });
  fs.rmSync(archive);
  console.log("Đã tải xong model giọng nói.");
})().catch((e) => {
  console.error("Không tải được model giọng nói:", e.message);
  console.error("Tải thủ công:", URL, "→ giải nén vào thư mục models/");
});
