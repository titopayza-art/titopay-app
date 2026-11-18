/* SeaGeek — wireframe seabed renderer.
   A drifting perspective mesh of the ocean floor, with marine snow,
   bioluminescent "signal" nodes (the API network) and slow currents.
   No dependencies. Pauses when off-screen; static frame for reduced motion. */
(function () {
  "use strict";

  function hash(x, y) {
    var h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return h - Math.floor(h);
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function noise(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    var u = smooth(xf), v = smooth(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y) {
    return noise(x, y) * 0.55 + noise(x * 2.1, y * 2.1) * 0.28 + noise(x * 4.3, y * 4.3) * 0.17;
  }

  function Ocean(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.horizon = opts.horizon || 0.5;   // where the ridge sits vertically
    this.density = opts.density || 1;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.t = 0;
    this.running = false;
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
    this.resize();
    this.seed();
    window.addEventListener("resize", this.resize);
    var self = this;
    window.addEventListener("pointermove", function (e) {
      self.pointer.tx = (e.clientX / window.innerWidth - 0.5);
      self.pointer.ty = (e.clientY / window.innerHeight - 0.5);
    }, { passive: true });

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        entries[0].isIntersecting ? self.start() : self.stop();
      }).observe(canvas);
    } else { this.start(); }
    document.addEventListener("visibilitychange", function () {
      document.hidden ? self.stop() : self.start();
    });
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
    var n = this.mobile ? 70 : 150;
    this.snow = [];
    for (var i = 0; i < n; i++) {
      this.snow.push({
        x: Math.random(), y: Math.random(),
        r: Math.random() * 1.4 + 0.3,
        s: Math.random() * 0.00025 + 0.00006,
        d: Math.random() * Math.PI * 2,
        a: Math.random() * 0.5 + 0.15
      });
    }
    this.bubbles = [];
    for (var j = 0; j < 9; j++) {
      this.bubbles.push({ x: Math.random(), y: Math.random(), r: Math.random() * 3 + 2, s: Math.random() * 0.0006 + 0.0003, ph: Math.random() * 6 });
    }
    this.nodes = [];
    for (var k = 0; k < 16; k++) {
      this.nodes.push({ c: Math.random(), z: Math.random(), ph: Math.random() * Math.PI * 2, hue: Math.random() < 0.35 ? "v" : "t" });
    }
  };

  // Height field: a long organic ridge running across the frame, like a reef wall.
  Ocean.prototype.height = function (x, z, t) {
    var drift = z + t * 0.035;
    var ridgeCenter = Math.sin(drift * 0.9 + 0.6) * 0.18 + Math.sin(x * 0.7 + 1.3) * 0.08;
    var dz = (z - 0.38 - ridgeCenter);
    var ridge = Math.exp(-dz * dz * 18) * (0.85 + 0.35 * Math.sin(x * 1.6 + drift * 0.7));
    var branch = Math.exp(-Math.pow(z - 0.62 + (x - 0.7) * 0.6, 2) * 40) * Math.max(0, x - 0.1) * 0.7;
    var detail = fbm(x * 3.2, drift * 2.6) * 0.42;
    var swell = Math.sin(x * 9 + t * 0.6) * Math.sin(drift * 7) * 0.025;
    return ridge * 0.55 + branch * 0.45 + detail * (0.25 + ridge * 0.7) + swell;
  };

  Ocean.prototype.project = function (x, y, z) {
    // x in [-1.4, 1.4], z in [0, 1] (0 near), y up
    var camZ = -0.55, f = this.mobile ? this.w * 0.95 : this.h * 0.9;
    var depth = z - camZ;
    var px = this.w * 0.5 + (x + this.pointer.x * 0.08) * f / depth;
    var hz = this.mobile ? 0.36 : this.horizon;
    var py = this.h * hz + (0.12 - y * 0.42 + this.pointer.y * 0.03) * f / depth;
    return [px, py, depth];
  };

  Ocean.prototype.draw = function () {
    var ctx = this.ctx, w = this.w, h = this.h, t = this.t;
    this.pointer.x += (this.pointer.tx - this.pointer.x) * 0.04;
    this.pointer.y += (this.pointer.ty - this.pointer.y) * 0.04;
    ctx.clearRect(0, 0, w, h);

    var cols = this.cols, rows = this.rows, grid = [];
    var xSpan = this.mobile ? 1.9 : 1.55;
    for (var r = 0; r <= rows; r++) {
      var z = r / rows;
      var row = [];
      for (var c = 0; c <= cols; c++) {
        var u = c / cols;
        var x = (u - 0.5) * 2 * xSpan;
        var y = this.height(u * 2.2, z, t) * 1.25;
        var p = this.project(x, y, z);
        row.push([p[0], p[1], y, z]);
      }
      grid.push(row);
    }

    ctx.lineWidth = 0.7;
    ctx.globalCompositeOperation = "lighter";

    // lines across (rows)
    for (r = 0; r <= rows; r++) {
      var fade = 1 - r / rows;
      for (c = 0; c < cols; c++) {
        var a = grid[r][c], b = grid[r][c + 1];
        var hgt = (a[2] + b[2]) * 0.5;
        if (hgt < 0.12) continue;
        var alpha = Math.min(1, (hgt - 0.12) * 1.9) * (0.24 + fade * 0.6);
        ctx.strokeStyle = this.color(hgt, alpha);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }
    // lines along depth (cols)
    for (c = 0; c <= cols; c += 1) {
      for (r = 0; r < rows; r++) {
        var a2 = grid[r][c], b2 = grid[r + 1][c];
        var hg = (a2[2] + b2[2]) * 0.5;
        if (hg < 0.14) continue;
        var al = Math.min(1, (hg - 0.14) * 1.5) * (0.12 + (1 - r / rows) * 0.38);
        ctx.strokeStyle = this.color(hg, al * 0.85);
        ctx.beginPath(); ctx.moveTo(a2[0], a2[1]); ctx.lineTo(b2[0], b2[1]); ctx.stroke();
      }
    }

    // vertex glints (coral polyps)
    for (r = 0; r <= rows; r += 1) {
      for (c = 0; c <= cols; c += 2) {
        var v = grid[r][c];
        if (v[2] < 0.42) continue;
        var g = hash(c, r + Math.floor(t * 0.02));
        if (g > 0.18) continue;
        ctx.fillStyle = "rgba(170, 245, 235," + (0.25 + (1 - v[3]) * 0.45) + ")";
        ctx.fillRect(v[0] - 0.8, v[1] - 0.8, 1.6, 1.6);
      }
    }

    // bioluminescent signal nodes + links between them
    var pts = [];
    for (var i = 0; i < this.nodes.length; i++) {
      var n = this.nodes[i];
      var cc = Math.floor(n.c * cols), rr = Math.floor(n.z * rows * 0.85);
      var gp = grid[rr][cc];
      if (gp[2] < 0.25) continue;
      var pulse = 0.5 + 0.5 * Math.sin(t * 1.4 + n.ph);
      pts.push([gp[0], gp[1] - 6, pulse, n.hue, gp[3]]);
    }
    for (i = 0; i < pts.length; i++) {
      for (var j = i + 1; j < pts.length; j++) {
        var dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > w * 0.16) continue;
        var la = (1 - dist / (w * 0.16)) * 0.22;
        ctx.strokeStyle = "rgba(169, 139, 255," + la + ")";
        ctx.beginPath();
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.quadraticCurveTo((pts[i][0] + pts[j][0]) / 2, Math.min(pts[i][1], pts[j][1]) - dist * 0.25, pts[j][0], pts[j][1]);
        ctx.stroke();
      }
    }
    for (i = 0; i < pts.length; i++) {
      var q = pts[i], rad = (3 + q[2] * 9) * (1.2 - q[4] * 0.6);
      var col = q[3] === "v" ? "169,139,255" : "95,227,207";
      var grd = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], rad * 2.4);
      grd.addColorStop(0, "rgba(" + col + "," + (0.55 + q[2] * 0.4) + ")");
      grd.addColorStop(1, "rgba(" + col + ",0)");
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(q[0], q[1], rad * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(235,255,252,.9)";
      ctx.beginPath(); ctx.arc(q[0], q[1], 1.6, 0, Math.PI * 2); ctx.fill();
    }

    // marine snow
    for (i = 0; i < this.snow.length; i++) {
      var s = this.snow[i];
      if (!this.reduced) {
        s.y -= s.s; s.x += Math.sin(t * 0.4 + s.d) * 0.00012;
        if (s.y < -0.02) { s.y = 1.02; s.x = Math.random(); }
      }
      ctx.fillStyle = "rgba(200, 240, 245," + s.a * (0.4 + s.y * 0.6) + ")";
      ctx.beginPath(); ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2); ctx.fill();
    }
    // bubbles
    ctx.lineWidth = 1;
    for (i = 0; i < this.bubbles.length; i++) {
      var bb = this.bubbles[i];
      if (!this.reduced) {
        bb.y -= bb.s; if (bb.y < -0.05) { bb.y = 1.05; bb.x = Math.random(); }
      }
      var bx = bb.x * w + Math.sin(t * 1.2 + bb.ph) * 6;
      ctx.strokeStyle = "rgba(210, 250, 250, .28)";
      ctx.beginPath(); ctx.arc(bx, bb.y * h, bb.r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  Ocean.prototype.color = function (hgt, alpha) {
    // low = deep teal, mid = aqua, high = violet tips
    var t = Math.max(0, Math.min(1, (hgt - 0.12) / 0.75));
    var r, g, b;
    if (t < 0.6) { var k = t / 0.6; r = 40 + 60 * k; g = 140 + 90 * k; b = 160 + 50 * k; }
    else { var k2 = (t - 0.6) / 0.4; r = 100 + 80 * k2; g = 230 - 90 * k2; b = 210 + 45 * k2; }
    return "rgba(" + (r | 0) + "," + (g | 0) + "," + (b | 0) + "," + alpha.toFixed(3) + ")";
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
    new Ocean(cv, {
      horizon: parseFloat(cv.getAttribute("data-horizon")) || 0.5,
      density: parseFloat(cv.getAttribute("data-density")) || 1
    });
  });
})();
