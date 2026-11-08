// Dùng chung cho cửa sổ chính và nút nổi: chuyển âm thanh thành WAV 16 kHz để gửi AI.
window.AudioUtils = (() => {
  const TARGET_RATE = 16000;

  function downsample(data, fromRate) {
    if (fromRate === TARGET_RATE) return data;
    const ratio = fromRate / TARGET_RATE, len = Math.floor(data.length / ratio), out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const s = Math.floor(i * ratio), e = Math.min(Math.floor((i + 1) * ratio), data.length);
      let sum = 0; for (let j = s; j < e; j++) sum += data[j];
      out[i] = sum / Math.max(1, e - s);
    }
    return out;
  }

  function encodeWav(samples, rate = TARGET_RATE) {
    const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data");
    v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type: "audio/wav" });
  }

  const blobToBase64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob);
  });

  function concat(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0), all = new Float32Array(total);
    let pos = 0; for (const p of parts) { all.set(p, pos); pos += p.length; }
    return all;
  }

  function rms(data) {
    let sq = 0; for (let i = 0; i < data.length; i++) sq += data[i] * data[i];
    return data.length ? Math.sqrt(sq / data.length) : 0;
  }

  // Gói các mẫu float thành chuỗi base64 WAV 16 kHz
  async function toWavBase64(parts, sampleRate) {
    return blobToBase64(encodeWav(downsample(concat(parts), sampleRate)));
  }

  return { TARGET_RATE, downsample, encodeWav, blobToBase64, concat, rms, toWavBase64 };
})();
