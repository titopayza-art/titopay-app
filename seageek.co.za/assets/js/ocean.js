/* SeaGeek hero: a drifting wireframe seabed with marine snow, glowing nodes,
   and wireframe sharks swimming past. Pauses off-screen; still frame for reduced motion. */
(function () {
  "use strict";

  function hash(x, y) { var h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function noise(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    var u = smooth(xf), v = smooth(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y) { return noise(x, y) * 0.55 + noise(x * 2.1, y * 2.1) * 0.28 + noise(x * 4.3, y * 4.3) * 0.17; }

  // ------------------------------------------------------------------
  // Shark: drawn as a wireframe hull (outline, ribs, spine) that bends
  // with a travelling wave so the tail sweeps while the head stays steady.
  // ------------------------------------------------------------------
  function Shark(w, h, depth, scale) {
    this.depth = depth;                       // 0 = far, 1 = near
    this.dir = Math.random() < 0.5 ? 1 : -1;
    this.size = (w < 720 ? 110 : 170) * (0.45 + depth * 0.75) * (scale || 1);
    this.speed = (0.35 + depth * 0.55) * (w < 720 ? 0.7 : 1);
    this.x = Math.random() * w;
    this.baseY = h * (0.16 + Math.random() * 0.34);
    this.y = this.baseY;
    this.phase = Math.random() * 10;
    this.bob = Math.random() * 6;
  }

  Shark.prototype.step = function (w, h, t) {
    this.x += this.speed * this.dir;
    this.phase += 0.06 + this.speed * 0.02;
    this.y = this.baseY + Math.sin(t * 0.5 + this.bob) * 10;
    var margin = this.size * 1.4;
    if (this.dir > 0 && this.x - this.size > w + margin) { this.x = -margin; this.baseY = h * (0.16 + Math.random() * 0.34); }
    if (this.dir < 0 && this.x + this.size < -margin) { this.x = w + margin; this.baseY = h * (0.16 + Math.random() * 0.34); }
  };

  Shark.prototype.draw = function (ctx) {
    var L = this.size, N = 18, d = this.dir, i, t;
    var alpha = 0.32 + this.depth * 0.46;
    var top = [], bot = [], mid = [];
    for (i = 0; i <= N; i++) {
      t = i / N;                                              // 0 = nose, 1 = tail base
      var bend = Math.sin(this.phase - t * 3.2) * Math.pow(t, 1.7) * L * 0.09;
      var half = L * 0.115 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(t, 0.62) * 1.02)), 0.9) * (1 - t * 0.55) + L * 0.008;
      var px = this.x - d * t * L;
      var py = this.y + bend;
      top.push([px, py - half * (t < 0.08 ? 0.7 : 1)]);
      bot.push([px, py + half * 0.82]);
      mid.push([px, py]);
    }
    ctx.save();
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(150, 230, 225," + alpha + ")";

    // Hull outline
    ctx.beginPath();
    ctx.moveTo(top[0][0], top[0][1]);
    for (i = 1; i <= N; i++) ctx.lineTo(top[i][0], top[i][1]);
    for (i = N; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
    ctx.closePath();
    ctx.stroke();

    // Ribs and spine give the wireframe look of the seabed
    ctx.strokeStyle = "rgba(150, 230, 225," + alpha * 0.55 + ")";
    for (i = 2; i < N; i += 2) {
      ctx.beginPath(); ctx.moveTo(top[i][0], top[i][1]);
      ctx.quadraticCurveTo(mid[i][0] - d * L * 0.012, mid[i][1], bot[i][0], bot[i][1]); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(mid[1][0], mid[1][1]);
    for (i = 2; i <= N; i++) ctx.lineTo(mid[i][0], mid[i][1]);
    ctx.stroke();

    ctx.strokeStyle = "rgba(169, 139, 255," + alpha + ")";
    // Dorsal fin
    var a = top[6], b = top[9];
    ctx.beginPath(); ctx.moveTo(a[0], a[1]);
    ctx.quadraticCurveTo(a[0] - d * L * 0.02, a[1] - L * 0.2, b[0] - d * L * 0.06, a[1] - L * 0.19);
    ctx.lineTo(b[0], b[1]); ctx.stroke();
    // Pectoral fin
    var p = bot[4];
    ctx.beginPath(); ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[0] - d * L * 0.17, p[1] + L * 0.14);
    ctx.lineTo(bot[7][0], bot[7][1]); ctx.stroke();
    // Tail: tall upper lobe, short lower lobe, swinging with the body
    var tail = mid[N], sweep = Math.sin(this.phase - 3.4) * L * 0.08;
    ctx.beginPath();
    ctx.moveTo(top[N - 1][0], top[N - 1][1]);
    ctx.lineTo(tail[0] - d * L * 0.16, tail[1] - L * 0.2 + sweep);
    ctx.lineTo(tail[0] - d * L * 0.05, tail[1] + sweep * 0.4);
    ctx.lineTo(tail[0] - d * L * 0.11, tail[1] + L * 0.12 + sweep);
    ctx.lineTo(bot[N - 1][0], bot[N - 1][1]);
    ctx.stroke();
    // Eye and gill slits
    ctx.fillStyle = "rgba(230, 255, 250," + Math.min(1, alpha + 0.3) + ")";
    ctx.beginPath(); ctx.arc(this.x - d * L * 0.07, this.y - L * 0.025, Math.max(1.2, L * 0.009), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(150, 230, 225," + alpha * 0.7 + ")";
    for (i = 0; i < 3; i++) {
      var gx = this.x - d * L * (0.17 + i * 0.025);
      ctx.beginPath(); ctx.moveTo(gx, this.y - L * 0.04); ctx.lineTo(gx - d * L * 0.01, this.y + L * 0.035); ctx.stroke();
    }
    ctx.restore();
  };

  // ------------------------------------------------------------------
  function Ocean(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.horizon = opts.horizon || 0.5;
    this.density = opts.density || 1;
    this.withSharks = !!opts.sharks;
    this.sharkScale = opts.sharkScale || 1;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.t = 0;
    this.running = false;
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    this.frame = this.frame.bind(this);
    this.resize();
    this.seed();
    var self = this;
    window.addEventListener("resize", function () { self.resize(); self.seed(); });
    window.addEventListener("pointermove", function (e) {
      self.pointer.tx = e.clientX / window.innerWidth - 0.5;
      self.pointer.ty = e.clientY / window.innerHeight - 0.5;
    }, { passive: true });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) { entries[0].isIntersecting ? self.start() : self.stop(); }).observe(canvas);
    } else { this.start(); }
    document.addEventListener("visibilitychange", function () { document.hidden ? self.stop() : self.start(); });
  }

  Ocean.prototype.resize = function () {
    var r = this.canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.mobile = r.width < 720;
    this.cols = Math.round((this.mobile ? 50 : 104) * this.density);
    this.rows = Math.round((this.mobile ? 28 : 44) * this.density);
    if (this.reduced) this.draw();
  };

  Ocean.prototype.seed = function () {
    var n = this.mobile ? 70 : 150, i;
    this.snow = [];
    for (i = 0; i < n; i++) this.snow.push({ x: Math.random(), y: Math.random(), r: Math.random() * 1.4 + 0.3, s: Math.random() * 0.00025 + 0.00006, d: Math.random() * 6.28, a: Math.random() * 0.5 + 0.15 });
    this.bubbles = [];
    for (i = 0; i < 9; i++) this.bubbles.push({ x: Math.random(), y: Math.random(), r: Math.random() * 3 + 2, s: Math.random() * 0.0006 + 0.0003, ph: Math.random() * 6 });
    this.nodes = [];
    for (i = 0; i < 14; i++) this.nodes.push({ c: Math.random(), z: Math.random(), ph: Math.random() * 6.28, hue: Math.random() < 0.35 ? "v" : "t" });
    this.sharks = [];
    if (this.withSharks) {
      var count = this.mobile ? 2 : 3;
      for (i = 0; i < count; i++) this.sharks.push(new Shark(this.w, this.h, count === 1 ? 0.7 : i / (count - 1), this.sharkScale));
      this.sharks.sort(function (a, b) { return a.depth - b.depth; });
    }
  };

  Ocean.prototype.height = function (x, z, t) {
    var drift = z + t * 0.035;
    var ridgeCenter = Math.sin(drift * 0.9 + 0.6) * 0.18 + Math.sin(x * 0.7 + 1.3) * 0.08;
    var dz = z - 0.38 - ridgeCenter;
    var ridge = Math.exp(-dz * dz * 18) * (0.85 + 0.35 * Math.sin(x * 1.6 + drift * 0.7));
    var branch = Math.exp(-Math.pow(z - 0.62 + (x - 0.7) * 0.6, 2) * 40) * Math.max(0, x - 0.1) * 0.7;
    var detail = fbm(x * 3.2, drift * 2.6) * 0.42;
    var swell = Math.sin(x * 9 + t * 0.6) * Math.sin(drift * 7) * 0.025;
    return ridge * 0.55 + branch * 0.45 + detail * (0.25 + ridge * 0.7) + swell;
  };

  Ocean.prototype.project = function (x, y, z) {
    var camZ = -0.55, f = this.mobile ? this.w * 0.95 : this.h * 0.9;
    var depth = z - camZ;
    var hz = this.mobile ? 0.36 : this.horizon;
    return [this.w * 0.5 + (x + this.pointer.x * 0.08) * f / depth, this.h * hz + (0.12 - y * 0.42 + this.pointer.y * 0.03) * f / depth, depth];
  };

  Ocean.prototype.color = function (hgt, alpha) {
    var t = Math.max(0, Math.min(1, (hgt - 0.12) / 0.75)), r, g, b, k;
    if (t < 0.6) { k = t / 0.6; r = 40 + 60 * k; g = 140 + 90 * k; b = 160 + 50 * k; }
    else { k = (t - 0.6) / 0.4; r = 100 + 80 * k; g = 230 - 90 * k; b = 210 + 45 * k; }
    return "rgba(" + (r | 0) + "," + (g | 0) + "," + (b | 0) + "," + alpha.toFixed(3) + ")";
  };

  Ocean.prototype.draw = function () {
    var ctx = this.ctx, w = this.w, h = this.h, t = this.t, i, j, r, c;
    this.pointer.x += (this.pointer.tx - this.pointer.x) * 0.04;
    this.pointer.y += (this.pointer.ty - this.pointer.y) * 0.04;
    ctx.clearRect(0, 0, w, h);

    // Distant sharks swim behind the reef
    var far = this.sharks.filter(function (s) { return s.depth < 0.5; });
    var near = this.sharks.filter(function (s) { return s.depth >= 0.5; });
    for (i = 0; i < far.length; i++) { if (!this.reduced) far[i].step(w, h, t); far[i].draw(ctx); }

    var cols = this.cols, rows = this.rows, grid = [], xSpan = this.mobile ? 1.9 : 1.55;
    for (r = 0; r <= rows; r++) {
      var z = r / rows, row = [];
      for (c = 0; c <= cols; c++) {
        var u = c / cols, y = this.height(u * 2.2, z, t) * 1.25, p = this.project((u - 0.5) * 2 * xSpan, y, z);
        row.push([p[0], p[1], y, z]);
      }
      grid.push(row);
    }
    ctx.lineWidth = 0.7;
    ctx.globalCompositeOperation = "lighter";
    for (r = 0; r <= rows; r++) {
      var fade = 1 - r / rows;
      for (c = 0; c < cols; c++) {
        var a = grid[r][c], b = grid[r][c + 1], hg = (a[2] + b[2]) * 0.5;
        if (hg < 0.12) continue;
        ctx.strokeStyle = this.color(hg, Math.min(1, (hg - 0.12) * 1.9) * (0.24 + fade * 0.6));
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }
    for (c = 0; c <= cols; c++) {
      for (r = 0; r < rows; r++) {
        var a2 = grid[r][c], b2 = grid[r + 1][c], hh = (a2[2] + b2[2]) * 0.5;
        if (hh < 0.14) continue;
        ctx.strokeStyle = this.color(hh, Math.min(1, (hh - 0.14) * 1.5) * (0.12 + (1 - r / rows) * 0.38) * 0.85);
        ctx.beginPath(); ctx.moveTo(a2[0], a2[1]); ctx.lineTo(b2[0], b2[1]); ctx.stroke();
      }
    }
    // Signal nodes: the API network
    var pts = [];
    for (i = 0; i < this.nodes.length; i++) {
      var n = this.nodes[i], gp = grid[Math.floor(n.z * rows * 0.85)][Math.floor(n.c * cols)];
      if (gp[2] < 0.25) continue;
      pts.push([gp[0], gp[1] - 6, 0.5 + 0.5 * Math.sin(t * 1.4 + n.ph), n.hue, gp[3]]);
    }
    for (i = 0; i < pts.length; i++) for (j = i + 1; j < pts.length; j++) {
      var dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > w * 0.16) continue;
      ctx.strokeStyle = "rgba(169, 139, 255," + (1 - dist / (w * 0.16)) * 0.2 + ")";
      ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]);
      ctx.quadraticCurveTo((pts[i][0] + pts[j][0]) / 2, Math.min(pts[i][1], pts[j][1]) - dist * 0.25, pts[j][0], pts[j][1]); ctx.stroke();
    }
    for (i = 0; i < pts.length; i++) {
      var q = pts[i], rad = (2 + q[2] * 3) * (1.2 - q[4] * 0.6), col = q[3] === "v" ? "169,139,255" : "95,227,207";
      var grd = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], rad * 2.4);
      grd.addColorStop(0, "rgba(" + col + "," + (0.3 + q[2] * 0.25) + ")"); grd.addColorStop(1, "rgba(" + col + ",0)");
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(q[0], q[1], rad * 2.4, 0, 6.283); ctx.fill();
      ctx.fillStyle = "rgba(235,255,252,.9)"; ctx.beginPath(); ctx.arc(q[0], q[1], 1.5, 0, 6.283); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    // Near sharks swim in front
    for (i = 0; i < near.length; i++) { if (!this.reduced) near[i].step(w, h, t); near[i].draw(ctx); }

    // Marine snow and bubbles
    for (i = 0; i < this.snow.length; i++) {
      var s = this.snow[i];
      if (!this.reduced) { s.y -= s.s; s.x += Math.sin(t * 0.4 + s.d) * 0.00012; if (s.y < -0.02) { s.y = 1.02; s.x = Math.random(); } }
      ctx.fillStyle = "rgba(200, 240, 245," + s.a * (0.4 + s.y * 0.6) + ")";
      ctx.beginPath(); ctx.arc(s.x * w, s.y * h, s.r, 0, 6.283); ctx.fill();
    }
    ctx.lineWidth = 1;
    for (i = 0; i < this.bubbles.length; i++) {
      var bb = this.bubbles[i];
      if (!this.reduced) { bb.y -= bb.s; if (bb.y < -0.05) { bb.y = 1.05; bb.x = Math.random(); } }
      ctx.strokeStyle = "rgba(210, 250, 250, .28)";
      ctx.beginPath(); ctx.arc(bb.x * w + Math.sin(t * 1.2 + bb.ph) * 6, bb.y * h, bb.r, 0, 6.283); ctx.stroke();
    }
  };

  Ocean.prototype.frame = function () {
    if (!this.running) return;
    this.t += 0.016;
    this.draw();
    requestAnimationFrame(this.frame);
  };
  Ocean.prototype.start = function () {
    if (this.reduced) { this.draw(); return; }
    if (this.running) return;
    this.running = true; requestAnimationFrame(this.frame);
  };
  Ocean.prototype.stop = function () { this.running = false; };

  document.querySelectorAll("canvas[data-ocean]").forEach(function (cv) {
    new Ocean(cv, { horizon: parseFloat(cv.getAttribute("data-horizon")) || 0.5, density: parseFloat(cv.getAttribute("data-density")) || 1, sharks: cv.hasAttribute("data-sharks"), sharkScale: parseFloat(cv.getAttribute("data-shark-scale")) || 1 });
  });
})();
