# Tóm tắt cuộc họp

App trên máy Windows: ghi âm cuộc họp **Google Meet** hoặc **cuộc gọi** (Zalo, Messenger, Teams…), chép lời nói theo thời gian thực và tự viết biên bản tóm tắt bằng AI Gemini.

## Cài đặt

Cần [Node.js](https://nodejs.org) 20+ trên Windows 10/11.

```
git clone <địa chỉ repo này>
cd <thư mục repo>
npm install
npm start
```

`npm install` tự tải model nhận giọng nói tiếng Việt (~26 MB) vào `models/`. Hoặc bấm đúp `Chạy app.bat`.

## Cách dùng

1. **Mở 9router** (chạy ở `http://localhost:20128`) trước khi họp.
2. Bấm đúp icon **Tóm tắt cuộc họp** ngoài Desktop (hoặc `Chạy app.bat`).
3. Lần đầu: **⚙ Cài đặt** → chọn *9router* → dán key `sk-…` → model `ag/gemini-3.8-flash` → **Lưu**.
   (Chỉ dùng model `ag/gemini-…`; model Claude/GPT không nghe được âm thanh.
   Có thể chuyển sang *Google Gemini API* nếu có key `AIza…` từ aistudio.google.com.)
4. Vào cuộc họp/cuộc gọi như bình thường, rồi bấm **● Bắt đầu ghi**.
   - App thu **âm thanh phát ra từ máy** (tiếng mọi người) và **micro của bạn** thành 2 luồng riêng:
     lời từ micro ghi là **Tôi**, lời từ loa ghi là **Người khác**. Nếu micro thu lại tiếng loa (không đeo tai nghe), câu trùng tự bị lọc bỏ.
   - Họp trực tiếp / lớp học: chỉ bật micro, bỏ "âm thanh máy".
   - **Chép lời**: *Tức thì* (mặc định) — lời nói hiện ngay trong lúc họp, chạy offline, miễn phí;
     *AI* — gửi Gemini mỗi 20–60 giây, chính xác hơn nhưng chậm và tốn lượt gọi.
5. Chọn **loại buổi** ở khung Tóm tắt, mỗi loại có bộ mục riêng:
   - 📋 Họp chung: người tham gia, điểm chính, quyết định, vấn đề còn mở, việc cần làm
   - 🚀 Họp dự án: tiến độ, vướng mắc & rủi ro, quyết định, kế hoạch tiếp theo
   - 🎓 Buổi học / bài giảng: ý chính, khái niệm & định nghĩa, ví dụ, chỗ dễ nhầm, câu hỏi ôn tập kèm đáp án, bài tập
   - 🤝 Phỏng vấn: thông tin ứng viên, kỹ năng, điểm mạnh, điểm cần lưu ý, đánh giá
   - 💼 Gặp khách hàng: nhu cầu, phản hồi, con số quan trọng, đã thống nhất, việc tiếp theo
6. Bấm **■ Dừng & tóm tắt** → bản tóm tắt hiện ra. Đổi loại buổi rồi bấm **Tóm tắt** để tóm tắt lại theo mẫu khác.

Biên bản được lưu dạng `.md` trong `Documents\Bien ban hop` (bấm **📁 Biên bản đã lưu** để mở).

## Nút nổi & gõ bằng giọng nói

Khi app chạy, một **nút tròn xanh** luôn nổi trên màn hình (kéo để di chuyển).

- **Bấm nút** → hiện menu nhỏ: 🎤 gõ bằng giọng nói · ⏺ ghi/dừng cuộc họp · ▭ mở cửa sổ biên bản.
- **Gõ bằng giọng nói**: đặt con trỏ vào ô nhập chữ bất kỳ (Word, Zalo, Chrome…), nhấn **Ctrl+Shift+Space** (hoặc 🎤) rồi nói.
  - Chữ hiện **ngay lập tức** trong khung phụ đề cạnh nút; mỗi khi bạn ngừng ~0,5 giây, câu đó được gõ thẳng vào ô.
  - Nhấn lại phím tắt (hoặc bấm nút đỏ) để dừng, **Esc** để huỷ.
  - Đọc dấu: "dấu phẩy", "dấu chấm", "dấu chấm hỏi", "dấu chấm than", "xuống dòng" (= Shift+Enter, không gửi tin nhắn).
  - Chạy **offline** bằng model tiếng Việt trên máy (thư mục `models/`), không cần mạng, không tốn API.
  - Muốn có dấu câu tự động: chuột phải nút → *Kiểu gõ giọng nói* → *Chính xác hơn — AI* (chậm 3–5 giây, cần 9router).
- Nút đổi màu: 🔴 đang nghe · ⏳ đang chuyển thành chữ · ✅ đã gõ · 🟠 lỗi (rê chuột vào để xem). Chấm đỏ nhỏ = đang ghi cuộc họp.
- **Chuột phải** vào nút (hoặc icon ở khay hệ thống góc phải dưới): ẩn/hiện nút, **Khởi động cùng Windows**, Thoát.
- Đóng cửa sổ chính thì app vẫn chạy nền ở khay hệ thống; muốn tắt hẳn chọn **Thoát**.

## Mẹo

- Dùng **tai nghe** để giọng người khác không lọt vào micro, transcript sẽ sạch hơn.
- Có transcript sẵn (từ Meet/Zoom)? Dán vào khung Transcript rồi bấm **Tóm tắt**.
- Sửa transcript tay trước khi tóm tắt nếu AI nghe nhầm tên.
- Những đoạn im lặng không gửi đi, nên không tốn lượt gọi API.

## Lưu ý

- Âm thanh cuộc họp được gửi tới Google Gemini để chép và tóm tắt. Hãy xin phép mọi người trước khi ghi âm.
- API key chỉ lưu trên máy bạn (`%APPDATA%\Tóm tắt cuộc họp\config.json`).

## Đóng gói thành file .exe (tuỳ chọn)

```
npm run build
```
File chạy độc lập nằm trong thư mục `dist/`.
