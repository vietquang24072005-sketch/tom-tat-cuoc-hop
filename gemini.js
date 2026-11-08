// Gọi AI: 2 chế độ
//  - "9router": router chạy trên máy (OpenAI-compatible, vd http://localhost:20128/v1) → dùng model Antigravity/Gemini
//  - "gemini":  gọi thẳng Google Gemini API bằng key AIza…

// Đọc phản hồi OpenAI-compatible, kể cả khi router trả về dạng stream (SSE)
function parseOpenAIResponse(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const j = JSON.parse(trimmed);
    if (j.error) throw new Error(j.error.message || "Router báo lỗi");
    return j.choices?.[0]?.message?.content || "";
  }
  let out = "";
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      if (j.error) throw new Error(j.error.message || "Router báo lỗi");
      out += j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || "";
    } catch (e) { if (e.message && !(e instanceof SyntaxError)) throw e; }
  }
  return out;
}

async function callRouter({ apiKey, model, baseUrl }, { text, audio }, { temperature = 0.2 } = {}) {
  if (!apiKey) throw new Error("Chưa nhập API key của 9router (bấm ⚙ Cài đặt)");
  const content = [{ type: "text", text }];
  if (audio) content.push({ type: "input_audio", input_audio: { data: audio, format: "wav" } });
  let res;
  try {
    res = await fetch(`${(baseUrl || "http://localhost:20128/v1").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature, stream: true, messages: [{ role: "user", content }] }),
    });
  } catch {
    throw new Error("Không kết nối được 9router — hãy mở 9router trước rồi thử lại");
  }
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 300);
    try { msg = JSON.parse(raw).error?.message || msg; } catch {}
    throw new Error(`9router lỗi ${res.status}: ${msg}`);
  }
  return parseOpenAIResponse(raw).trim();
}

async function callAI(cfg, { text, audio }, opts = {}) {
  if (cfg.provider === "gemini") {
    const parts = audio ? [{ inline_data: { mime_type: "audio/wav", data: audio } }, { text }] : [{ text }];
    return callGemini(cfg, parts, opts);
  }
  return callRouter(cfg, { text, audio }, opts);
}

async function callGemini({ apiKey, model }, parts, { json = false, temperature = 0.2 } = {}) {
  if (!apiKey) throw new Error("Chưa nhập Gemini API key (bấm ⚙ Cài đặt)");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}) },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini lỗi HTTP ${res.status}`);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

const TRANSCRIBE_PROMPT = (prev) => `Bạn là trợ lý ghi biên bản cuộc họp. Hãy chép lại CHÍNH XÁC lời nói trong đoạn âm thanh này.
Quy tắc:
- Giữ nguyên ngôn ngữ người nói (thường là tiếng Việt, có thể xen tiếng Anh). Viết có dấu, có dấu câu.
- Nếu phân biệt được nhiều người nói, xuống dòng mỗi lượt và ghi nhãn "Người 1:", "Người 2:"... (nếu nghe được tên thì dùng tên).
- Bỏ tiếng ậm ừ vô nghĩa. Không tóm tắt, không bình luận, không thêm nội dung không có trong âm thanh.
- Nếu không có lời nói rõ ràng, trả về chính xác: [im lặng]
${prev ? `\nĐoạn transcript ngay trước đó (chỉ để giữ nhất quán tên người nói, KHÔNG chép lại):\n"""${prev}"""` : ""}`;

const SUMMARY_PROMPT = (title, transcript) => `Bạn là thư ký cuộc họp chuyên nghiệp. Dựa trên transcript dưới đây, hãy viết biên bản tóm tắt bằng tiếng Việt.
Tên cuộc họp (nếu có): ${title || "(không có)"}

Trả về JSON đúng cấu trúc:
{
  "tieu_de": "tiêu đề ngắn gọn cho cuộc họp",
  "tong_quan": "2-4 câu tóm tắt mục đích và kết quả chính",
  "nguoi_tham_gia": ["tên hoặc nhãn người nói"],
  "diem_chinh": ["các ý/chủ đề chính đã thảo luận, mỗi ý 1 câu đầy đủ"],
  "quyet_dinh": ["các quyết định đã chốt"],
  "viec_can_lam": [{"viec": "mô tả công việc", "nguoi_phu_trach": "tên hoặc 'Chưa rõ'", "han": "thời hạn hoặc 'Chưa rõ'"}],
  "van_de_mo": ["câu hỏi/vấn đề còn bỏ ngỏ, cần theo dõi"]
}
Chỉ dùng thông tin có trong transcript; mảng nào không có thì để []. Không bịa thêm.

TRANSCRIPT:
"""
${transcript}
"""`;

async function transcribe(cfg, { audio, previous = "" }) {
  const text = await callAI(cfg, { text: TRANSCRIBE_PROMPT(previous.slice(-600)), audio }, { temperature: 0 });
  return /^\[?im lặng\]?\.?$/i.test(text) ? "" : text;
}

const DICTATE_PROMPT = `Chép lại lời nói trong đoạn âm thanh thành văn bản để dán thẳng vào ô soạn thảo.
- Giữ nguyên ngôn ngữ người nói (thường là tiếng Việt, có thể xen tiếng Anh). Viết có dấu, đúng chính tả, thêm dấu câu và viết hoa hợp lý.
- Bỏ tiếng ậm ừ, từ lặp; nếu người nói tự sửa lại câu thì chỉ giữ ý sau cùng.
- Nếu người nói đọc lệnh "xuống dòng" thì xuống dòng thay vì viết chữ đó.
- Chỉ trả về đúng văn bản, không ngoặc kép, không giải thích, không nhãn người nói.
- Nếu không có lời nói rõ ràng, trả về chính xác: [im lặng]`;

async function dictate(cfg, { audio }) {
  const text = await callAI(cfg, { text: DICTATE_PROMPT, audio }, { temperature: 0 });
  return /^\[?im lặng\]?\.?$/i.test(text) ? "" : text.replace(/^["“]|["”]$/g, "").trim();
}

async function summarize(cfg, { title, transcript }) {
  const raw = await callAI(cfg, { text: SUMMARY_PROMPT(title, transcript) + "\n\nChỉ trả về JSON, không kèm giải thích." }, { json: true, temperature: 0.3 });
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch { throw new Error("AI trả về định dạng không hợp lệ, hãy bấm Tóm tắt lại"); }
}

function toMarkdown(s, transcript) {
  const list = (arr) => (arr?.length ? arr.map((x) => `- ${x}`).join("\n") : "_Không có_");
  const tasks = s.viec_can_lam?.length
    ? "| Việc cần làm | Phụ trách | Hạn |\n|---|---|---|\n" + s.viec_can_lam.map((t) => `| ${t.viec} | ${t.nguoi_phu_trach} | ${t.han} |`).join("\n")
    : "_Không có_";
  return `# ${s.tieu_de || "Biên bản cuộc họp"}

_Ngày: ${new Date().toLocaleString("vi-VN")}_

## Tổng quan
${s.tong_quan || ""}

## Người tham gia
${list(s.nguoi_tham_gia)}

## Điểm chính
${list(s.diem_chinh)}

## Quyết định
${list(s.quyet_dinh)}

## Việc cần làm
${tasks}

## Vấn đề còn mở
${list(s.van_de_mo)}

---

## Transcript đầy đủ
${transcript}
`;
}

module.exports = { transcribe, summarize, dictate, toMarkdown };
