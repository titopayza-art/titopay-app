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

// ---- hardware readers ------------------------------------------------------
// Rugged handhelds (their built-in barcode, NFC or RFID reader), and USB or
// Bluetooth readers, type what they read like a keyboard, ending with Enter.
// Keys arriving faster than a person types, while no text box has the
// cursor, are one read: it goes to the screen's current handler.
let wedgeTarget = null, wedgeBuf = "", wedgeLast = 0, wedgeOn = false;
let readerOpts = { format: "hex", reverse: false };
export function setReaderOptions(o) { readerOpts = { ...readerOpts, ...o }; }
export function setWedgeTarget(fn) {
  wedgeTarget = fn;
  if (wedgeOn) return;
  wedgeOn = true;
  document.addEventListener("keydown", (e) => {
    if (!wedgeTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
    const now = performance.now();
    if (now - wedgeLast > 80) wedgeBuf = "";
    wedgeLast = now;
    if (e.key === "Enter" || e.key === "Tab") {
      const v = wedgeBuf.trim();
      wedgeBuf = "";
      if (v.length >= 4) { e.preventDefault(); wedgeTarget(readerValue(v)); }
      return;
    }
    if (e.key.length === 1) { wedgeBuf += e.key; if (wedgeBuf.length > 300) wedgeBuf = ""; }
  }, true);
}
// What a reader typed, as the server expects it: ticket and tag QR codes as
// they are; a chip number as "UID:" + hex. Readers send chip numbers as hex
// (04:A1:B2…, 04A1B2…) or, set on the device, as a decimal number, and some
// in reverse byte order.
export function readerValue(raw) {
  const v = String(raw).trim();
  if (/^(TR1|TP1|TRT1)\./i.test(v) || /^UID:/i.test(v)) return v;
  let hex = null;
  const plain = v.replace(/[:\s-]/g, "");
  if (readerOpts.format === "decimal" && /^\d{6,20}$/.test(v)) {
    const n = BigInt(v);
    hex = n.toString(16).toUpperCase();
    hex = hex.padStart(hex.length <= 8 ? 8 : 14, "0");
  } else if (/^([0-9A-Fa-f]{2}[:\s-]){3,11}[0-9A-Fa-f]{2}$/.test(v) || (/^[0-9A-Fa-f]+$/.test(plain) && [8, 14, 16, 20, 24].includes(plain.length) && /[0-9]/.test(plain) && /^[0-9A-F]+$/i.test(plain) && !/^[2-9A-HJ-NP-TV-Z]{10}$/i.test(plain))) {
    hex = plain.toUpperCase();
  }
  if (!hex) return v;
  if (readerOpts.reverse) hex = hex.match(/../g).reverse().join("");
  return `UID:${hex}`;
}
// A text box a reader may type into (the gate's code box, the desk's search):
// call the result when the form is sent; it gives the value converted like a
// reader's when it arrived in one fast burst, as typed otherwise.
export function readerBox(input) {
  let first = 0, last = 0, n = 0;
  input.addEventListener("keydown", (e) => {
    if (e.key.length !== 1) return;
    const now = performance.now();
    if (now - last > 80) { first = now; n = 0; }
    last = now; n++;
  });
  return () => {
    const v = input.value.trim();
    const burst = n >= 4 && (last - first) / Math.max(1, n - 1) < 40;
    n = 0;
    return burst ? readerValue(v) : v;
  };
}
