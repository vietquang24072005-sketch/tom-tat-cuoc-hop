// Khung phụ đề: hiện chữ ngay khi đang nói (chữ trắng = đang nghe, chữ mờ = đã gõ vào ô)
const textEl = document.getElementById("text");
const label = document.getElementById("label");

window.api.on("caption", ({ committed = "", partial = "", status = "listening" }) => {
  label.textContent = status === "finishing" ? "Đang hoàn tất…" : status === "ai" ? "Đang nghe (chế độ AI, chữ sẽ gõ khi bạn dừng)…" : "Đang nghe… · bấm lại nút hoặc Ctrl+Shift+Space để dừng · Esc huỷ";
  textEl.textContent = "";
  if (!committed && !partial) {
    const h = document.createElement("span"); h.className = "hint"; h.textContent = "Hãy nói…"; textEl.append(h);
    return;
  }
  const tail = committed.length > 160 ? "…" + committed.slice(-160) : committed;
  if (tail) { const d = document.createElement("span"); d.className = "done"; d.textContent = tail + (partial ? " " : ""); textEl.append(d); }
  const l = document.createElement("span"); l.className = "live"; l.textContent = partial; textEl.append(l);
});
