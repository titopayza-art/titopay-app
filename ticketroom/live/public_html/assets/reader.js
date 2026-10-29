// Shared input readers for the scanner and POS: camera QR (BarcodeDetector
// or jsQR fallback) and Web NFC (Android Chrome). Each calls onRead(value).

export function nfcSupported() { return "NDEFReader" in window; }

// Reads an NDEF text record (TicketRoom token) or falls back to the chip UID.
export async function readNfc(onRead, signal) {
  const reader = new window.NDEFReader();
  await reader.scan({ signal });
  reader.onreading = (ev) => {
    for (const rec of ev.message.records) {
      if (rec.recordType === "text" || rec.recordType === "url") {
        const text = new TextDecoder(rec.encoding || "utf-8").decode(rec.data);
        const m = text.match(/TRT1\.[A-Za-z0-9_-]{16,64}/);
        if (m) return onRead(m[0]);
      }
    }
    if (ev.serialNumber) onRead(`UID:${ev.serialNumber.replace(/:/g, "").toUpperCase()}`);
  };
}

export class Camera {
  constructor(container, onRead) { this.container = container; this.onRead = onRead; this.running = false; this.last = { v: null, t: 0 }; }
  async start() {
    if (this.running) return;
    const video = document.createElement("video");
    video.setAttribute("playsinline", ""); video.muted = true;
    this.container.replaceChildren(video, Object.assign(document.createElement("div"), { className: "frame" }));
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = this.stream; await video.play();
    this.video = video; this.running = true;
    this.detector = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
    this.canvas = document.createElement("canvas");
    this.loop();
  }
  async loop() {
    if (!this.running) return;
    try {
      let value = null;
      if (this.detector) { const codes = await this.detector.detect(this.video); value = codes[0]?.rawValue || null; }
      else if (window.jsQR && this.video.videoWidth) {
        const w = 480, h = Math.round((this.video.videoHeight / this.video.videoWidth) * 480);
        this.canvas.width = w; this.canvas.height = h;
        const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(this.video, 0, 0, w, h);
        value = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })?.data || null;
      }
      // Ignore the same code for 3 seconds so one ticket is not submitted repeatedly.
      if (value && (value !== this.last.v || Date.now() - this.last.t > 3000)) { this.last = { v: value, t: Date.now() }; this.onRead(value); }
    } catch { /* frame not ready */ }
    setTimeout(() => this.loop(), 180);
  }
  stop() { this.running = false; this.stream?.getTracks().forEach((t) => t.stop()); this.container.replaceChildren(); }
}

export function beep(ok) {
  try { navigator.vibrate?.(ok ? 80 : [120, 60, 120]); } catch { /* ignore */ }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220; o.connect(g); g.connect(ctx.destination); g.gain.value = 0.08;
    o.start(); o.stop(ctx.currentTime + (ok ? 0.12 : 0.35));
  } catch { /* audio blocked */ }
}
