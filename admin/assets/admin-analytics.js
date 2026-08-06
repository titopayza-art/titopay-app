/* ==========================================================================
   TitoPay Admin — Enterprise Analytics module
   --------------------------------------------------------------------------
   Loaded on demand. `admin.js` imports this file only when an operator opens
   the Analytics module, so every other console page keeps the exact payload it
   had before this module existed.

   Contract with admin.js
     renderAnalytics(me, host)  — host carries the console helpers this module
                                  is allowed to use. Nothing here reaches into
                                  admin.js directly, and nothing here changes
                                  console state other than PAGE_EXPORTS.analytics
                                  (so the existing header "Export CSV" keeps
                                  working on this page too).

   Data policy
     Every number on this page is derived from a response the TitoPay API
     actually returned. When the API does not carry a field, the metric renders
     as "—" and is listed in that section's Data coverage card. Nothing is
     estimated, simulated or filled in.

   Content Security Policy
     The console pages declare `style-src 'self'`, so this module never emits a
     `style` attribute. Chart geometry uses SVG attributes and every colour
     comes from a class backed by a design token, which also makes the charts
     follow the light/dark theme without a second code path.
   ========================================================================== */

let HOST = null;
let listenersBound = false;
let hoverBound = false;

const SECTIONS = [
  ["executive", "Executive"],
  ["financial", "Financial"],
  ["users", "Users"],
  ["transactions", "Transactions"],
  ["merchants", "Merchants"],
  ["risk", "Fraud & Security"],
  ["support", "Support"],
  ["system", "System"],
];

const RANGE_PRESETS = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["last_7", "Last 7 Days"],
  ["last_30", "Last 30 Days"],
  ["last_90", "Last 90 Days"],
  ["this_month", "This Month"],
  ["last_month", "Last Month"],
  ["this_year", "This Year"],
  ["custom", "Custom Range"],
];

const PAGE_SIZE = 10;
const SNAPSHOT_TTL_MS = 60 * 1000;
const TRANSACTION_FETCH_LIMIT = 5000;

const state = {
  section: "executive",
  rangeKey: "last_30",
  customFrom: "",
  customTo: "",
  filters: { province: "", merchant: "", user: "", method: "", type: "", status: "" },
  pages: {},
  snapshot: null,
  snapshotKey: "",
  snapshotAt: 0,
  loading: false,
  me: null,
};

/* == Small utilities ====================================================== */

const esc = (value) => HOST.escapeHtml(String(value ?? ""));

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNumeric(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function sum(rows, accessor) {
  return (rows || []).reduce((total, row) => total + num(accessor ? accessor(row) : row), 0);
}

function firstValue(row, keys) {
  if (!row) return undefined;
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function firstDate(row, keys) {
  const raw = firstValue(row, keys);
  return parseDate(raw);
}

const DATE_KEYS = {
  created: ["created_at", "createdAt", "registered_at", "registeredAt", "joined_at", "signup_date", "date_created", "opened_at"],
  updated: ["updated_at", "updatedAt", "modified_at", "last_updated_at"],
  activity: ["last_activity_at", "lastActivityAt", "last_seen_at", "lastSeenAt", "last_active_at", "lastActiveAt", "last_login_at", "lastLoginAt", "last_successful_authentication_at"],
  resolved: ["resolved_at", "resolvedAt", "closed_at", "closedAt", "completed_at", "completedAt"],
};

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function shortDay(key) {
  const parts = String(key).split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : key;
}

function shortMonth(key) {
  const parts = String(key).split("-");
  if (parts.length < 2) return key;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(parts[1]) - 1] || parts[1]} ${String(parts[0]).slice(2)}`;
}

function resolveRange(rangeKey = state.rangeKey) {
  const now = new Date();
  const today = startOfDay(now);
  let from = today;
  let to = endOfDay(now);
  let label = "Last 30 days";

  switch (rangeKey) {
    case "today":
      label = "Today";
      break;
    case "yesterday":
      from = addDays(today, -1);
      to = endOfDay(from);
      label = "Yesterday";
      break;
    case "last_7":
      from = addDays(today, -6);
      label = "Last 7 days";
      break;
    case "last_30":
      from = addDays(today, -29);
      label = "Last 30 days";
      break;
    case "last_90":
      from = addDays(today, -89);
      label = "Last 90 days";
      break;
    case "this_month":
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      label = "This month";
      break;
    case "last_month":
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      to = endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));
      label = "Last month";
      break;
    case "this_year":
      from = new Date(now.getFullYear(), 0, 1);
      label = "This year";
      break;
    case "custom": {
      const customFrom = parseDate(state.customFrom);
      const customTo = parseDate(state.customTo);
      from = customFrom ? startOfDay(customFrom) : addDays(today, -29);
      to = customTo ? endOfDay(customTo) : endOfDay(now);
      if (to < from) to = endOfDay(from);
      label = "Custom range";
      break;
    }
    default:
      from = addDays(today, -29);
      break;
  }

  const spanMs = Math.max(to.getTime() - from.getTime(), 1);
  const previousTo = new Date(from.getTime() - 1);
  const previousFrom = new Date(from.getTime() - spanMs - 1);
  return { key: rangeKey, from, to, previousFrom, previousTo, label, spanMs, days: Math.max(1, Math.round(spanMs / 86400000)) };
}

function inRange(date, from, to) {
  return Boolean(date) && date.getTime() >= from.getTime() && date.getTime() <= to.getTime();
}

function rangeIso(date) {
  return dayKey(date);
}

/* == Formatting =========================================================== */

const integerFormatter = new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 1 });

function fmtInt(value) {
  if (value === null || value === undefined) return null;
  return integerFormatter.format(Math.round(num(value)));
}

function fmtMoney(value) {
  if (value === null || value === undefined) return null;
  return HOST.money(num(value));
}

function fmtPct(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return `${Number(value).toFixed(digits)}%`;
}

function fmtMs(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const ms = num(value);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${decimalFormatter.format(ms / 1000)} s`;
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return null;
  const total = Math.max(0, Math.round(num(seconds)));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  if (total < 86400) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  return `${Math.floor(total / 86400)}d ${Math.floor((total % 86400) / 3600)}h`;
}

function safeRatio(numerator, denominator) {
  const bottom = num(denominator);
  if (!bottom) return null;
  return (num(numerator) / bottom) * 100;
}

/* == Chart kit ============================================================
   Pure SVG, no inline styles, no external libraries. Colours come from
   `.tp-fill-*` / `.tp-stroke-*` classes so both themes and the print
   stylesheet stay correct without a second implementation.
   ======================================================================== */

let chartSequence = 0;
const chartId = () => `tpc-${++chartSequence}`;

function chartPalette(index) {
  return (index % 8) + 1;
}

function niceCeiling(value) {
  const target = num(value);
  if (target <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalised = target / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

function axisTicks(maxValue, count = 4) {
  const top = niceCeiling(maxValue);
  return Array.from({ length: count + 1 }, (_, index) => (top / count) * index);
}

function chartFrame({ title, note, meta, body, legend = "", readoutId = "", empty = false, emptyMessage = "" }) {
  if (empty) {
    return `
      <figure class="tp-chart" data-analytics-card>
        <figcaption class="tp-chart-head">
          <div>
            <h3>${esc(title)}</h3>
            ${note ? `<p>${esc(note)}</p>` : ""}
          </div>
          ${meta ? `<span class="tp-chart-meta">${esc(meta)}</span>` : ""}
        </figcaption>
        <div class="tp-chart-empty">${esc(emptyMessage || "The API did not return data for this view.")}</div>
      </figure>
    `;
  }
  return `
    <figure class="tp-chart" data-analytics-card>
      <figcaption class="tp-chart-head">
        <div>
          <h3>${esc(title)}</h3>
          ${note ? `<p>${esc(note)}</p>` : ""}
        </div>
        ${meta ? `<span class="tp-chart-meta">${esc(meta)}</span>` : ""}
      </figcaption>
      ${legend}
      <div class="tp-chart-canvas">${body}</div>
      ${readoutId ? `<p class="tp-chart-readout" id="${esc(readoutId)}" role="status" aria-live="polite">Hover or focus a point for detail.</p>` : ""}
    </figure>
  `;
}

function legendHtml(series) {
  if (!series || series.length < 2) return "";
  return `
    <ul class="tp-chart-legend">
      ${series.map((entry, index) => `
        <li><span class="tp-legend-swatch tp-fill-${chartPalette(entry.colour ?? index)}" aria-hidden="true"></span>${esc(entry.name)}</li>
      `).join("")}
    </ul>
  `;
}

function emptySeries(series) {
  return !series?.length || series.every((entry) => !entry.points?.length);
}

/* Cartesian chart used for line, area and vertical bars. */
function cartesianChart({ title, note, meta, series = [], kind = "line", valueFormat = fmtInt, height = 240, width = 760, emptyMessage }) {
  if (emptySeries(series)) return chartFrame({ title, note, meta, empty: true, emptyMessage });

  const readout = chartId();
  const padLeft = 62;
  const padRight = 14;
  const padTop = 16;
  const padBottom = 30;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const labels = series[0].points.map((point) => point.label);
  const pointCount = Math.max(labels.length, 1);
  const maxValue = Math.max(...series.flatMap((entry) => entry.points.map((point) => num(point.value))), 0);
  const top = niceCeiling(maxValue) || 1;
  const ticks = axisTicks(maxValue);

  const xFor = (index) => {
    if (pointCount === 1) return padLeft + plotWidth / 2;
    if (kind === "bar") return padLeft + (plotWidth / pointCount) * (index + 0.5);
    return padLeft + (plotWidth / (pointCount - 1)) * index;
  };
  const yFor = (value) => padTop + plotHeight - (num(value) / top) * plotHeight;

  const gridHtml = ticks.map((tick) => `
    <line class="tp-grid" x1="${padLeft}" y1="${yFor(tick).toFixed(1)}" x2="${width - padRight}" y2="${yFor(tick).toFixed(1)}"/>
    <text class="tp-axis-label" x="${padLeft - 8}" y="${(yFor(tick) + 4).toFixed(1)}" text-anchor="end">${esc(compactAxisValue(tick, valueFormat))}</text>
  `).join("");

  const labelStep = Math.max(1, Math.ceil(pointCount / 12));
  const xLabelsHtml = labels.map((label, index) => (index % labelStep === 0 || index === pointCount - 1)
    ? `<text class="tp-axis-label" x="${xFor(index).toFixed(1)}" y="${height - 10}" text-anchor="middle">${esc(label)}</text>`
    : "").join("");

  let seriesHtml = "";
  if (kind === "bar") {
    const slot = plotWidth / pointCount;
    // Capped so a two-point series draws a bar, not a block filling the card.
    const barWidth = Math.max(2, Math.min(46, (slot * 0.62) / series.length));
    seriesHtml = series.map((entry, seriesIndex) => entry.points.map((point, index) => {
      const value = num(point.value);
      const barHeight = Math.max(value > 0 ? 1 : 0, plotHeight - (plotHeight - (value / top) * plotHeight));
      const x = xFor(index) - (barWidth * series.length) / 2 + barWidth * seriesIndex;
      const y = padTop + plotHeight - barHeight;
      return `<rect class="tp-fill-${chartPalette(entry.colour ?? seriesIndex)} tp-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" tabindex="0" data-readout="${esc(readout)}" data-detail="${esc(`${point.label} · ${entry.name}: ${valueFormat(value) ?? value}`)}"><title>${esc(`${point.label} · ${entry.name}: ${valueFormat(value) ?? value}`)}</title></rect>`;
    }).join("")).join("");
  } else {
    seriesHtml = series.map((entry, seriesIndex) => {
      const colour = chartPalette(entry.colour ?? seriesIndex);
      const path = entry.points.map((point, index) => `${index === 0 ? "M" : "L"}${xFor(index).toFixed(1)},${yFor(point.value).toFixed(1)}`).join(" ");
      const areaPath = kind === "area"
        ? `<path class="tp-fill-${colour} tp-area" d="${path} L${xFor(entry.points.length - 1).toFixed(1)},${(padTop + plotHeight).toFixed(1)} L${xFor(0).toFixed(1)},${(padTop + plotHeight).toFixed(1)} Z"/>`
        : "";
      const dots = entry.points.map((point, index) => `<circle class="tp-fill-${colour} tp-dot" cx="${xFor(index).toFixed(1)}" cy="${yFor(point.value).toFixed(1)}" r="${pointCount > 60 ? 1.8 : 3}" tabindex="0" data-readout="${esc(readout)}" data-detail="${esc(`${point.label} · ${entry.name}: ${valueFormat(point.value) ?? point.value}`)}"><title>${esc(`${point.label} · ${entry.name}: ${valueFormat(point.value) ?? point.value}`)}</title></circle>`).join("");
      return `${areaPath}<path class="tp-stroke-${colour} tp-line" d="${path}"/>${dots}`;
    }).join("");
  }

  const body = `
    <svg class="tp-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMidYMid meet">
      <title>${esc(title)}</title>
      ${gridHtml}
      <line class="tp-axis" x1="${padLeft}" y1="${padTop + plotHeight}" x2="${width - padRight}" y2="${padTop + plotHeight}"/>
      ${seriesHtml}
      ${xLabelsHtml}
    </svg>
  `;
  return chartFrame({ title, note, meta, body, legend: legendHtml(series), readoutId: readout });
}

function compactAxisValue(value, valueFormat) {
  const amount = num(value);
  if (valueFormat === fmtMoney) {
    if (Math.abs(amount) >= 1000000) return `R${decimalFormatter.format(amount / 1000000)}m`;
    if (Math.abs(amount) >= 1000) return `R${decimalFormatter.format(amount / 1000)}k`;
    return `R${integerFormatter.format(Math.round(amount))}`;
  }
  if (valueFormat === fmtPct) return `${Math.round(amount)}%`;
  if (Math.abs(amount) >= 1000000) return `${decimalFormatter.format(amount / 1000000)}m`;
  if (Math.abs(amount) >= 1000) return `${decimalFormatter.format(amount / 1000)}k`;
  return integerFormatter.format(Math.round(amount));
}

function lineChart(options) {
  return cartesianChart({ ...options, kind: "line" });
}

function areaChart(options) {
  return cartesianChart({ ...options, kind: "area" });
}

function barChart(options) {
  return cartesianChart({ ...options, kind: "bar" });
}

/* Horizontal bars — the readable shape for ranked categories. */
function rankedBarChart({ title, note, meta, rows = [], valueFormat = fmtInt, emptyMessage, limit = 10 }) {
  const items = rows.filter((row) => isNumeric(row.value)).slice(0, limit);
  if (!items.length) return chartFrame({ title, note, meta, empty: true, emptyMessage });

  const readout = chartId();
  const width = 760;
  const rowHeight = 30;
  const height = items.length * rowHeight + 14;
  const labelWidth = 190;
  const trackWidth = width - labelWidth - 96;
  const top = Math.max(...items.map((row) => num(row.value)), 0) || 1;

  const body = `
    <svg class="tp-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMidYMid meet">
      <title>${esc(title)}</title>
      ${items.map((row, index) => {
        const y = index * rowHeight + 7;
        const barWidth = Math.max(2, (num(row.value) / top) * trackWidth);
        const detail = `${row.label}: ${valueFormat(row.value) ?? row.value}`;
        return `
          <text class="tp-axis-label tp-rank-label" x="0" y="${y + 14}">${esc(String(row.label).slice(0, 30))}</text>
          <rect class="tp-track" x="${labelWidth}" y="${y + 3}" width="${trackWidth}" height="14" rx="7"/>
          <rect class="tp-fill-${chartPalette(index)} tp-bar" x="${labelWidth}" y="${y + 3}" width="${barWidth.toFixed(1)}" height="14" rx="7" tabindex="0" data-readout="${esc(readout)}" data-detail="${esc(detail)}"><title>${esc(detail)}</title></rect>
          <text class="tp-axis-label tp-rank-value" x="${width}" y="${y + 14}" text-anchor="end">${esc(valueFormat(row.value) ?? row.value)}</text>
        `;
      }).join("")}
    </svg>
  `;
  return chartFrame({ title, note, meta, body, readoutId: readout });
}

/* Donut, and pie when `hole` is 0. */
function donutChart({ title, note, meta, rows = [], valueFormat = fmtInt, emptyMessage, hole = 0.62, centreLabel = "" }) {
  const items = rows.filter((row) => num(row.value) > 0);
  const total = sum(items, (row) => row.value);
  if (!items.length || !total) return chartFrame({ title, note, meta, empty: true, emptyMessage });

  const readout = chartId();
  const size = 260;
  const centre = size / 2;
  const radius = centre - 12;
  const inner = radius * hole;
  let angle = -Math.PI / 2;

  const arcs = items.map((row, index) => {
    const share = num(row.value) / total;
    const sweep = share * Math.PI * 2;
    const end = angle + sweep;
    const largeArc = sweep > Math.PI ? 1 : 0;
    const x1 = centre + radius * Math.cos(angle);
    const y1 = centre + radius * Math.sin(angle);
    const x2 = centre + radius * Math.cos(end);
    const y2 = centre + radius * Math.sin(end);
    const ix2 = centre + inner * Math.cos(end);
    const iy2 = centre + inner * Math.sin(end);
    const ix1 = centre + inner * Math.cos(angle);
    const iy1 = centre + inner * Math.sin(angle);
    angle = end;
    const detail = `${row.label}: ${valueFormat(row.value) ?? row.value} (${(share * 100).toFixed(1)}%)`;
    const path = items.length === 1
      ? `M ${centre} ${centre - radius} A ${radius} ${radius} 0 1 1 ${centre - 0.01} ${centre - radius} L ${centre - 0.01} ${centre - inner} A ${inner} ${inner} 0 1 0 ${centre} ${centre - inner} Z`
      : `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${ix2.toFixed(2)} ${iy2.toFixed(2)} A ${inner} ${inner} 0 ${largeArc} 0 ${ix1.toFixed(2)} ${iy1.toFixed(2)} Z`;
    return `<path class="tp-fill-${chartPalette(index)} tp-slice" d="${path}" tabindex="0" data-readout="${esc(readout)}" data-detail="${esc(detail)}"><title>${esc(detail)}</title></path>`;
  }).join("");

  const body = `
    <div class="tp-donut-wrap">
      <svg class="tp-svg tp-donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMidYMid meet">
        <title>${esc(title)}</title>
        ${arcs}
        ${hole > 0 ? `
          <text class="tp-donut-value" x="${centre}" y="${centre - 2}" text-anchor="middle">${esc(centreLabel || valueFormat(total) || total)}</text>
          <text class="tp-donut-caption" x="${centre}" y="${centre + 16}" text-anchor="middle">Total</text>
        ` : ""}
      </svg>
      <ul class="tp-donut-legend">
        ${items.map((row, index) => `
          <li>
            <span class="tp-legend-swatch tp-fill-${chartPalette(index)}" aria-hidden="true"></span>
            <span class="tp-donut-legend-label">${esc(row.label)}</span>
            <strong>${esc(valueFormat(row.value) ?? row.value)}</strong>
            <small>${esc(((num(row.value) / total) * 100).toFixed(1))}%</small>
          </li>
        `).join("")}
      </ul>
    </div>
  `;
  return chartFrame({ title, note, meta, body, readoutId: readout });
}

/* Weekday × hour intensity grid. */
function heatMap({ title, note, meta, matrix, rowLabels, columnLabels, valueFormat = fmtInt, emptyMessage }) {
  const flat = matrix.flat();
  const top = Math.max(...flat, 0);
  if (!top) return chartFrame({ title, note, meta, empty: true, emptyMessage });

  const readout = chartId();
  const cell = 26;
  const gap = 2;
  const labelWidth = 44;
  const headerHeight = 20;
  const width = labelWidth + columnLabels.length * cell;
  const height = headerHeight + rowLabels.length * cell + 6;

  const cells = matrix.map((row, rowIndex) => row.map((value, columnIndex) => {
    const intensity = top ? num(value) / top : 0;
    const detail = `${rowLabels[rowIndex]} ${columnLabels[columnIndex]} · ${valueFormat(value) ?? value}`;
    return `<rect class="tp-fill-1 tp-heat-cell" x="${labelWidth + columnIndex * cell}" y="${headerHeight + rowIndex * cell}" width="${cell - gap}" height="${cell - gap}" rx="3" fill-opacity="${(0.08 + intensity * 0.92).toFixed(3)}" tabindex="0" data-readout="${esc(readout)}" data-detail="${esc(detail)}"><title>${esc(detail)}</title></rect>`;
  }).join("")).join("");

  const body = `
    <svg class="tp-svg tp-heatmap" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMidYMid meet">
      <title>${esc(title)}</title>
      ${columnLabels.map((label, index) => (index % 2 === 0
        ? `<text class="tp-axis-label" x="${labelWidth + index * cell + (cell - gap) / 2}" y="${headerHeight - 7}" text-anchor="middle">${esc(label)}</text>`
        : "")).join("")}
      ${rowLabels.map((label, index) => `<text class="tp-axis-label" x="${labelWidth - 8}" y="${headerHeight + index * cell + 16}" text-anchor="end">${esc(label)}</text>`).join("")}
      ${cells}
    </svg>
  `;
  return chartFrame({ title, note, meta, body, readoutId: readout });
}

/* == KPI cards ============================================================ */

function trendBadge(current, previous) {
  if (!isNumeric(current) || !isNumeric(previous)) return "";
  const before = num(previous);
  const now = num(current);
  if (!before) {
    if (!now) return `<span class="tp-trend tp-trend-flat">No change</span>`;
    return `<span class="tp-trend tp-trend-up">New</span>`;
  }
  const delta = ((now - before) / Math.abs(before)) * 100;
  const rounded = Math.abs(delta) < 0.05 ? 0 : delta;
  const tone = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  const arrow = rounded > 0 ? "▲" : rounded < 0 ? "▼" : "▪";
  return `<span class="tp-trend tp-trend-${tone}">${arrow} ${esc(Math.abs(rounded).toFixed(1))}%</span>`;
}

/* value === null means "the API did not carry this" — never a zero. */
function kpi(label, value, options = {}) {
  const available = value !== null && value !== undefined;
  const { sub = "", trend = "", tone = "", source = "" } = options;
  return `
    <article class="tp-kpi${available ? "" : " tp-kpi-empty"}" data-analytics-card>
      ${tone ? `<span class="metric-indicator ${esc(tone)}" aria-hidden="true"></span>` : ""}
      <span class="tp-kpi-label">${esc(label)}</span>
      <strong class="tp-kpi-value">${available ? esc(value) : "—"}</strong>
      <span class="tp-kpi-foot">
        ${available ? trend : `<span class="tp-trend tp-trend-flat">Not reported</span>`}
        ${sub && available ? `<small>${esc(sub)}</small>` : ""}
        ${!available && source ? `<small>${esc(source)}</small>` : ""}
      </span>
    </article>
  `;
}

function kpiGrid(cards) {
  return `<section class="tp-kpi-grid">${cards.join("")}</section>`;
}

/* == Tables with client-side pagination =================================== */

function analyticsTable({ title, note, meta, columns, rows, pageKey, pageSize = PAGE_SIZE, emptyMessage }) {
  if (!rows?.length) {
    return HOST.tableCard(title, `<div class="empty">${esc(emptyMessage || "The API did not return rows for this view.")}</div>`, note, meta);
  }
  const page = Math.min(Math.max(1, state.pages[pageKey] || 1), Math.max(1, Math.ceil(rows.length / pageSize)));
  const start = (page - 1) * pageSize;
  const visible = rows.slice(start, start + pageSize);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const body = `
    <div class="table-wrap">
      <table>
        <thead><tr>${columns.map((column) => `<th>${esc(column.label)}</th>`).join("")}</tr></thead>
        <tbody>
          ${visible.map((row) => `<tr>${columns.map((column) => `<td>${column.render ? column.render(row) : esc(row[column.key] ?? "")}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${totalPages > 1 ? `
      <div class="tp-pager">
        <button class="ghost-btn" type="button" data-analytics-page="${esc(pageKey)}" data-analytics-page-to="${page - 1}"${page <= 1 ? " disabled" : ""}>Previous</button>
        <span>Page ${page} of ${totalPages} · ${esc(fmtInt(rows.length))} rows</span>
        <button class="ghost-btn" type="button" data-analytics-page="${esc(pageKey)}" data-analytics-page-to="${page + 1}"${page >= totalPages ? " disabled" : ""}>Next</button>
      </div>
    ` : ""}
  `;
  return HOST.tableCard(title, body, note, meta || `${rows.length} rows`);
}

/* == Data coverage ======================================================== */

function coverageCard(entries) {
  const missing = entries.filter((entry) => !entry.available);
  if (!missing.length) {
    return HOST.tableCard(
      "Data coverage",
      `<div class="tp-coverage-ok">Every metric in this section was produced from a live TitoPay API response.</div>`,
      "Analytics never estimates a number. This card lists anything the API did not carry."
    );
  }
  return HOST.tableCard(
    "Data coverage",
    `
      <p class="tp-coverage-note">${esc(`${missing.length} metric${missing.length === 1 ? "" : "s"} in this section showed "—" because the TitoPay API response did not carry the field. Nothing was estimated.`)}</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Metric</th><th>Needed from the API</th></tr></thead>
          <tbody>${missing.map((entry) => `<tr><td>${esc(entry.label)}</td><td><code>${esc(entry.source)}</code></td></tr>`).join("")}</tbody>
        </table>
      </div>
    `,
    "Analytics never estimates a number. This card lists anything the API did not carry.",
    `${missing.length} of ${entries.length} unavailable`
  );
}

/* == Field readers ========================================================
   The console talks to one API but its modules were written at different
   times, so the same idea appears under more than one field name. These
   readers accept every spelling already used elsewhere in admin.js and
   return undefined rather than guessing.
   ======================================================================== */

const lower = (value) => String(value ?? "").trim().toLowerCase();

const READ = {
  txDate: (row) => firstDate(row, DATE_KEYS.created),
  txAmount: (row) => num(firstValue(row, ["amount", "value", "total_amount"]) ?? 0),
  txFee: (row) => num(firstValue(row, ["fee", "fee_amount", "platform_fee"]) ?? 0),
  txRevenue: (row) => num(firstValue(row, ["revenue_recorded", "revenue", "platform_revenue"]) ?? 0),
  txStatus: (row) => lower(firstValue(row, ["status", "state"]) || ""),
  txService: (row) => String(firstValue(row, ["service_code", "service_type", "type", "transaction_type"]) || "").trim(),
  txServiceName: (row) => String(firstValue(row, ["service_name", "service_code", "service_type", "type"]) || "").trim(),
  txMethod: (row) => String(firstValue(row, ["payment_method", "paymentMethod", "method", "channel", "financial_route", "wallet_kind"]) || "").trim(),
  txMerchant: (row) => String(firstValue(row, ["merchant_number", "merchantNumber", "merchant_id", "business_name", "merchant_name"]) || "").trim(),
  txUser: (row) => String(firstValue(row, ["owner_identifier", "owner_name", "username", "full_name", "user_id", "wallet_number"]) || "").trim(),
  txProvince: (row) => String(firstValue(row, ["province", "region", "state"]) || "").trim(),
  txProcessingMs: (row) => {
    const direct = firstValue(row, ["processing_ms", "processingMs", "duration_ms", "latency_ms"]);
    if (isNumeric(direct)) return num(direct);
    const seconds = firstValue(row, ["processing_seconds", "duration_seconds"]);
    if (isNumeric(seconds)) return num(seconds) * 1000;
    const created = firstDate(row, DATE_KEYS.created);
    const settled = firstDate(row, ["completed_at", "settled_at", "processed_at", "finalised_at", "finalized_at"]);
    if (created && settled) return Math.max(0, settled.getTime() - created.getTime());
    return null;
  },
  userCreated: (row) => firstDate(row, DATE_KEYS.created),
  userActivity: (row) => firstDate(row, DATE_KEYS.activity),
  userProvince: (row) => String(firstValue(row, ["province", "region", "state"]) || "").trim(),
  userCity: (row) => String(firstValue(row, ["city", "town", "suburb"]) || "").trim(),
  userLanguage: (row) => String(firstValue(row, ["language", "preferred_language", "locale"]) || "").trim(),
  userDevice: (row) => String(firstValue(row, ["device_type", "deviceType", "device", "device_name", "platform"]) || "").trim(),
  userBrowser: (row) => String(firstValue(row, ["browser", "user_agent_browser", "client_browser"]) || "").trim(),
  userOs: (row) => String(firstValue(row, ["operating_system", "os", "platform", "device_platform"]) || "").trim(),
  userBirth: (row) => firstDate(row, ["date_of_birth", "dob", "birth_date", "birthdate"]),
  userAge: (row) => {
    const direct = firstValue(row, ["age"]);
    if (isNumeric(direct)) return num(direct);
    const birth = READ.userBirth(row);
    if (!birth) return null;
    const years = (Date.now() - birth.getTime()) / (365.25 * 86400000);
    return years > 0 && years < 130 ? Math.floor(years) : null;
  },
  walletBalance: (row) => num(firstValue(row, ["available_balance", "balance", "current_balance"]) ?? 0) + num(firstValue(row, ["reserved_balance", "pending_balance"]) ?? 0),
};

const PROVINCE_CANON = {
  gauteng: "Gauteng",
  "western cape": "Western Cape",
  "eastern cape": "Eastern Cape",
  "northern cape": "Northern Cape",
  "kwazulu-natal": "KwaZulu-Natal",
  "kwazulu natal": "KwaZulu-Natal",
  kzn: "KwaZulu-Natal",
  "free state": "Free State",
  limpopo: "Limpopo",
  mpumalanga: "Mpumalanga",
  "north west": "North West",
};

function canonicalProvince(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return PROVINCE_CANON[lower(text)] || text;
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/* Counts distinct values of one dimension. Returns null — not an empty list —
   when no row carried the field, so the caller can show "—" instead of a
   chart that looks like a real zero. */
function distribution(rows, reader, { limit = 12, canon = (value) => value } = {}) {
  const counts = new Map();
  let seen = 0;
  (rows || []).forEach((row) => {
    const raw = reader(row);
    if (raw === null || raw === undefined || raw === "") return;
    seen += 1;
    const key = canon(raw);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  if (!seen) return null;
  return [...counts.entries()]
    .map(([label, value]) => ({ label: titleCase(label), value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function groupSum(rows, keyReader, valueReader, { limit = 10 } = {}) {
  const totals = new Map();
  (rows || []).forEach((row) => {
    const key = keyReader(row);
    if (!key) return;
    totals.set(key, (totals.get(key) || 0) + num(valueReader(row)));
  });
  return [...totals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

/* Daily buckets across the whole range, so a quiet day is a zero on the chart
   rather than a missing point that shortens the line. */
function dailySeries(rows, dateReader, valueReader, range, { maxBuckets = 120 } = {}) {
  const buckets = new Map();
  const cursor = startOfDay(range.from);
  const last = startOfDay(range.to);
  let guard = 0;
  for (let day = new Date(cursor); day <= last && guard < 400; day = addDays(day, 1)) {
    buckets.set(dayKey(day), 0);
    guard += 1;
  }
  (rows || []).forEach((row) => {
    const date = dateReader(row);
    if (!date || !inRange(date, range.from, range.to)) return;
    const key = dayKey(date);
    if (!buckets.has(key)) buckets.set(key, 0);
    buckets.set(key, buckets.get(key) + (valueReader ? num(valueReader(row)) : 1));
  });
  const entries = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const trimmed = entries.length > maxBuckets ? entries.slice(entries.length - maxBuckets) : entries;
  return trimmed.map(([key, value]) => ({ label: shortDay(key), value, key }));
}

function monthlySeries(rows, dateReader, valueReader, { months = 12 } = {}) {
  const buckets = new Map();
  (rows || []).forEach((row) => {
    const date = dateReader(row);
    if (!date) return;
    const key = monthKey(date);
    buckets.set(key, (buckets.get(key) || 0) + (valueReader ? num(valueReader(row)) : 1));
  });
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-months)
    .map(([key, value]) => ({ label: shortMonth(key), value, key }));
}

function yearlySeries(rows, dateReader, valueReader) {
  const buckets = new Map();
  (rows || []).forEach((row) => {
    const date = dateReader(row);
    if (!date) return;
    const key = String(date.getFullYear());
    buckets.set(key, (buckets.get(key) || 0) + (valueReader ? num(valueReader(row)) : 1));
  });
  return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, value]) => ({ label, value }));
}

function cumulativeSeries(points, base = 0) {
  let running = num(base);
  return points.map((point) => {
    running += num(point.value);
    return { label: point.label, value: running, key: point.key };
  });
}

/* == Fetch layer ==========================================================
   Every request is best-effort and timed. A module that cannot answer is
   recorded, never thrown, so one unavailable endpoint can never blank the
   whole analytics page.
   ======================================================================== */

async function timedFetch(path) {
  const started = performance.now();
  try {
    const data = await HOST.apiFetch(path);
    return { ok: true, data, ms: performance.now() - started, path };
  } catch (error) {
    return { ok: false, data: null, ms: performance.now() - started, path, status: error?.status ?? null, message: error?.message || "Unavailable" };
  }
}

const itemsOf = (result, ...keys) => {
  if (!result?.ok || !result.data) return [];
  for (const key of ["items", ...keys]) {
    if (Array.isArray(result.data[key])) return result.data[key];
  }
  return Array.isArray(result.data) ? result.data : [];
};

function snapshotKey(range) {
  return [range.key, rangeIso(range.from), rangeIso(range.to)].join("|");
}

const CORE_REQUESTS = (range) => {
  const query = new URLSearchParams();
  query.set("from", rangeIso(range.previousFrom));
  query.set("to", rangeIso(range.to));
  query.set("limit", String(TRANSACTION_FETCH_LIMIT));
  return [
    ["analytics", `/admin/analytics/overview?${query.toString()}`],
    ["overview", "/admin/dashboard/overview"],
    ["users", "/admin/users"],
    ["merchants", "/admin/merchants"],
    ["wallets", "/admin/wallets"],
    ["transactions", `/admin/transactions?${query.toString()}`],
    ["revenue", "/admin/revenue"],
    ["compliance", "/admin/compliance/queue"],
    ["tickets", "/admin/support/tickets"],
    ["conversations", "/admin/support/conversations"],
    ["security", "/admin/security"],
    ["health", "/admin/module-health"],
  ];
};

const EXTRA_REQUESTS = {
  risk: [["audit", "/admin/audit"]],
  merchants: [["reviews", "/admin/marketing/reviews"], ["qr", "/admin/qr-assets"]],
  support: [["chat", "/admin/chat-monitor/overview"]],
  system: [["maintenance", "/admin/maintenance"], ["webhooks", "/admin/integrations/webhooks"], ["email", "/admin/email/dashboard"]],
  executive: [["qr", "/admin/qr-assets"]],
};

async function buildSnapshot(range) {
  const requests = CORE_REQUESTS(range);
  const results = await Promise.all(requests.map(([, path]) => timedFetch(path)));
  const raw = {};
  requests.forEach(([name], index) => {
    raw[name] = results[index];
  });
  return { range, raw, extras: {}, builtAt: Date.now() };
}

async function ensureExtras(section) {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const requests = (EXTRA_REQUESTS[section] || []).filter(([name]) => !snapshot.extras[name]);
  if (!requests.length) return;
  const results = await Promise.all(requests.map(([, path]) => timedFetch(path)));
  requests.forEach(([name], index) => {
    snapshot.extras[name] = results[index];
  });
}

const source = (snapshot, name) => snapshot.extras[name] || snapshot.raw[name] || { ok: false, data: null };

/* == Filtering ============================================================ */

function transactionRows(snapshot) {
  return itemsOf(snapshot.raw.transactions, "transactions", "rows");
}

function matchesFilters(row) {
  const filters = state.filters;
  if (filters.status && READ.txStatus(row) !== lower(filters.status)) return false;
  if (filters.type && lower(READ.txService(row)) !== lower(filters.type)) return false;
  if (filters.method && lower(READ.txMethod(row)) !== lower(filters.method)) return false;
  if (filters.merchant && lower(READ.txMerchant(row)) !== lower(filters.merchant)) return false;
  if (filters.user && lower(READ.txUser(row)) !== lower(filters.user)) return false;
  if (filters.province && lower(canonicalProvince(READ.txProvince(row))) !== lower(filters.province)) return false;
  return true;
}

function personMatchesFilters(row) {
  const filters = state.filters;
  if (filters.province && lower(canonicalProvince(READ.userProvince(row))) !== lower(filters.province)) return false;
  if (filters.user) {
    const identity = [row.username, row.full_name, row.email, row.phone, row.wallet_id, row.wallet_number].map(lower);
    if (!identity.includes(lower(filters.user))) return false;
  }
  return true;
}

function activeFilterCount() {
  return Object.values(state.filters).filter(Boolean).length;
}

function partitionTransactions(snapshot) {
  const range = snapshot.range;
  const all = transactionRows(snapshot).filter(matchesFilters);
  const current = [];
  const previous = [];
  all.forEach((row) => {
    const date = READ.txDate(row);
    if (!date) return;
    if (inRange(date, range.from, range.to)) current.push(row);
    else if (inRange(date, range.previousFrom, range.previousTo)) previous.push(row);
  });
  const undated = all.filter((row) => !READ.txDate(row));
  // If the API returned rows but none of them carry a date, the range cannot be
  // applied — the rows are shown as the current period rather than dropped.
  const effectiveCurrent = current.length || !undated.length ? current : undated;
  return { all, current: effectiveCurrent, previous, undated };
}

function filterOptions(snapshot) {
  const transactions = transactionRows(snapshot);
  const users = itemsOf(snapshot.raw.users);
  const merchants = itemsOf(snapshot.raw.merchants);
  const distinct = (values) => [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    province: distinct([
      ...users.map((row) => canonicalProvince(READ.userProvince(row))),
      ...merchants.map((row) => canonicalProvince(firstValue(row, ["province", "region"]) || "")),
      ...transactions.map((row) => canonicalProvince(READ.txProvince(row))),
    ]),
    merchant: distinct([
      ...transactions.map((row) => READ.txMerchant(row)),
      ...merchants.map((row) => firstValue(row, ["merchant_number", "business_name"]) || ""),
    ]).slice(0, 200),
    user: distinct(transactions.map((row) => READ.txUser(row))).slice(0, 200),
    method: distinct(transactions.map((row) => READ.txMethod(row))),
    type: distinct(transactions.map((row) => READ.txService(row))),
    status: distinct(transactions.map((row) => READ.txStatus(row))),
  };
}

/* == Shared derivations =================================================== */

const TX_CATEGORY_RULES = [
  ["QR Payments", /qr/i],
  ["Withdrawals", /withdraw|cash[_\s-]?out|payout|settle/i],
  ["Deposits", /deposit|top[_\s-]?up|cash[_\s-]?in|fund|load/i],
  ["Merchant Payments", /merchant|pos|checkout|till|invoice/i],
  ["Wallet Transfers", /transfer|send|p2p|wallet/i],
  ["Bill & VAS", /airtime|data|electricity|bill|voucher|ticket|vas/i],
];

function txCategory(row) {
  const haystack = [READ.txService(row), READ.txServiceName(row), READ.txMethod(row)].join(" ");
  const rule = TX_CATEGORY_RULES.find(([, pattern]) => pattern.test(haystack));
  return rule ? rule[0] : "Other";
}

const SUCCESS_STATES = ["completed", "success", "successful", "settled", "paid", "complete"];
const FAILURE_STATES = ["failed", "declined", "rejected", "error", "cancelled", "canceled"];
const REVERSAL_STATES = ["reversed", "refunded", "refund", "chargeback"];

const isSuccessful = (row) => SUCCESS_STATES.includes(READ.txStatus(row));
const isFailed = (row) => FAILURE_STATES.includes(READ.txStatus(row));
const isReversed = (row) => REVERSAL_STATES.includes(READ.txStatus(row));

/* Revenue: the transaction rows carry the recorded platform revenue. When no
   row carries it, the revenue module's own daily series is used instead, and
   the card says which one produced the number. */
function revenueOf(rows) {
  const recorded = sum(rows, READ.txRevenue);
  if (recorded) return { value: recorded, from: "transaction revenue_recorded" };
  const fees = sum(rows, READ.txFee);
  if (fees) return { value: fees, from: "transaction fees" };
  return { value: null, from: "" };
}

function revenueValue(rows) {
  return revenueOf(rows).value;
}

/* Searches a response object for the first key that matches, bounded so an
   unexpected payload can never turn into a long walk. */
function deepFind(payload, keys, depth = 4) {
  if (!payload || typeof payload !== "object" || depth < 0) return undefined;
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== "") return payload[key];
  }
  for (const value of Object.values(payload)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const found = deepFind(value, keys, depth - 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function medianOf(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function apiLatency(snapshot) {
  const timings = [...Object.values(snapshot.raw), ...Object.values(snapshot.extras)]
    .filter((result) => result?.ok)
    .map((result) => result.ms);
  return medianOf(timings);
}

function activityWindow(users, days) {
  const cutoff = new Date(Date.now() - days * 86400000);
  let carried = 0;
  let active = 0;
  users.forEach((row) => {
    const seen = READ.userActivity(row);
    if (!seen) return;
    carried += 1;
    if (seen >= cutoff) active += 1;
  });
  return carried ? active : null;
}

/* Falls back to distinct transacting identities when no account record carries
   a last-seen timestamp. The card labels which definition produced it. */
function activeFromTransactions(rows, from, to) {
  const identities = new Set();
  rows.forEach((row) => {
    const date = READ.txDate(row);
    if (!date || !inRange(date, from, to)) return;
    const identity = READ.txUser(row);
    if (identity) identities.add(lower(identity));
  });
  return identities.size || null;
}

function coreDerived(snapshot) {
  const range = snapshot.range;
  const tx = partitionTransactions(snapshot);
  const users = itemsOf(snapshot.raw.users).filter(personMatchesFilters);
  const merchants = itemsOf(snapshot.raw.merchants);
  const wallets = itemsOf(snapshot.raw.wallets);
  const overview = snapshot.raw.overview?.ok ? snapshot.raw.overview.data : {};
  const todayFrom = startOfDay(new Date());
  const todayTo = endOfDay(new Date());
  const todayRows = tx.all.filter((row) => inRange(READ.txDate(row), todayFrom, todayTo));
  return { range, tx, users, merchants, wallets, overview, todayRows, todayFrom, todayTo };
}

/* == Executive ============================================================ */

function renderExecutive(snapshot) {
  const { range, tx, users, merchants, wallets, overview, todayRows, todayFrom, todayTo } = coreDerived(snapshot);
  const current = tx.current;
  const previous = tx.previous;

  const compliance = itemsOf(snapshot.raw.compliance);
  const tickets = itemsOf(snapshot.raw.tickets);
  const conversations = itemsOf(snapshot.raw.conversations);
  const security = snapshot.raw.security?.ok ? snapshot.raw.security.data : {};
  const sessions = (security.adminSessions || []).filter((row) => !row.revoked_at);
  const healthTables = snapshot.raw.health?.ok ? (snapshot.raw.health.data.tables || []) : [];
  const qrItems = snapshot.extras.qr?.ok ? itemsOf(snapshot.extras.qr, "assets") : null;

  const usersCreatedKnown = users.some((row) => READ.userCreated(row));
  const merchantsCreatedKnown = merchants.some((row) => firstDate(row, DATE_KEYS.created));
  const totalUsers = users.length || (isNumeric(overview.users) ? num(overview.users) : null);

  const activeToday = activityWindow(users, 1) ?? activeFromTransactions(tx.all, todayFrom, todayTo);
  const active7 = activityWindow(users, 7) ?? activeFromTransactions(tx.all, addDays(startOfDay(new Date()), -6), todayTo);
  const active30 = activityWindow(users, 30) ?? activeFromTransactions(tx.all, addDays(startOfDay(new Date()), -29), todayTo);
  const activityFromAccounts = users.some((row) => READ.userActivity(row));

  const newUsersToday = usersCreatedKnown ? users.filter((row) => inRange(READ.userCreated(row), todayFrom, todayTo)).length : null;
  const newBusinesses = merchantsCreatedKnown ? merchants.filter((row) => inRange(firstDate(row, DATE_KEYS.created), range.from, range.to)).length : null;
  const verifiedBusinesses = merchants.length ? merchants.filter((row) => lower(row.verification_status) === "verified").length : null;
  const pendingKyc = compliance.length
    ? compliance.filter((row) => ["pending", "in_review", "submitted"].includes(lower(row.status))).length
    : (isNumeric(overview.pendingCompliance) ? num(overview.pendingCompliance) : null);

  const walletFloat = wallets.length ? sum(wallets, READ.walletBalance) : null;

  const successful = current.filter(isSuccessful).length;
  const failed = current.filter(isFailed).length;
  const successRate = current.length ? safeRatio(successful, current.length) : null;
  const avgValue = current.length ? sum(current, READ.txAmount) / current.length : null;

  const revenue = revenueOf(current);
  const previousRevenue = revenueValue(previous);
  const revenueToday = revenueValue(todayRows);
  const fees = current.length ? sum(current, READ.txFee) : null;
  const settlementRows = current.filter((row) => /settle|payout/i.test([READ.txService(row), READ.txServiceName(row), READ.txMethod(row)].join(" ")));
  const settlements = settlementRows.length ? sum(settlementRows, READ.txAmount) : null;

  const openTickets = tickets.length ? tickets.filter((row) => ["open", "in_progress", "pending"].includes(lower(row.status))).length : null;
  const resolvedTickets = tickets.length ? tickets.filter((row) => ["resolved", "closed", "completed"].includes(lower(row.status))).length : null;

  const healthy = healthTables.filter((row) => row.exists).length;
  const systemHealth = healthTables.length ? fmtPct(safeRatio(healthy, healthTables.length), 0) : null;
  const latency = apiLatency(snapshot);
  const devices = new Set(sessions.map((row) => lower(row.device_name || row.platform || "")).filter(Boolean));

  const cards = [
    kpi("Total Registered Users", fmtInt(totalUsers), { sub: "Accounts on the platform", tone: "" }),
    kpi("Active Users Today", fmtInt(activeToday), { sub: activityFromAccounts ? "Seen in the last 24 hours" : "Distinct transacting identities", source: "user last_seen_at" }),
    kpi("Active Users (7 Days)", fmtInt(active7), { sub: activityFromAccounts ? "Seen in the last 7 days" : "Distinct transacting identities", source: "user last_seen_at" }),
    kpi("Active Users (30 Days)", fmtInt(active30), { sub: activityFromAccounts ? "Seen in the last 30 days" : "Distinct transacting identities", source: "user last_seen_at" }),
    kpi("New Users Today", fmtInt(newUsersToday), { sub: "Registered since midnight", source: "user created_at" }),
    kpi("New Businesses", fmtInt(newBusinesses), { sub: `Registered in ${range.label.toLowerCase()}`, source: "merchant created_at" }),
    kpi("Verified Businesses", fmtInt(verifiedBusinesses), { sub: merchants.length ? `${fmtPct(safeRatio(verifiedBusinesses, merchants.length), 0)} of merchants` : "", tone: "green" }),
    kpi("Pending KYC", fmtInt(pendingKyc), { sub: "Awaiting a compliance decision", tone: pendingKyc ? "orange" : "green" }),
    kpi("Wallets Created", fmtInt(wallets.length || null), { sub: "Personal, business and platform" }),
    kpi("Wallet Balance Float", fmtMoney(walletFloat), { sub: "Available plus reserved", tone: "" }),
    kpi("Total Transactions", fmtInt(current.length), { sub: `In ${range.label.toLowerCase()}`, trend: trendBadge(current.length, previous.length) }),
    kpi("Transactions Today", fmtInt(todayRows.length), { sub: "Since midnight" }),
    kpi("Transaction Success Rate", fmtPct(successRate), { sub: `${fmtInt(successful)} settled`, tone: successRate === null ? "" : successRate >= 95 ? "green" : successRate >= 85 ? "orange" : "red" }),
    kpi("Failed Transactions", fmtInt(current.length ? failed : null), { sub: "Declined, failed or cancelled", tone: failed ? "red" : "green", trend: trendBadge(failed, previous.filter(isFailed).length) }),
    kpi("Average Transaction Value", fmtMoney(avgValue), { sub: "Mean amount in range" }),
    kpi("Total Revenue", fmtMoney(revenue.value), { sub: revenue.from ? `From ${revenue.from}` : "", trend: trendBadge(revenue.value, previousRevenue), source: "transaction revenue_recorded" }),
    kpi("Revenue Today", fmtMoney(revenueToday), { sub: "Recorded since midnight", source: "transaction revenue_recorded" }),
    kpi("Platform Fees", fmtMoney(fees), { sub: "Fees charged in range", source: "transaction fee" }),
    kpi("Merchant Settlements", fmtMoney(settlements), { sub: "Settlement and payout movements", source: "settlement transaction rows" }),
    kpi("Support Tickets Open", fmtInt(openTickets), { sub: "Open, pending or in progress", tone: openTickets ? "orange" : "green" }),
    kpi("Support Tickets Resolved", fmtInt(resolvedTickets), { sub: "Resolved or closed", tone: "green" }),
    kpi("Chat Sessions", fmtInt(conversations.length || null), { sub: "Support conversations on record" }),
    kpi("QR Codes Generated", fmtInt(qrItems ? qrItems.length : null), { sub: "QR assets on record", source: "GET /admin/qr-assets" }),
    kpi("System Health", systemHealth, { sub: healthTables.length ? `${healthy} of ${healthTables.length} tables present` : "", tone: systemHealth === null ? "" : healthy === healthTables.length ? "green" : "red" }),
    kpi("API Response Time", fmtMs(latency), { sub: "Median of this page's own calls", tone: latency === null ? "" : latency < 400 ? "green" : latency < 1200 ? "orange" : "red" }),
    kpi("Active Sessions", fmtInt(security.adminSessions ? sessions.length : null), { sub: "Staff sessions not revoked", source: "security adminSessions" }),
    kpi("Devices Online", fmtInt(security.adminSessions ? devices.size : null), { sub: "Distinct devices on active sessions", source: "security adminSessions" }),
    kpi("Transactions per Day", fmtInt(current.length ? current.length / Math.max(1, range.days) : null), { sub: `Average across ${range.days} day${range.days === 1 ? "" : "s"}` }),
  ];

  const revenueSeries = dailySeries(current, READ.txDate, (row) => READ.txRevenue(row) || READ.txFee(row), range);
  const volumeSeries = dailySeries(current, READ.txDate, null, range);
  const statusRows = [
    { label: "Successful", value: successful },
    { label: "Failed", value: failed },
    { label: "Reversed", value: current.filter(isReversed).length },
    { label: "In flight", value: current.length - successful - failed - current.filter(isReversed).length },
  ].filter((row) => row.value > 0);

  const serviceRows = groupSum(current, READ.txServiceName, (row) => READ.txRevenue(row) || READ.txFee(row), { limit: 8 })
    .filter((row) => row.value > 0)
    .map((row) => ({ label: titleCase(row.label), value: row.value }));

  state.datasets = [
    {
      name: "Executive KPIs",
      columns: ["metric", "value", "period"],
      rows: [
        ["Total Registered Users", fmtInt(totalUsers)],
        ["Active Users Today", fmtInt(activeToday)],
        ["Active Users 7 Days", fmtInt(active7)],
        ["Active Users 30 Days", fmtInt(active30)],
        ["New Users Today", fmtInt(newUsersToday)],
        ["New Businesses", fmtInt(newBusinesses)],
        ["Verified Businesses", fmtInt(verifiedBusinesses)],
        ["Pending KYC", fmtInt(pendingKyc)],
        ["Wallets Created", fmtInt(wallets.length || null)],
        ["Wallet Balance Float", fmtMoney(walletFloat)],
        ["Total Transactions", fmtInt(current.length)],
        ["Transactions Today", fmtInt(todayRows.length)],
        ["Transaction Success Rate", fmtPct(successRate)],
        ["Failed Transactions", fmtInt(current.length ? failed : null)],
        ["Average Transaction Value", fmtMoney(avgValue)],
        ["Total Revenue", fmtMoney(revenue.value)],
        ["Revenue Today", fmtMoney(revenueToday)],
        ["Platform Fees", fmtMoney(fees)],
        ["Merchant Settlements", fmtMoney(settlements)],
        ["Support Tickets Open", fmtInt(openTickets)],
        ["Support Tickets Resolved", fmtInt(resolvedTickets)],
        ["Chat Sessions", fmtInt(conversations.length || null)],
        ["QR Codes Generated", fmtInt(qrItems ? qrItems.length : null)],
        ["System Health", systemHealth],
        ["API Response Time", fmtMs(latency)],
        ["Active Sessions", fmtInt(security.adminSessions ? sessions.length : null)],
        ["Devices Online", fmtInt(security.adminSessions ? devices.size : null)],
      ].map(([metric, value]) => ({ metric, value: value ?? "Not reported", period: `${rangeIso(range.from)} to ${rangeIso(range.to)}` })),
    },
    {
      name: "Revenue by day",
      columns: ["day", "revenue"],
      rows: revenueSeries.map((point) => ({ day: point.key, revenue: point.value })),
    },
    {
      name: "Volume by day",
      columns: ["day", "transactions"],
      rows: volumeSeries.map((point) => ({ day: point.key, transactions: point.value })),
    },
  ];

  return `
    ${kpiGrid(cards)}
    <section class="tp-chart-grid tp-chart-grid-2">
      ${areaChart({ title: "Revenue by day", note: "Platform revenue recorded against each transaction.", meta: range.label, series: [{ name: "Revenue", points: revenueSeries }], valueFormat: fmtMoney })}
      ${lineChart({ title: "Transaction volume", note: "Transactions created per day.", meta: range.label, series: [{ name: "Transactions", points: volumeSeries, colour: 2 }] })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${donutChart({ title: "Settlement outcome", note: "Every transaction in range by final state.", rows: statusRows, emptyMessage: "No transactions in this range." })}
      ${rankedBarChart({ title: "Top revenue services", note: "Services ranked by recorded revenue.", rows: serviceRows, valueFormat: fmtMoney, emptyMessage: "No service revenue in this range." })}
    </section>
    ${coverageCard([
      { label: "Active user counts", available: activityFromAccounts, source: "last_seen_at on GET /admin/users" },
      { label: "New users and businesses", available: usersCreatedKnown && merchantsCreatedKnown, source: "created_at on users and merchants" },
      { label: "Revenue and fees", available: revenue.value !== null, source: "revenue_recorded or fee on GET /admin/transactions" },
      { label: "Merchant settlements", available: settlements !== null, source: "settlement or payout service codes" },
      { label: "QR codes generated", available: Array.isArray(qrItems), source: "GET /admin/qr-assets" },
      { label: "Active sessions and devices", available: Boolean(security.adminSessions), source: "adminSessions on GET /admin/security" },
      { label: "System health", available: systemHealth !== null, source: "GET /admin/module-health" },
    ])}
  `;
}

/* == Financial ============================================================ */

function renderFinancial(snapshot) {
  const { range, tx, merchants, wallets } = coreDerived(snapshot);
  const current = tx.current;
  const revenueModule = snapshot.raw.revenue?.ok ? snapshot.raw.revenue.data : {};
  const revenueReader = (row) => READ.txRevenue(row) || READ.txFee(row);

  let dailyRevenue = dailySeries(current, READ.txDate, revenueReader, range);
  let revenueOrigin = "transaction rows";
  if (!dailyRevenue.some((point) => point.value) && Array.isArray(revenueModule.daily) && revenueModule.daily.length) {
    dailyRevenue = revenueModule.daily
      .map((row) => ({ key: String(row.day || "").slice(0, 10), label: shortDay(String(row.day || "").slice(0, 10)), value: num(row.total) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    revenueOrigin = "GET /admin/revenue daily series";
  }

  const monthlyRevenue = monthlySeries(current, READ.txDate, revenueReader);
  const yearlyRevenue = yearlySeries(current, READ.txDate, revenueReader);
  const volume = dailySeries(current, READ.txDate, null, range);

  const walletCreated = wallets.some((row) => firstDate(row, DATE_KEYS.created));
  const walletGrowth = walletCreated
    ? cumulativeSeries(dailySeries(wallets, (row) => firstDate(row, DATE_KEYS.created), null, range), wallets.filter((row) => {
      const created = firstDate(row, DATE_KEYS.created);
      return created && created < range.from;
    }).length)
    : [];

  const merchantCreated = merchants.some((row) => firstDate(row, DATE_KEYS.created));
  const merchantGrowth = merchantCreated
    ? cumulativeSeries(dailySeries(merchants, (row) => firstDate(row, DATE_KEYS.created), null, range), merchants.filter((row) => {
      const created = firstDate(row, DATE_KEYS.created);
      return created && created < range.from;
    }).length)
    : [];

  const serviceRows = (Array.isArray(revenueModule.byService) && revenueModule.byService.length
    ? revenueModule.byService.map((row) => ({ label: titleCase(row.service_type || row.service_code || "Service"), value: num(row.total) }))
    : groupSum(current, READ.txServiceName, revenueReader, { limit: 10 }).map((row) => ({ label: titleCase(row.label), value: row.value }))
  ).filter((row) => row.value > 0).sort((a, b) => b.value - a.value);

  const settlementRows = current.filter((row) => /settle|payout/i.test([READ.txService(row), READ.txServiceName(row), READ.txMethod(row)].join(" ")));
  const refundRows = current.filter(isReversed);
  const depositRows = current.filter((row) => txCategory(row) === "Deposits");
  const withdrawalRows = current.filter((row) => txCategory(row) === "Withdrawals");

  const cashIn = dailySeries(depositRows, READ.txDate, READ.txAmount, range);
  const cashOut = dailySeries(withdrawalRows, READ.txDate, READ.txAmount, range);

  const revenueWallet = revenueModule.wallet ? num(revenueModule.wallet.available_balance) : null;

  const cards = [
    kpi("Revenue in Range", fmtMoney(revenueValue(current)), { sub: `From ${revenueOrigin}`, trend: trendBadge(revenueValue(current), revenueValue(tx.previous)) }),
    kpi("Platform Fees", fmtMoney(current.length ? sum(current, READ.txFee) : null), { sub: "Fee income on settled movement" }),
    kpi("Revenue Wallet", fmtMoney(revenueWallet), { sub: "Available balance", source: "wallet on GET /admin/revenue" }),
    kpi("Wallet Balance Float", fmtMoney(wallets.length ? sum(wallets, READ.walletBalance) : null), { sub: "Available plus reserved" }),
    kpi("Settlement Value", fmtMoney(settlementRows.length ? sum(settlementRows, READ.txAmount) : null), { sub: `${fmtInt(settlementRows.length)} movements`, source: "settlement service codes" }),
    kpi("Refunds and Reversals", fmtMoney(refundRows.length ? sum(refundRows, READ.txAmount) : null), { sub: `${fmtInt(refundRows.length)} transactions`, tone: refundRows.length ? "orange" : "green" }),
    kpi("Cash In", fmtMoney(depositRows.length ? sum(depositRows, READ.txAmount) : null), { sub: "Deposits and top-ups", tone: "green" }),
    kpi("Cash Out", fmtMoney(withdrawalRows.length ? sum(withdrawalRows, READ.txAmount) : null), { sub: "Withdrawals and payouts" }),
  ];

  state.datasets = [
    { name: "Revenue by day", columns: ["day", "revenue"], rows: dailyRevenue.map((point) => ({ day: point.key || point.label, revenue: point.value })) },
    { name: "Revenue by month", columns: ["month", "revenue"], rows: monthlyRevenue.map((point) => ({ month: point.key, revenue: point.value })) },
    { name: "Revenue by service", columns: ["service", "revenue"], rows: serviceRows.map((row) => ({ service: row.label, revenue: row.value })) },
    { name: "Cash flow", columns: ["day", "cash_in", "cash_out"], rows: cashIn.map((point, index) => ({ day: point.key, cash_in: point.value, cash_out: cashOut[index]?.value ?? 0 })) },
  ];

  return `
    ${kpiGrid(cards)}
    <section class="tp-chart-grid tp-chart-grid-2">
      ${areaChart({ title: "Revenue by day", note: `Source: ${revenueOrigin}.`, meta: range.label, series: [{ name: "Revenue", points: dailyRevenue }], valueFormat: fmtMoney })}
      ${barChart({ title: "Revenue by month", note: "Monthly totals across the transactions returned for this range.", series: [{ name: "Revenue", points: monthlyRevenue, colour: 1 }], valueFormat: fmtMoney, emptyMessage: "No dated transactions to group by month." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${barChart({ title: "Revenue by year", note: "Annual totals across the same set.", series: [{ name: "Revenue", points: yearlyRevenue, colour: 3 }], valueFormat: fmtMoney, emptyMessage: "No dated transactions to group by year." })}
      ${lineChart({ title: "Transaction volume", note: "Count of transactions per day.", series: [{ name: "Transactions", points: volume, colour: 2 }] })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${areaChart({ title: "Wallet growth", note: "Cumulative wallets on the platform.", series: [{ name: "Wallets", points: walletGrowth, colour: 4 }], emptyMessage: "Wallet records do not carry a created_at date." })}
      ${areaChart({ title: "Merchant growth", note: "Cumulative verified and pending merchants.", series: [{ name: "Merchants", points: merchantGrowth, colour: 5 }], emptyMessage: "Merchant records do not carry a created_at date." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${rankedBarChart({ title: "Top revenue services", note: "Ranked by collected revenue.", rows: serviceRows, valueFormat: fmtMoney, emptyMessage: "No service revenue reported for this range." })}
      ${lineChart({ title: "Settlement trends", note: "Settlement and payout value per day.", series: [{ name: "Settlements", points: dailySeries(settlementRows, READ.txDate, READ.txAmount, range), colour: 6 }], valueFormat: fmtMoney, emptyMessage: "No settlement or payout transactions in this range." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${barChart({ title: "Refund trends", note: "Reversed, refunded and charged-back value per day.", series: [{ name: "Refunds", points: dailySeries(refundRows, READ.txDate, READ.txAmount, range), colour: 7 }], valueFormat: fmtMoney, emptyMessage: "No reversals in this range." })}
      ${barChart({ title: "Cash flow overview", note: "Money in against money out, per day.", series: [
        { name: "Cash in", points: cashIn, colour: 3 },
        { name: "Cash out", points: cashOut, colour: 7 },
      ], valueFormat: fmtMoney, emptyMessage: "No deposit or withdrawal transactions in this range." })}
    </section>
    ${analyticsTable({
      title: "Revenue by service",
      note: "The same ranking as the chart, with the exact figures.",
      columns: [
        { label: "Service", render: (row) => `<strong>${esc(row.label)}</strong>` },
        { label: "Revenue", render: (row) => esc(fmtMoney(row.value)) },
        { label: "Share", render: (row) => esc(fmtPct(safeRatio(row.value, sum(serviceRows, (entry) => entry.value)))) },
      ],
      rows: serviceRows,
      pageKey: "financial-services",
      emptyMessage: "The API returned no service revenue for this range.",
    })}
    ${coverageCard([
      { label: "Revenue series", available: dailyRevenue.some((point) => point.value), source: "revenue_recorded on transactions or GET /admin/revenue" },
      { label: "Wallet growth", available: walletCreated, source: "created_at on GET /admin/wallets" },
      { label: "Merchant growth", available: merchantCreated, source: "created_at on GET /admin/merchants" },
      { label: "Settlement trends", available: settlementRows.length > 0, source: "settlement or payout service codes" },
      { label: "Refund trends", available: refundRows.length > 0, source: "reversed or refunded transaction status" },
      { label: "Cash flow", available: depositRows.length > 0 || withdrawalRows.length > 0, source: "deposit and withdrawal service codes" },
      { label: "Revenue wallet", available: revenueWallet !== null, source: "wallet on GET /admin/revenue" },
    ])}
  `;
}

/* == Users ================================================================ */

function renderUserAnalytics(snapshot) {
  const { range, users, tx } = coreDerived(snapshot);
  const createdKnown = users.some((row) => READ.userCreated(row));
  const activityKnown = users.some((row) => READ.userActivity(row));

  const signups = createdKnown ? dailySeries(users, READ.userCreated, null, range) : [];
  const priorUsers = createdKnown ? users.filter((row) => {
    const created = READ.userCreated(row);
    return created && created < range.from;
  }).length : 0;
  const growth = createdKnown ? cumulativeSeries(signups, priorUsers) : [];

  const returning = activityKnown && createdKnown
    ? (() => {
      let repeat = 0;
      let single = 0;
      users.forEach((row) => {
        const created = READ.userCreated(row);
        const seen = READ.userActivity(row);
        if (!created || !seen) return;
        if (seen.getTime() - created.getTime() > 86400000) repeat += 1;
        else single += 1;
      });
      return [{ label: "Returning", value: repeat }, { label: "Single session", value: single }];
    })()
    : [];

  const retention = activityKnown && createdKnown
    ? (() => {
      const cohorts = new Map();
      users.forEach((row) => {
        const created = READ.userCreated(row);
        const seen = READ.userActivity(row);
        if (!created) return;
        const key = monthKey(created);
        const cohort = cohorts.get(key) || { size: 0, retained: 0 };
        cohort.size += 1;
        if (seen && seen.getTime() - created.getTime() > 30 * 86400000) cohort.retained += 1;
        cohorts.set(key, cohort);
      });
      return [...cohorts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-12)
        .map(([key, cohort]) => ({ label: shortMonth(key), value: num(safeRatio(cohort.retained, cohort.size)) }));
    })()
    : [];

  const devices = distribution(users, READ.userDevice);
  const browsers = distribution(users, READ.userBrowser);
  const operatingSystems = distribution(users, READ.userOs);
  const provinces = distribution(users, READ.userProvince, { canon: canonicalProvince, limit: 12 });
  const cities = distribution(users, READ.userCity, { limit: 25 });
  const languages = distribution(users, READ.userLanguage);
  const ages = (() => {
    const buckets = [["18-24", 18, 24], ["25-34", 25, 34], ["35-44", 35, 44], ["45-54", 45, 54], ["55-64", 55, 64], ["65+", 65, 200]];
    const counts = buckets.map(([label]) => ({ label, value: 0 }));
    let seen = 0;
    users.forEach((row) => {
      const age = READ.userAge(row);
      if (age === null) return;
      seen += 1;
      const index = buckets.findIndex(([, low, high]) => age >= low && age <= high);
      if (index >= 0) counts[index].value += 1;
    });
    return seen ? counts : null;
  })();

  const accountTypes = distribution(users, (row) => firstValue(row, ["account_type", "type"]) || "");
  const ficaStates = distribution(users, (row) => firstValue(row, ["fica_status"]) || "");

  const newInRange = createdKnown ? users.filter((row) => inRange(READ.userCreated(row), range.from, range.to)).length : null;
  const newPrevious = createdKnown ? users.filter((row) => inRange(READ.userCreated(row), range.previousFrom, range.previousTo)).length : null;

  const cards = [
    kpi("Total Users", fmtInt(users.length || null), { sub: "Accounts returned by the API" }),
    kpi("New Users in Range", fmtInt(newInRange), { sub: range.label, trend: trendBadge(newInRange, newPrevious), source: "created_at on GET /admin/users" }),
    kpi("Active (30 Days)", fmtInt(activityWindow(users, 30) ?? activeFromTransactions(tx.all, addDays(startOfDay(new Date()), -29), range.to)), { sub: activityKnown ? "Seen in the last 30 days" : "Distinct transacting identities" }),
    kpi("Returning Users", fmtInt(returning.length ? returning[0].value : null), { sub: "Active more than a day after signing up", source: "created_at and last_seen_at" }),
    kpi("Provinces Covered", fmtInt(provinces ? provinces.length : null), { sub: "Distinct provinces on file", source: "province on GET /admin/users" }),
    kpi("Cities Covered", fmtInt(cities ? cities.length : null), { sub: "Distinct cities on file", source: "city on GET /admin/users" }),
    kpi("Verified (FICA)", fmtInt(ficaStates ? (ficaStates.find((row) => /verified|approved/i.test(row.label))?.value ?? 0) : null), { sub: "FICA verified accounts", tone: "green" }),
    kpi("Locked Profiles", fmtInt(users.length ? users.filter((row) => row.profile_locked).length : null), { sub: "Profile lock currently applied", tone: users.filter((row) => row.profile_locked).length ? "orange" : "green" }),
  ];

  state.datasets = [
    { name: "Daily signups", columns: ["day", "signups"], rows: signups.map((point) => ({ day: point.key, signups: point.value })) },
    { name: "Province breakdown", columns: ["province", "users"], rows: (provinces || []).map((row) => ({ province: row.label, users: row.value })) },
    { name: "City breakdown", columns: ["city", "users"], rows: (cities || []).map((row) => ({ city: row.label, users: row.value })) },
  ];

  return `
    ${kpiGrid(cards)}
    <section class="tp-chart-grid tp-chart-grid-2">
      ${areaChart({ title: "User growth", note: "Cumulative registered accounts.", meta: range.label, series: [{ name: "Users", points: growth }], emptyMessage: "User records do not carry a created_at date." })}
      ${barChart({ title: "Daily signups", note: "New accounts per day.", series: [{ name: "Signups", points: signups, colour: 3 }], emptyMessage: "User records do not carry a created_at date." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${barChart({ title: "Retention by cohort", note: "Share of each signup month still active after 30 days.", series: [{ name: "Retention", points: retention, colour: 4 }], valueFormat: fmtPct, emptyMessage: "Retention needs both created_at and a last-seen timestamp on user records." })}
      ${donutChart({ title: "Returning users", note: "Accounts that came back after their first day.", rows: returning, emptyMessage: "Needs created_at and a last-seen timestamp on user records." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-3">
      ${donutChart({ title: "Device types", note: "Devices on record for customer accounts.", rows: devices || [], emptyMessage: "User records do not carry a device field." })}
      ${rankedBarChart({ title: "Browser usage", note: "Browsers on record.", rows: browsers || [], emptyMessage: "User records do not carry a browser field." })}
      ${rankedBarChart({ title: "Operating systems", note: "Platforms on record.", rows: operatingSystems || [], emptyMessage: "User records do not carry an operating system field." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${rankedBarChart({ title: "Geographic distribution", note: "Accounts by province.", rows: provinces || [], emptyMessage: "User records do not carry a province field." })}
      ${donutChart({ title: "Language distribution", note: "Preferred language on record.", rows: languages || [], emptyMessage: "User records do not carry a language field." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${barChart({ title: "Age groups", note: "Derived from date of birth where the API provides it.", series: [{ name: "Users", points: ages || [], colour: 6 }], emptyMessage: "User records do not carry a date of birth or age." })}
      ${donutChart({ title: "Account types", note: "Personal against business accounts.", rows: accountTypes || [], emptyMessage: "User records do not carry an account type." })}
    </section>
    ${analyticsTable({
      title: "Province breakdown",
      note: "Registered accounts by province.",
      columns: [
        { label: "Province", render: (row) => `<strong>${esc(row.label)}</strong>` },
        { label: "Users", render: (row) => esc(fmtInt(row.value)) },
        { label: "Share", render: (row) => esc(fmtPct(safeRatio(row.value, users.length))) },
      ],
      rows: provinces || [],
      pageKey: "users-provinces",
      emptyMessage: "The API did not return a province on any user record.",
    })}
    ${analyticsTable({
      title: "City breakdown",
      note: "Registered accounts by city.",
      columns: [
        { label: "City", render: (row) => `<strong>${esc(row.label)}</strong>` },
        { label: "Users", render: (row) => esc(fmtInt(row.value)) },
        { label: "Share", render: (row) => esc(fmtPct(safeRatio(row.value, users.length))) },
      ],
      rows: cities || [],
      pageKey: "users-cities",
      emptyMessage: "The API did not return a city on any user record.",
    })}
    ${coverageCard([
      { label: "User growth and signups", available: createdKnown, source: "created_at on GET /admin/users" },
      { label: "Retention and returning users", available: activityKnown && createdKnown, source: "last_seen_at on GET /admin/users" },
      { label: "Device types", available: Boolean(devices), source: "device_type on GET /admin/users" },
      { label: "Browser usage", available: Boolean(browsers), source: "browser on GET /admin/users" },
      { label: "Operating systems", available: Boolean(operatingSystems), source: "operating_system on GET /admin/users" },
      { label: "Province and city", available: Boolean(provinces) && Boolean(cities), source: "province and city on GET /admin/users" },
      { label: "Language distribution", available: Boolean(languages), source: "language on GET /admin/users" },
      { label: "Age groups", available: Boolean(ages), source: "date_of_birth on GET /admin/users" },
    ])}
  `;
}

/* == Transactions ========================================================= */

function renderTransactionAnalytics(snapshot) {
  const { range, tx } = coreDerived(snapshot);
  const current = tx.current;

  const perMinute = (() => {
    const end = range.to.getTime() > Date.now() ? new Date() : range.to;
    const start = new Date(end.getTime() - 59 * 60000);
    const buckets = new Map();
    for (let minute = new Date(start); minute <= end; minute = new Date(minute.getTime() + 60000)) {
      buckets.set(`${String(minute.getHours()).padStart(2, "0")}:${String(minute.getMinutes()).padStart(2, "0")}`, 0);
    }
    let seen = 0;
    current.forEach((row) => {
      const date = READ.txDate(row);
      if (!date || date < start || date > end) return;
      const key = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      if (buckets.has(key)) {
        buckets.set(key, buckets.get(key) + 1);
        seen += 1;
      }
    });
    return seen ? [...buckets.entries()].map(([label, value]) => ({ label, value })) : [];
  })();

  const hourly = (() => {
    const counts = Array.from({ length: 24 }, (_, hour) => ({ label: `${String(hour).padStart(2, "0")}:00`, value: 0 }));
    let seen = 0;
    current.forEach((row) => {
      const date = READ.txDate(row);
      if (!date) return;
      counts[date.getHours()].value += 1;
      seen += 1;
    });
    return seen ? counts : [];
  })();

  const daily = dailySeries(current, READ.txDate, null, range);
  const monthly = monthlySeries(current, READ.txDate, null);

  const successful = current.filter(isSuccessful).length;
  const failed = current.filter(isFailed).length;
  const reversed = current.filter(isReversed).length;
  const inFlight = current.length - successful - failed - reversed;

  const methods = distribution(current, READ.txMethod);
  const categoryCounts = (() => {
    const counts = new Map();
    current.forEach((row) => {
      const category = txCategory(row);
      counts.set(category, (counts.get(category) || 0) + 1);
    });
    return [...counts.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  })();
  const categoryValue = (name) => categoryCounts.find((row) => row.label === name)?.value ?? 0;

  const processing = current.map(READ.txProcessingMs).filter((value) => value !== null);
  const processingSeries = processing.length
    ? (() => {
      const buckets = new Map();
      current.forEach((row) => {
        const date = READ.txDate(row);
        const ms = READ.txProcessingMs(row);
        if (!date || ms === null) return;
        const key = dayKey(date);
        const bucket = buckets.get(key) || { total: 0, count: 0 };
        bucket.total += ms;
        bucket.count += 1;
        buckets.set(key, bucket);
      });
      return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, bucket]) => ({ key, label: shortDay(key), value: bucket.total / bucket.count }));
    })()
    : [];

  const cards = [
    kpi("Total Transactions", fmtInt(current.length), { sub: range.label, trend: trendBadge(current.length, tx.previous.length) }),
    kpi("Successful", fmtInt(current.length ? successful : null), { sub: fmtPct(safeRatio(successful, current.length)) || "", tone: "green" }),
    kpi("Failed", fmtInt(current.length ? failed : null), { sub: fmtPct(safeRatio(failed, current.length)) || "", tone: failed ? "red" : "green" }),
    kpi("Reversed", fmtInt(current.length ? reversed : null), { sub: fmtPct(safeRatio(reversed, current.length)) || "", tone: reversed ? "orange" : "green" }),
    kpi("QR Payments", fmtInt(current.length ? categoryValue("QR Payments") : null), { sub: "Transactions routed through a QR code" }),
    kpi("Wallet Transfers", fmtInt(current.length ? categoryValue("Wallet Transfers") : null), { sub: "Wallet to wallet movement" }),
    kpi("Merchant Payments", fmtInt(current.length ? categoryValue("Merchant Payments") : null), { sub: "Paid to a merchant or till" }),
    kpi("Withdrawals", fmtInt(current.length ? categoryValue("Withdrawals") : null), { sub: "Cash out and payouts" }),
    kpi("Deposits", fmtInt(current.length ? categoryValue("Deposits") : null), { sub: "Top-ups and cash in" }),
    kpi("Average Value", fmtMoney(current.length ? sum(current, READ.txAmount) / current.length : null), { sub: "Mean transaction amount" }),
    kpi("Average Processing Time", fmtMs(processing.length ? processing.reduce((total, value) => total + value, 0) / processing.length : null), { sub: "Created to settled", source: "completed_at or processing_ms on transactions" }),
    kpi("Peak Hour", hourly.length ? hourly.reduce((best, row) => (row.value > best.value ? row : best), hourly[0]).label : null, { sub: "Busiest hour in range", source: "created_at on transactions" }),
  ];

  state.datasets = [
    { name: "Daily activity", columns: ["day", "transactions"], rows: daily.map((point) => ({ day: point.key, transactions: point.value })) },
    { name: "Hourly activity", columns: ["hour", "transactions"], rows: hourly.map((point) => ({ hour: point.label, transactions: point.value })) },
    { name: "Categories", columns: ["category", "transactions"], rows: categoryCounts.map((row) => ({ category: row.label, transactions: row.value })) },
  ];

  return `
    ${kpiGrid(cards)}
    <section class="tp-chart-grid tp-chart-grid-2">
      ${lineChart({ title: "Transactions per minute", note: "The last sixty minutes of the selected range.", series: [{ name: "Transactions", points: perMinute, colour: 2 }], emptyMessage: "No transactions in the last sixty minutes of this range." })}
      ${barChart({ title: "Hourly activity", note: "Transactions by hour of day across the range.", series: [{ name: "Transactions", points: hourly, colour: 1 }], emptyMessage: "Transaction records do not carry a created_at time." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${lineChart({ title: "Daily activity", note: "Transactions per day.", series: [{ name: "Transactions", points: daily, colour: 3 }] })}
      ${barChart({ title: "Monthly activity", note: "Transactions per month across the returned set.", series: [{ name: "Transactions", points: monthly, colour: 4 }], emptyMessage: "No dated transactions to group by month." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${donutChart({ title: "Success against failure", note: "Final state of every transaction in range.", rows: [
        { label: "Successful", value: successful },
        { label: "Failed", value: failed },
        { label: "Reversed", value: reversed },
        { label: "In flight", value: Math.max(0, inFlight) },
      ].filter((row) => row.value > 0), emptyMessage: "No transactions in this range." })}
      ${rankedBarChart({ title: "Payment methods", note: "Method or financial route recorded against each transaction.", rows: methods || [], emptyMessage: "Transaction records do not carry a payment method or route." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${rankedBarChart({ title: "Transaction mix", note: "QR, wallet, merchant, withdrawal and deposit movement.", rows: categoryCounts, emptyMessage: "No transactions in this range." })}
      ${lineChart({ title: "Average processing time", note: "Mean time from creation to settlement, per day.", series: [{ name: "Processing time", points: processingSeries, colour: 6 }], valueFormat: fmtMs, emptyMessage: "Transaction records do not carry a settlement timestamp or processing duration." })}
    </section>
    ${analyticsTable({
      title: "Transactions in range",
      note: "The rows behind every chart on this page, newest first.",
      columns: [
        { label: "Reference", render: (row) => `<strong>${esc(row.reference || row.id || "-")}</strong><br><small>${esc(READ.txDate(row) ? READ.txDate(row).toLocaleString("en-ZA") : "-")}</small>` },
        { label: "Service", render: (row) => `${esc(titleCase(READ.txServiceName(row) || "-"))}<br><small>${esc(txCategory(row))}</small>` },
        { label: "Amount", render: (row) => `${esc(fmtMoney(READ.txAmount(row)))}<br><small>Fee ${esc(fmtMoney(READ.txFee(row)))}</small>` },
        { label: "Revenue", render: (row) => esc(fmtMoney(READ.txRevenue(row))) },
        { label: "Status", render: (row) => `<span class="chip ${esc(HOST.chipClass(READ.txStatus(row)))}">${esc(READ.txStatus(row) || "-")}</span>` },
      ],
      rows: [...current].sort((a, b) => (READ.txDate(b)?.getTime() || 0) - (READ.txDate(a)?.getTime() || 0)),
      pageKey: "transactions-rows",
      emptyMessage: "The API returned no transactions for this range and filter set.",
    })}
    ${coverageCard([
      { label: "Per minute and hourly activity", available: hourly.length > 0, source: "created_at on GET /admin/transactions" },
      { label: "Payment methods", available: Boolean(methods), source: "payment_method or financial_route on transactions" },
      { label: "Average processing time", available: processing.length > 0, source: "completed_at or processing_ms on transactions" },
    ])}
  `;
}

/* == Merchants ============================================================ */

function renderMerchantAnalytics(snapshot) {
  const { range, tx, merchants } = coreDerived(snapshot);
  const current = tx.current;
  const reviews = snapshot.extras.reviews?.ok ? itemsOf(snapshot.extras.reviews, "reviews") : null;
  const qrAssets = snapshot.extras.qr?.ok ? itemsOf(snapshot.extras.qr, "assets") : null;

  const merchantRows = current.filter((row) => READ.txMerchant(row));
  const merchantIndex = new Map();
  merchants.forEach((row) => {
    [row.merchant_number, row.business_name, row.username].filter(Boolean).forEach((key) => merchantIndex.set(lower(key), row));
  });

  const byMerchant = (() => {
    const totals = new Map();
    merchantRows.forEach((row) => {
      const key = READ.txMerchant(row);
      const entry = totals.get(key) || { key, volume: 0, value: 0, revenue: 0, qr: 0, lastSeen: null };
      entry.volume += 1;
      entry.value += READ.txAmount(row);
      entry.revenue += READ.txRevenue(row) || READ.txFee(row);
      if (row.qr_reference) entry.qr += 1;
      const date = READ.txDate(row);
      if (date && (!entry.lastSeen || date > entry.lastSeen)) entry.lastSeen = date;
      totals.set(key, entry);
    });
    return [...totals.values()].map((entry) => {
      const record = merchantIndex.get(lower(entry.key));
      return {
        ...entry,
        name: record?.business_name || entry.key,
        verification: record?.verification_status || "",
        status: record?.status || "",
      };
    }).sort((a, b) => b.value - a.value);
  })();

  const merchantCreated = merchants.some((row) => firstDate(row, DATE_KEYS.created));
  const growth = merchantCreated
    ? cumulativeSeries(dailySeries(merchants, (row) => firstDate(row, DATE_KEYS.created), null, range), merchants.filter((row) => {
      const created = firstDate(row, DATE_KEYS.created);
      return created && created < range.from;
    }).length)
    : [];

  const activity = (() => {
    const buckets = new Map();
    merchantRows.forEach((row) => {
      const date = READ.txDate(row);
      if (!date || !inRange(date, range.from, range.to)) return;
      const key = dayKey(date);
      const set = buckets.get(key) || new Set();
      set.add(lower(READ.txMerchant(row)));
      buckets.set(key, set);
    });
    return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, set]) => ({ key, label: shortDay(key), value: set.size }));
  })();

  const qrRows = current.filter((row) => row.qr_reference || /qr/i.test([READ.txService(row), READ.txServiceName(row)].join(" ")));
  const marketplaceRows = current.filter((row) => /marketplace|store|shop|catalogue/i.test([READ.txService(row), READ.txServiceName(row)].join(" ")));
  const queueRows = current.filter((row) => /queue|smart[_\s-]?queue|booking/i.test([READ.txService(row), READ.txServiceName(row)].join(" ")));
  const payoutRows = current.filter((row) => /payout|settle/i.test([READ.txService(row), READ.txServiceName(row), READ.txMethod(row)].join(" ")));

  const storeVisits = (() => {
    const values = merchants.map((row) => firstValue(row, ["store_visits", "storeVisits", "visits", "profile_views"])).filter(isNumeric);
    return values.length ? sum(values) : null;
  })();

  const queueUsage = (() => {
    const values = merchants.map((row) => firstValue(row, ["smart_queue_sessions", "queue_sessions", "queue_usage"])).filter(isNumeric);
    if (values.length) return sum(values);
    return queueRows.length || null;
  })();

  const ratingValues = reviews
    ? reviews.map((row) => firstValue(row, ["rating", "score", "stars"])).filter(isNumeric).map(num)
    : [];
  const ratingDistribution = ratingValues.length
    ? [5, 4, 3, 2, 1].map((star) => ({ label: `${star} star`, value: ratingValues.filter((value) => Math.round(value) === star).length })).filter((row) => row.value > 0)
    : [];

  const verified = merchants.filter((row) => lower(row.verification_status) === "verified").length;

  const cards = [
    kpi("Merchants on Record", fmtInt(merchants.length || null), { sub: "Returned by the merchants module" }),
    kpi("Verified Merchants", fmtInt(merchants.length ? verified : null), { sub: fmtPct(safeRatio(verified, merchants.length)) || "", tone: "green" }),
    kpi("Trading Merchants", fmtInt(byMerchant.length || null), { sub: `Transacted in ${range.label.toLowerCase()}`, source: "merchant_number on transactions" }),
    kpi("Merchant Revenue", fmtMoney(byMerchant.length ? sum(byMerchant, (row) => row.revenue) : null), { sub: "Platform revenue on merchant movement" }),
    kpi("Merchant Turnover", fmtMoney(byMerchant.length ? sum(byMerchant, (row) => row.value) : null), { sub: "Value processed by merchants" }),
    kpi("QR Usage", fmtInt(qrRows.length || null), { sub: "Transactions carrying a QR reference" }),
    kpi("QR Assets Issued", fmtInt(qrAssets ? qrAssets.length : null), { sub: "QR codes on record", source: "GET /admin/qr-assets" }),
    kpi("Store Visits", fmtInt(storeVisits), { sub: "Storefront views", source: "store_visits on GET /admin/merchants" }),
    kpi("Smart Queue Usage", fmtInt(queueUsage), { sub: "Queue sessions or queue transactions", source: "smart_queue_sessions on merchants" }),
    kpi("Marketplace Sales", fmtMoney(marketplaceRows.length ? sum(marketplaceRows, READ.txAmount) : null), { sub: `${fmtInt(marketplaceRows.length)} orders`, source: "marketplace service codes" }),
    kpi("Merchant Ratings", ratingValues.length ? decimalFormatter.format(sum(ratingValues) / ratingValues.length) : null, { sub: ratingValues.length ? `${fmtInt(ratingValues.length)} ratings` : "", source: "GET /admin/marketing/reviews" }),
    kpi("Merchant Payouts", fmtMoney(payoutRows.length ? sum(payoutRows, READ.txAmount) : null), { sub: `${fmtInt(payoutRows.length)} payouts`, source: "payout or settlement service codes" }),
  ];

  state.datasets = [
    {
      name: "Top merchants",
      columns: ["merchant", "transactions", "value", "revenue", "qr_transactions"],
      rows: byMerchant.map((row) => ({ merchant: row.name, transactions: row.volume, value: row.value, revenue: row.revenue, qr_transactions: row.qr })),
    },
    { name: "Merchant activity", columns: ["day", "active_merchants"], rows: activity.map((point) => ({ day: point.key, active_merchants: point.value })) },
  ];

  return `
    ${kpiGrid(cards)}
    <section class="tp-chart-grid tp-chart-grid-2">
      ${rankedBarChart({ title: "Merchant revenue", note: "Merchants ranked by platform revenue generated.", rows: byMerchant.map((row) => ({ label: row.name, value: row.revenue })).filter((row) => row.value > 0), valueFormat: fmtMoney, emptyMessage: "No merchant revenue in this range." })}
      ${rankedBarChart({ title: "Top merchants by turnover", note: "Value processed per merchant.", rows: byMerchant.map((row) => ({ label: row.name, value: row.value })), valueFormat: fmtMoney, emptyMessage: "No merchant transactions in this range." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${areaChart({ title: "Merchant growth", note: "Cumulative merchants on the platform.", series: [{ name: "Merchants", points: growth, colour: 5 }], emptyMessage: "Merchant records do not carry a created_at date." })}
      ${lineChart({ title: "Merchant activity", note: "Distinct merchants trading each day.", series: [{ name: "Active merchants", points: activity, colour: 2 }], emptyMessage: "No merchant transactions in this range." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${lineChart({ title: "QR usage", note: "QR transactions per day.", series: [{ name: "QR transactions", points: dailySeries(qrRows, READ.txDate, null, range), colour: 3 }], emptyMessage: "No QR transactions in this range." })}
      ${donutChart({ title: "Merchant ratings", note: "Distribution of customer ratings.", rows: ratingDistribution, emptyMessage: "No rating field on the reviews the API returned." })}
    </section>
    ${analyticsTable({
      title: "Top merchants",
      note: "Every trading merchant in range, ranked by value processed.",
      columns: [
        { label: "Merchant", render: (row) => `<strong>${esc(row.name)}</strong><br><small>${esc(row.key)}</small>` },
        { label: "Transactions", render: (row) => esc(fmtInt(row.volume)) },
        { label: "Value", render: (row) => esc(fmtMoney(row.value)) },
        { label: "Revenue", render: (row) => esc(fmtMoney(row.revenue)) },
        { label: "QR", render: (row) => esc(fmtInt(row.qr)) },
        { label: "Verification", render: (row) => row.verification ? `<span class="chip ${esc(HOST.chipClass(row.verification))}">${esc(row.verification)}</span>` : "-" },
        { label: "Last seen", render: (row) => esc(row.lastSeen ? row.lastSeen.toLocaleString("en-ZA") : "-") },
      ],
      rows: byMerchant,
      pageKey: "merchants-top",
      emptyMessage: "No transaction in this range carried a merchant reference.",
    })}
    ${coverageCard([
      { label: "Merchant attribution", available: byMerchant.length > 0, source: "merchant_number on GET /admin/transactions" },
      { label: "Merchant growth", available: merchantCreated, source: "created_at on GET /admin/merchants" },
      { label: "Store visits", available: storeVisits !== null, source: "store_visits on GET /admin/merchants" },
      { label: "Smart queue usage", available: queueUsage !== null, source: "smart_queue_sessions on merchants or queue service codes" },
      { label: "Marketplace sales", available: marketplaceRows.length > 0, source: "marketplace service codes on transactions" },
      { label: "Merchant ratings", available: ratingValues.length > 0, source: "GET /admin/marketing/reviews" },
      { label: "Merchant payouts", available: payoutRows.length > 0, source: "payout or settlement service codes" },
    ])}
  `;
}

/* == Fraud and security =================================================== */

function renderRiskAnalytics(snapshot) {
  const { range, tx, users } = coreDerived(snapshot);
  const security = snapshot.raw.security?.ok ? snapshot.raw.security.data : {};
  const audit = snapshot.extras.audit?.ok ? itemsOf(snapshot.extras.audit) : [];
  const loginAttempts = security.loginAttempts || [];
  const profileLockEvents = security.profileLockEvents || [];
  const sessions = security.adminSessions || [];

  const failedLogins = loginAttempts.filter((row) => /fail|invalid|denied|lock/i.test([row.action, row.status, row.result].join(" ")));
  const failedSeries = dailySeries(failedLogins, (row) => firstDate(row, DATE_KEYS.created), null, range);

  const lockedProfiles = users.filter((row) => row.profile_locked);
  const activeSessions = sessions.filter((row) => !row.revoked_at);

  const deviceOwners = new Map();
  const accountDevices = new Map();
  sessions.forEach((row) => {
    const device = lower(row.device_name || row.platform || "");
    const account = lower(row.email || row.full_name || row.admin_id || "");
    if (!device || !account) return;
    const owners = deviceOwners.get(device) || new Set();
    owners.add(account);
    deviceOwners.set(device, owners);
    const devices = accountDevices.get(account) || new Set();
    devices.add(device);
    accountDevices.set(account, devices);
  });
  const suspiciousDevices = sessions.length ? [...deviceOwners.values()].filter((owners) => owners.size > 1).length : null;
  const multipleDeviceLogins = sessions.length ? [...accountDevices.values()].filter((devices) => devices.size > 1).length : null;

  const riskReader = (row) => {
    const value = firstValue(row, ["risk_score", "riskScore", "fraud_score"]);
    return isNumeric(value) ? num(value) : null;
  };
  const riskRows = tx.current.filter((row) => riskReader(row) !== null);
  const riskSeries = riskRows.length
    ? (() => {
      const buckets = new Map();
      riskRows.forEach((row) => {
        const date = READ.txDate(row);
        if (!date) return;
        const key = dayKey(date);
        const bucket = buckets.get(key) || { total: 0, count: 0 };
        bucket.total += riskReader(row);
        bucket.count += 1;
        buckets.set(key, bucket);
      });
      return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, bucket]) => ({ key, label: shortDay(key), value: bucket.total / bucket.count }));
    })()
    : [];

  const highRisk = tx.current.filter((row) => {
    const score = riskReader(row);
    if (score !== null) return score >= 70;
    return /high/i.test(String(firstValue(row, ["risk_rating", "riskRating", "risk_level"]) || "")) || lower(row.reconciliation_status) === "review";
  });

  const fraudAlerts = audit.filter((row) => /fraud|suspicious|alert|blocked|abuse/i.test([row.action, row.target_type].join(" ")));
  const remoteLogouts = audit.filter((row) => /logout[_\s-]?all|remote[_\s-]?logout|revoke[_\s-]?session/i.test(String(row.action || "")));

  const heat = (() => {
    const rows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const matrix = rows.map(() => Array.from({ length: 24 }, () => 0));
    let seen = 0;
    loginAttempts.forEach((row) => {
      const date = firstDate(row, DATE_KEYS.created);
      if (!date) return;
      matrix[date.getDay()][date.getHours()] += 1;
      seen += 1;
    });
    return { matrix, rows, seen };
  })();

  const cards = [
    kpi("Failed Login Attempts", fmtInt(loginAttempts.length ? failedLogins.length : null), { sub: "Recorded sign-in failures", tone: failedLogins.length ? "orange" : "green", source: "loginAttempts on GET /admin/security" }),
    kpi("Locked Accounts", fmtInt(users.length ? lockedProfiles.length : null), { sub: "Customer profiles currently locked", tone: lockedProfiles.length ? "red" : "green" }),
    kpi("Suspicious Devices", fmtInt(suspiciousDevices), { sub: "Devices seen under more than one account", tone: suspiciousDevices ? "orange" : "green", source: "adminSessions on GET /admin/security" }),
    kpi("Multiple Device Logins", fmtInt(multipleDeviceLogins), { sub: "Accounts signed in on several devices", source: "adminSessions on GET /admin/security" }),
    kpi("High Risk Transactions", fmtInt(tx.current.length ? highRisk.length : null), { sub: "Scored high or flagged for review", tone: highRisk.length ? "orange" : "green" }),
    kpi("Fraud Alerts", fmtInt(audit.length ? fraudAlerts.length : null), { sub: "Fraud-related audit events", tone: fraudAlerts.length ? "red" : "green", source: "GET /admin/audit" }),
    kpi("Remote Logouts", fmtInt(audit.length ? remoteLogouts.length : null), { sub: "Sessions revoked remotely", source: "GET /admin/audit" }),
    kpi("Active Sessions", fmtInt(sessions.length ? activeSessions.length : null), { sub: "Staff sessions not revoked", source: "adminSessions on GET /admin/security" }),
    kpi("Profile Lock Events", fmtInt(profileLockEvents.length || null), { sub: "Lock and unlock actions on record" }),
    kpi("Average Risk Score", riskRows.length ? decimalFormatter.format(sum(riskRows, riskReader) / riskRows.length) : null, { sub: "Mean score on scored transactions", source: "risk_score on GET /admin/transactions" }),
  ];

  state.datasets = [
    { name: "High risk transactions", columns: ["reference", "amount", "status", "risk"], rows: highRisk.map((row) => ({ reference: row.reference || row.id, amount: READ.txAmount(row), status: READ.txStatus(row), risk: firstValue(row, ["risk_score", "risk_rating", "reconciliation_status"]) ?? "" })) },
    { name: "Failed logins by day", columns: ["day", "attempts"], rows: failedSeries.map((point) => ({ day: point.key, attempts: point.value })) },
    { name: "Active sessions", columns: ["admin", "device", "platform", "last_activity"], rows: activeSessions.map((row) => ({ admin: row.full_name || row.email || "", device: row.device_name || "", platform: row.platform || "", last_activity: row.last_activity_at || "" })) },
  ];

  return `
    ${kpiGrid(cards)}
    <section class="tp-chart-grid tp-chart-grid-2">
      ${lineChart({ title: "Failed login attempts", note: "Sign-in failures per day.", series: [{ name: "Failed attempts", points: failedSeries, colour: 7 }], emptyMessage: "The security module returned no dated login attempts." })}
      ${lineChart({ title: "Risk score trend", note: "Mean transaction risk score per day.", series: [{ name: "Risk score", points: riskSeries, colour: 8 }], emptyMessage: "Transaction records do not carry a risk score." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-1">
      ${heat.seen
        ? heatMap({ title: "Login heat map", note: "Sign-in attempts by weekday and hour.", rows: undefined, matrix: heat.matrix, rowLabels: heat.rows, columnLabels: Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")) })
        : chartFrame({ title: "Login heat map", note: "Sign-in attempts by weekday and hour.", empty: true, emptyMessage: "The security module returned no dated login attempts." })}
    </section>
    ${analyticsTable({
      title: "High risk transactions",
      note: "Scored at or above 70, or flagged for reconciliation review.",
      columns: [
        { label: "Reference", render: (row) => `<strong>${esc(row.reference || row.id || "-")}</strong><br><small>${esc(READ.txDate(row) ? READ.txDate(row).toLocaleString("en-ZA") : "-")}</small>` },
        { label: "Amount", render: (row) => esc(fmtMoney(READ.txAmount(row))) },
        { label: "Service", render: (row) => esc(titleCase(READ.txServiceName(row) || "-")) },
        { label: "Risk", render: (row) => esc(String(firstValue(row, ["risk_score", "risk_rating", "reconciliation_status"]) ?? "-")) },
        { label: "Status", render: (row) => `<span class="chip ${esc(HOST.chipClass(READ.txStatus(row)))}">${esc(READ.txStatus(row) || "-")}</span>` },
      ],
      rows: highRisk,
      pageKey: "risk-transactions",
      emptyMessage: "No transaction in this range was scored high or flagged for review.",
    })}
    ${analyticsTable({
      title: "Active sessions",
      note: "Staff sessions that have not been revoked.",
      columns: [
        { label: "Operator", render: (row) => `<strong>${esc(row.full_name || "-")}</strong><br><small>${esc(row.email || "-")}</small>` },
        { label: "Device", render: (row) => `${esc(row.device_name || "Unknown")}<br><small>${esc(row.platform || "-")}</small>` },
        { label: "Last activity", render: (row) => esc(row.last_activity_at || "-") },
      ],
      rows: activeSessions,
      pageKey: "risk-sessions",
      emptyMessage: "The security module did not return admin sessions.",
    })}
    ${coverageCard([
      { label: "Failed login attempts", available: loginAttempts.length > 0, source: "loginAttempts on GET /admin/security" },
      { label: "Suspicious and multi-device logins", available: sessions.length > 0, source: "adminSessions on GET /admin/security" },
      { label: "Risk score trends", available: riskRows.length > 0, source: "risk_score on GET /admin/transactions" },
      { label: "Fraud alerts and remote logouts", available: audit.length > 0, source: "GET /admin/audit" },
      { label: "Login heat map", available: heat.seen > 0, source: "created_at on security login attempts" },
    ])}
  `;
}

/* == Support ============================================================== */

function renderSupportAnalytics(snapshot) {
  const { range } = coreDerived(snapshot);
  const tickets = itemsOf(snapshot.raw.tickets);
  const conversations = itemsOf(snapshot.raw.conversations);
  const chat = snapshot.extras.chat?.ok ? snapshot.extras.chat.data : null;

  const open = tickets.filter((row) => ["open", "in_progress", "pending"].includes(lower(row.status)));
  const closed = tickets.filter((row) => ["resolved", "closed", "completed"].includes(lower(row.status)));

  const resolutionDurations = tickets.map((row) => {
    const created = firstDate(row, DATE_KEYS.created);
    const resolved = firstDate(row, DATE_KEYS.resolved);
    return created && resolved ? (resolved.getTime() - created.getTime()) / 1000 : null;
  }).filter((value) => value !== null && value >= 0);

  const responseDurations = tickets.concat(conversations).map((row) => {
    const value = firstValue(row, ["first_response_seconds", "response_time_seconds", "firstResponseSeconds", "waitingSeconds"]);
    return isNumeric(value) ? num(value) : null;
  }).filter((value) => value !== null);

  const satisfactionValues = tickets.concat(conversations)
    .map((row) => firstValue(row, ["satisfaction", "csat", "rating", "satisfaction_score"]))
    .filter(isNumeric)
    .map(num);

  const escalated = conversations.filter((row) => /escalat/i.test(String(row.status || "")));
  const aiResolved = conversations.filter((row) => {
    const resolvedByBot = firstValue(row, ["resolved_by_bot", "ai_resolved", "bot_resolved"]);
    if (resolvedByBot !== undefined) return Boolean(resolvedByBot);
    const assigned = row.assignedAgent || row.metadata?.assigned_to || row.metadata?.assignedTo;
    return ["resolved", "closed"].includes(lower(row.status)) && !assigned;
  });
  const aiResolutionKnown = conversations.length > 0;

  const chatVolume = dailySeries(conversations, (row) => firstDate(row, DATE_KEYS.created) || firstDate(row, DATE_KEYS.updated), null, range);
  const ticketVolume = dailySeries(tickets, (row) => firstDate(row, DATE_KEYS.created), null, range);

  const categories = distribution(tickets, (row) => firstValue(row, ["category", "topic", "subject_type"]) || "");
  const statuses = distribution(tickets, (row) => firstValue(row, ["status"]) || "");

  const cards = [
    kpi("Tickets Open", fmtInt(tickets.length ? open.length : null), { sub: "Open, pending or in progress", tone: open.length ? "orange" : "green" }),
    kpi("Tickets Closed", fmtInt(tickets.length ? closed.length : null), { sub: "Resolved or closed", tone: "green" }),
    kpi("Average Resolution Time", fmtDuration(resolutionDurations.length ? resolutionDurations.reduce((total, value) => total + value, 0) / resolutionDurations.length : null), { sub: "Created to resolved", source: "resolved_at on GET /admin/support/tickets" }),
    kpi("Customer Satisfaction", satisfactionValues.length ? decimalFormatter.format(satisfactionValues.reduce((total, value) => total + value, 0) / satisfactionValues.length) : null, { sub: satisfactionValues.length ? `${fmtInt(satisfactionValues.length)} responses` : "", source: "satisfaction on tickets or conversations" }),
    kpi("AI Resolution Rate", fmtPct(aiResolutionKnown ? safeRatio(aiResolved.length, conversations.length) : null), { sub: "Conversations closed without an agent", source: "resolved_by_bot on conversations" }),
    kpi("Human Escalations", fmtInt(conversations.length ? escalated.length : null), { sub: "Conversations escalated to an agent", tone: escalated.length ? "orange" : "green" }),
    kpi("Average Response Time", fmtDuration(responseDurations.length ? responseDurations.reduce((total, value) => total + value, 0) / responseDurations.length : null), { sub: "First reply or current wait", source: "first_response_seconds on tickets" }),
    kpi("Chat Volume", fmtInt(conversations.length || null), { sub: "Support conversations on record" }),
  ];

  state.datasets = [
    { name: "Tickets", columns: ["reference", "subject", "status", "assigned", "created"], rows: tickets.map((row) => ({ reference: row.id || "", subject: row.subject || "", status: row.status || "", assigned: row.assigned_to || "", created: row.created_at || "" })) },
    { name: "Chat volume", columns: ["day", "conversations"], rows: chatVolume.map((point) => ({ day: point.key, conversations: point.value })) },
  ];

  return `
    ${kpiGrid(cards)}
    <section class="tp-chart-grid tp-chart-grid-2">
      ${lineChart({ title: "Chat volume", note: "Support conversations opened per day.", series: [{ name: "Conversations", points: chatVolume, colour: 2 }], emptyMessage: "Conversation records do not carry a created_at date." })}
      ${barChart({ title: "Ticket volume", note: "Support tickets raised per day.", series: [{ name: "Tickets", points: ticketVolume, colour: 4 }], emptyMessage: "Ticket records do not carry a created_at date." })}
    </section>
    <section class="tp-chart-grid tp-chart-grid-2">
      ${donutChart({ title: "Tickets open against closed", note: "Current state of every ticket on record.", rows: [
        { label: "Open", value: open.length },
        { label: "Closed", value: closed.length },
        { label: "Other", value: Math.max(0, tickets.length - open.length - closed.length) },
      ].filter((row) => row.value > 0), emptyMessage: "The support module returned no tickets." })}
      ${rankedBarChart({ title: "Ticket categories", note: "Where support demand is coming from.", rows: categories || statuses || [], emptyMessage: "Ticket records do not carry a category." })}
    </section>
    ${chat ? HOST.tableCard(
      "Live chat health",
      HOST.renderKeyValueList(Object.entries(chat).filter(([, value]) => typeof value !== "object").map(([key, value]) => [titleCase(key), String(value)])),
      "Reported by the chat monitor module."
    ) : ""}
    ${analyticsTable({
      title: "Support tickets",
      note: "Every ticket the support module returned.",
      columns: [
        { label: "Subject", render: (row) => `<strong>${esc(row.subject || "-")}</strong><br><small>${esc(row.category || "-")}</small>` },
        { label: "Customer", render: (row) => `${esc(row.full_name || "-")}<br><small>${esc(row.username || "-")}</small>` },
        { label: "Assigned", render: (row) => esc(row.assigned_to || "Unassigned") },
        { label: "Status", render: (row) => `<span class="chip ${esc(HOST.chipClass(row.status))}">${esc(row.status || "-")}</span>` },
        { label: "Raised", render: (row) => esc(firstDate(row, DATE_KEYS.created)?.toLocaleString("en-ZA") || "-") },
      ],
      rows: tickets,
      pageKey: "support-tickets",
      emptyMessage: "The support module returned no tickets.",
    })}
    ${coverageCard([
      { label: "Average resolution time", available: resolutionDurations.length > 0, source: "resolved_at on GET /admin/support/tickets" },
      { label: "Customer satisfaction", available: satisfactionValues.length > 0, source: "satisfaction on tickets or conversations" },
      { label: "AI resolution rate", available: aiResolutionKnown, source: "resolved_by_bot on GET /admin/support/conversations" },
      { label: "Average response time", available: responseDurations.length > 0, source: "first_response_seconds on tickets" },
      { label: "Chat volume", available: chatVolume.some((point) => point.value), source: "created_at on conversations" },
    ])}
  `;
}

/* == System =============================================================== */

function systemGauge(label, value, unit = "%") {
  if (value === null || value === undefined) return kpi(label, null, { source: "Not reported by the API" });
  const percent = Math.max(0, Math.min(100, num(value)));
  return kpi(label, `${decimalFormatter.format(percent)}${unit}`, {
    sub: percent < 70 ? "Within normal range" : percent < 90 ? "Elevated" : "Critical",
    tone: percent < 70 ? "green" : percent < 90 ? "orange" : "red",
  });
}

function renderSystemAnalytics(snapshot) {
  const health = snapshot.raw.health?.ok ? snapshot.raw.health.data : {};
  const tables = health.tables || [];
  const maintenance = snapshot.extras.maintenance?.ok ? snapshot.extras.maintenance.data : null;
  const webhooks = snapshot.extras.webhooks?.ok ? itemsOf(snapshot.extras.webhooks, "webhooks", "deliveries") : null;
  const email = snapshot.extras.email?.ok ? snapshot.extras.email.data : null;

  const metricFrom = (keys) => {
    const found = deepFind(maintenance, keys) ?? deepFind(health, keys) ?? deepFind(email, keys);
    return isNumeric(found) ? num(found) : null;
  };

  const cpu = metricFrom(["cpu_usage", "cpuUsage", "cpu_percent", "cpu"]);
  const ram = metricFrom(["memory_usage", "memoryUsage", "ram_usage", "memory_percent", "memory"]);
  const disk = metricFrom(["disk_usage", "diskUsage", "disk_percent", "disk"]);
  const network = metricFrom(["network_usage", "networkUsage", "network_throughput", "bandwidth"]);
  const cacheHit = metricFrom(["cache_hit_rate", "cacheHitRate", "cache_hits", "cache_hit_ratio"]);

  const healthy = tables.filter((row) => row.exists).length;
  const missing = tables.filter((row) => !row.exists);
  const latencies = [...Object.entries(snapshot.raw), ...Object.entries(snapshot.extras)]
    .map(([name, result]) => ({ name, path: result?.path || "", ms: result?.ms, ok: result?.ok, status: result?.status, message: result?.message }))
    .filter((row) => row.path);

  const webhookRows = webhooks || [];
  const webhookFailed = webhookRows.filter((row) => /fail|error|dead/i.test([row.status, row.state, row.result].join(" "))).length;
  const queueDepth = email ? (isNumeric(deepFind(email, ["queued", "queue_depth", "pending"])) ? num(deepFind(email, ["queued", "queue_depth", "pending"])) : null) : null;
  const jobsFailed = email ? (isNumeric(deepFind(email, ["failed", "failed_jobs", "errors"])) ? num(deepFind(email, ["failed", "failed_jobs", "errors"])) : null) : null;

  const latency = apiLatency(snapshot);
  const reachable = latencies.filter((row) => row.ok).length;

  const cards = [
    kpi("API Health", latencies.length ? `${reachable}/${latencies.length} reachable` : null, { sub: "Admin endpoints answered on this load", tone: reachable === latencies.length ? "green" : "orange" }),
    kpi("API Response Time", fmtMs(latency), { sub: "Median across this page's calls", tone: latency === null ? "" : latency < 400 ? "green" : latency < 1200 ? "orange" : "red" }),
    kpi("Database Health", tables.length ? `${healthy}/${tables.length} tables` : null, { sub: missing.length ? `${missing.length} missing` : "All required tables present", tone: tables.length ? (missing.length ? "red" : "green") : "" }),
    systemGauge("CPU Usage", cpu),
    systemGauge("RAM Usage", ram),
    systemGauge("Disk Usage", disk),
    systemGauge("Network Usage", network),
    kpi("Queue Processing", fmtInt(queueDepth), { sub: "Jobs waiting in the queue", tone: queueDepth ? "orange" : "green", source: "GET /admin/email/dashboard" }),
    kpi("Webhook Deliveries", fmtInt(webhooks ? webhookRows.length : null), { sub: webhooks ? `${fmtInt(webhookFailed)} failed` : "", tone: webhookFailed ? "orange" : "green", source: "GET /admin/integrations/webhooks" }),
    kpi("Background Jobs Failed", fmtInt(jobsFailed), { sub: "Failed background jobs on record", tone: jobsFailed ? "red" : "green", source: "GET /admin/email/dashboard" }),
    systemGauge("Cache Performance", cacheHit),
    kpi("Maintenance Mode", maintenance ? (deepFind(maintenance, ["enabled", "maintenance_mode", "active"]) ? "Enabled" : "Disabled") : null, { sub: "Platform maintenance switch", source: "GET /admin/maintenance" }),
  ];

  state.datasets = [
    { name: "Endpoint latency", columns: ["module", "endpoint", "status", "milliseconds"], rows: latencies.map((row) => ({ module: row.name, endpoint: row.path, status: row.ok ? "ok" : `error ${row.status ?? ""}`.trim(), milliseconds: Math.round(num(row.ms)) })) },
    { name: "Database tables", columns: ["table", "present"], rows: tables.map((row) => ({ table: row.table_name, present: row.exists ? "yes" : "no" })) },
  ];

  return `
    ${kpiGrid(cards)}
    <section class="tp-chart-grid tp-chart-grid-2">
      ${rankedBarChart({ title: "Endpoint response time", note: "Measured on this page load, slowest first.", rows: latencies.filter((row) => row.ok).map((row) => ({ label: row.name, value: Math.round(num(row.ms)) })).sort((a, b) => b.value - a.value), valueFormat: fmtMs, limit: 20, emptyMessage: "No endpoint answered on this load." })}
      ${donutChart({ title: "Database readiness", note: "Required tables reported by the health module.", rows: [
        { label: "Present", value: healthy },
        { label: "Missing", value: missing.length },
      ].filter((row) => row.value > 0), emptyMessage: "The health module returned no table list." })}
    </section>
    ${analyticsTable({
      title: "Admin API calls on this load",
      note: "Every request this page made, with the response time it measured.",
      columns: [
        { label: "Module", render: (row) => `<strong>${esc(titleCase(row.name))}</strong><br><small>${esc(row.path)}</small>` },
        { label: "Result", render: (row) => `<span class="chip ${row.ok ? "green" : "red"}">${esc(row.ok ? "Answered" : `Error ${row.status ?? ""}`.trim())}</span>` },
        { label: "Response time", render: (row) => esc(fmtMs(row.ms)) },
        { label: "Detail", render: (row) => esc(row.ok ? "-" : String(row.message || "").slice(0, 90)) },
      ],
      rows: latencies,
      pageKey: "system-latency",
      emptyMessage: "No requests were recorded for this load.",
    })}
    ${analyticsTable({
      title: "Database tables",
      note: "Required tables and whether the API can see them.",
      columns: [
        { label: "Table", key: "table_name" },
        { label: "Status", render: (row) => `<span class="chip ${row.exists ? "green" : "red"}">${row.exists ? "Present" : "Missing"}</span>` },
      ],
      rows: tables,
      pageKey: "system-tables",
      emptyMessage: "The health module returned no table list.",
    })}
    ${coverageCard([
      { label: "CPU usage", available: cpu !== null, source: "cpu_usage on GET /admin/maintenance" },
      { label: "RAM usage", available: ram !== null, source: "memory_usage on GET /admin/maintenance" },
      { label: "Disk usage", available: disk !== null, source: "disk_usage on GET /admin/maintenance" },
      { label: "Network usage", available: network !== null, source: "network_usage on GET /admin/maintenance" },
      { label: "Queue processing", available: queueDepth !== null, source: "GET /admin/email/dashboard" },
      { label: "Webhook deliveries", available: Array.isArray(webhooks), source: "GET /admin/integrations/webhooks" },
      { label: "Background jobs", available: jobsFailed !== null, source: "GET /admin/email/dashboard" },
      { label: "Cache performance", available: cacheHit !== null, source: "cache_hit_rate on GET /admin/maintenance" },
    ])}
  `;
}

/* == Section dispatch ===================================================== */

const SECTION_RENDERERS = {
  executive: renderExecutive,
  financial: renderFinancial,
  users: renderUserAnalytics,
  transactions: renderTransactionAnalytics,
  merchants: renderMerchantAnalytics,
  risk: renderRiskAnalytics,
  support: renderSupportAnalytics,
  system: renderSystemAnalytics,
};

function unavailableSourcesHtml(snapshot) {
  const failures = Object.entries({ ...snapshot.raw, ...snapshot.extras })
    .filter(([name, result]) => !result?.ok && name !== "analytics")
    .map(([name, result]) => [titleCase(name), `${result?.status ? `Responded ${result.status}` : "No response"} · ${result?.path || ""}`]);
  if (!failures.length) return "";
  return HOST.tableCard(
    "Modules that did not answer",
    HOST.renderKeyValueList(failures),
    "Analytics keeps working without them. The metrics they feed show a dash rather than a guess.",
    `${failures.length} unavailable`
  );
}

function renderSection(snapshot) {
  state.datasets = [];
  const renderer = SECTION_RENDERERS[state.section] || renderExecutive;
  const html = renderer(snapshot);
  HOST.PAGE_EXPORTS.analytics = state.datasets[0]?.rows || [];
  return `${html}${unavailableSourcesHtml(snapshot)}`;
}

/* == Access control =======================================================
   Purely additive: the console's own role rules are untouched. Analytics is
   visible to full-access roles and to any operator whose permission set
   already carries an analytics or reporting grant.
   ======================================================================== */

const ANALYTICS_PERMISSIONS = ["analytics", "reporting", "reports", "analytics_view", "ANALYTICS_VIEW", "REPORTING_VIEW", "REPORTS_VIEW"];

function canAccessAnalytics(me = {}) {
  if (HOST.hasFullAdminAccess(me)) return true;
  if (HOST.isPlatformOwnerRole(me.role || me.admin?.role)) return true;
  const permissions = new Set(me.permissions || me.admin?.permissions || []);
  return ANALYTICS_PERMISSIONS.some((permission) => permissions.has(permission));
}

/* == Export ===============================================================
   CSV reuses the console's own writer. XLSX is written here as a real
   spreadsheet package (stored ZIP entries, one sheet per dataset) so the
   console keeps its "no third-party script" rule and its CSP intact. PDF uses
   the browser's print pipeline against the module's print stylesheet.
   ======================================================================== */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipBlob(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  const writeUint = (view, position, value, bytes) => {
    for (let index = 0; index < bytes; index += 1) view[position + index] = (value >>> (index * 8)) & 0xff;
  };

  entries.forEach((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = encoder.encode(entry.content);
    const checksum = crc32(dataBytes);

    const local = new Uint8Array(30 + nameBytes.length);
    writeUint(local, 0, 0x04034b50, 4);
    writeUint(local, 4, 20, 2);
    writeUint(local, 14, checksum, 4);
    writeUint(local, 18, dataBytes.length, 4);
    writeUint(local, 22, dataBytes.length, 4);
    writeUint(local, 26, nameBytes.length, 2);
    local.set(nameBytes, 30);
    parts.push(local, dataBytes);

    const directory = new Uint8Array(46 + nameBytes.length);
    writeUint(directory, 0, 0x02014b50, 4);
    writeUint(directory, 4, 20, 2);
    writeUint(directory, 6, 20, 2);
    writeUint(directory, 16, checksum, 4);
    writeUint(directory, 20, dataBytes.length, 4);
    writeUint(directory, 24, dataBytes.length, 4);
    writeUint(directory, 28, nameBytes.length, 2);
    writeUint(directory, 42, offset, 4);
    directory.set(nameBytes, 46);
    central.push(directory);

    offset += local.length + dataBytes.length;
  });

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  writeUint(end, 0, 0x06054b50, 4);
  writeUint(end, 8, entries.length, 2);
  writeUint(end, 10, entries.length, 2);
  writeUint(end, 12, centralSize, 4);
  writeUint(end, 16, offset, 4);
  return new Blob([...parts, ...central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")
    // Control characters are not legal in XML 1.0 and Excel rejects the package.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function columnName(index) {
  let name = "";
  let current = index;
  while (current >= 0) {
    name = String.fromCharCode((current % 26) + 65) + name;
    current = Math.floor(current / 26) - 1;
  }
  return name;
}

function sheetXml(rows) {
  const body = rows.map((cells, rowIndex) => `<row r="${rowIndex + 1}">${cells.map((cell, cellIndex) => {
    const reference = `${columnName(cellIndex)}${rowIndex + 1}`;
    if (rowIndex > 0 && typeof cell !== "boolean" && isNumeric(cell)) {
      return `<c r="${reference}" t="n"><v>${Number(cell)}</v></c>`;
    }
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
  }).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function safeSheetName(name, index) {
  const cleaned = String(name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

function downloadXlsx(filename, datasets) {
  const usable = (datasets || []).filter((dataset) => dataset.rows?.length);
  if (!usable.length) {
    HOST.showToast("Nothing to export yet");
    return;
  }
  const sheets = usable.map((dataset, index) => {
    const columns = dataset.columns?.length
      ? dataset.columns
      : [...dataset.rows.reduce((set, row) => {
        Object.keys(row || {}).forEach((key) => set.add(key));
        return set;
      }, new Set())];
    const rows = [columns, ...dataset.rows.map((row) => columns.map((column) => {
      const value = row?.[column];
      return Array.isArray(value) ? value.join(" | ") : value ?? "";
    }))];
    return { name: safeSheetName(dataset.name, index), xml: sheetXml(rows) };
  });

  const entries = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`,
    },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: sheet.xml })),
  ];

  const url = URL.createObjectURL(zipBlob(entries));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportFilename(extension) {
  const range = resolveRange();
  return `titopay-analytics-${state.section}-${rangeIso(range.from)}-to-${rangeIso(range.to)}.${extension}`;
}

function runExport(format) {
  const datasets = state.datasets || [];
  if (format === "csv") {
    HOST.downloadCsv(exportFilename("csv"), datasets[0]?.rows || []);
    return;
  }
  if (format === "xlsx") {
    downloadXlsx(exportFilename("xlsx"), datasets);
    return;
  }
  if (format === "pdf") {
    HOST.showToast("Opening the print dialog. Choose Save as PDF as the destination.");
    window.setTimeout(() => window.print(), 150);
  }
}

/* == Shell ================================================================ */

function controlsHtml(snapshot) {
  const range = resolveRange();
  const options = snapshot ? filterOptions(snapshot) : { province: [], merchant: [], user: [], method: [], type: [], status: [] };
  const filterSelect = (key, label, values) => `
    <label class="tp-filter">
      <span>${esc(label)}</span>
      <select data-analytics-filter="${esc(key)}"${values.length ? "" : " disabled"}>
        <option value="">${values.length ? "All" : "Not reported"}</option>
        ${values.map((value) => `<option value="${esc(value)}"${lower(state.filters[key]) === lower(value) ? " selected" : ""}>${esc(titleCase(value))}</option>`).join("")}
      </select>
    </label>
  `;
  const filters = activeFilterCount();
  return `
    <section class="tp-controls" aria-label="Analytics filters and export">
      <div class="tp-controls-row">
        <div class="tp-range-chips" role="group" aria-label="Reporting period">
          ${RANGE_PRESETS.map(([key, label]) => `
            <button type="button" class="tp-range-chip${state.rangeKey === key ? " active" : ""}" data-analytics-range="${esc(key)}" aria-pressed="${state.rangeKey === key}">${esc(label)}</button>
          `).join("")}
        </div>
        <div class="tp-export-group" role="group" aria-label="Export">
          <button class="secondary-btn" type="button" data-analytics-export="pdf">Export PDF</button>
          <button class="secondary-btn" type="button" data-analytics-export="xlsx">Export Excel</button>
          <button class="secondary-btn" type="button" data-analytics-export="csv">Export CSV</button>
        </div>
      </div>
      ${state.rangeKey === "custom" ? `
        <div class="tp-custom-range">
          <label class="tp-filter"><span>From</span><input type="date" data-analytics-date="from" value="${esc(state.customFrom || rangeIso(range.from))}"></label>
          <label class="tp-filter"><span>To</span><input type="date" data-analytics-date="to" value="${esc(state.customTo || rangeIso(range.to))}"></label>
          <button class="primary-btn" type="button" data-analytics-apply-range>Apply range</button>
        </div>
      ` : ""}
      <div class="tp-filter-grid">
        ${filterSelect("province", "Province", options.province)}
        ${filterSelect("merchant", "Merchant", options.merchant)}
        ${filterSelect("user", "User", options.user)}
        ${filterSelect("method", "Payment Method", options.method)}
        ${filterSelect("type", "Transaction Type", options.type)}
        ${filterSelect("status", "Status", options.status)}
        <div class="tp-filter-actions">
          <button class="ghost-btn" type="button" data-analytics-clear-filters${filters ? "" : " disabled"}>Clear filters</button>
          <button class="secondary-btn" type="button" data-analytics-reload>Reload data</button>
        </div>
      </div>
      <p class="tp-controls-summary">
        <strong>${esc(range.label)}</strong>
        <span>${esc(rangeIso(range.from))} to ${esc(rangeIso(range.to))}</span>
        ${filters ? `<span class="chip blue">${filters} filter${filters === 1 ? "" : "s"} applied</span>` : ""}
        ${snapshot ? `<span>Data as at ${esc(new Date(snapshot.builtAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }))}</span>` : ""}
      </p>
    </section>
  `;
}

function sectionNavHtml() {
  return `
    <nav class="segmented tp-section-nav" aria-label="Analytics sections">
      ${SECTIONS.map(([key, label]) => `
        <button type="button" class="segmented-btn${state.section === key ? " active" : ""}" data-analytics-section="${esc(key)}" aria-pressed="${state.section === key}">${esc(label)}</button>
      `).join("")}
    </nav>
  `;
}

function loadingHtml() {
  return `<div class="admin-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>`;
}

function paint() {
  const container = document.getElementById("page-content");
  if (!container) return;
  let sectionHtml = loadingHtml();
  if (!state.loading && state.snapshot) {
    try {
      sectionHtml = renderSection(state.snapshot);
    } catch (error) {
      state.datasets = [];
      sectionHtml = HOST.tableCard(
        "Analytics section unavailable",
        `<p class="table-card-note">${esc(HOST.adminErrorMessage(error?.message || "This section could not be rendered."))}</p>`,
        "Every other console module is unaffected. Reload the data or pick another section."
      );
    }
  }
  container.innerHTML = `
    <div class="tp-analytics" id="analytics-root">
      ${controlsHtml(state.snapshot)}
      ${sectionNavHtml()}
      <div class="tp-section" id="analytics-section">${sectionHtml}</div>
    </div>
  `;
  if (state.focusSelector) {
    document.querySelector(state.focusSelector)?.focus();
    state.focusSelector = "";
  }
}

async function refresh({ force = false } = {}) {
  const range = resolveRange();
  const key = snapshotKey(range);
  const stale = !state.snapshot || state.snapshotKey !== key || Date.now() - state.snapshotAt > SNAPSHOT_TTL_MS;
  if (force || stale) {
    state.loading = true;
    paint();
    state.snapshot = await buildSnapshot(range);
    state.snapshotKey = key;
    state.snapshotAt = Date.now();
    state.loading = false;
  }
  await ensureExtras(state.section);
  paint();
}

function renderRestricted() {
  const container = document.getElementById("page-content");
  if (!container) return;
  container.innerHTML = `
    <section class="table-card">
      <h3>Access restricted</h3>
      <p class="table-card-note">Enterprise Analytics is available to operators with an analytics or reporting permission. Every other module keeps exactly the access your role already had.</p>
    </section>
  `;
}

/* == Events ===============================================================
   One delegated listener, scoped to #analytics-root, using data attributes
   that exist nowhere else in the console. No form element is emitted, so the
   console's own submit handler is never reached from this page.
   ======================================================================== */

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;

  document.addEventListener("click", async (event) => {
    const root = event.target.closest?.("#analytics-root");
    if (!root) return;

    const sectionButton = event.target.closest("[data-analytics-section]");
    if (sectionButton) {
      state.section = sectionButton.dataset.analyticsSection;
      state.pages = {};
      await refresh();
      return;
    }

    const rangeButton = event.target.closest("[data-analytics-range]");
    if (rangeButton) {
      state.rangeKey = rangeButton.dataset.analyticsRange;
      state.pages = {};
      if (state.rangeKey === "custom") {
        const current = resolveRange();
        state.customFrom = state.customFrom || rangeIso(current.from);
        state.customTo = state.customTo || rangeIso(current.to);
        paint();
        return;
      }
      await refresh();
      return;
    }

    if (event.target.closest("[data-analytics-apply-range]")) {
      state.customFrom = root.querySelector('[data-analytics-date="from"]')?.value || state.customFrom;
      state.customTo = root.querySelector('[data-analytics-date="to"]')?.value || state.customTo;
      state.pages = {};
      await refresh({ force: true });
      return;
    }

    if (event.target.closest("[data-analytics-clear-filters]")) {
      Object.keys(state.filters).forEach((key) => {
        state.filters[key] = "";
      });
      state.pages = {};
      paint();
      return;
    }

    if (event.target.closest("[data-analytics-reload]")) {
      await refresh({ force: true });
      HOST.showToast("Analytics data reloaded");
      return;
    }

    const exportButton = event.target.closest("[data-analytics-export]");
    if (exportButton) {
      runExport(exportButton.dataset.analyticsExport);
      return;
    }

    const pager = event.target.closest("[data-analytics-page]");
    if (pager) {
      state.pages[pager.dataset.analyticsPage] = Number(pager.dataset.analyticsPageTo) || 1;
      paint();
    }
  });

  document.addEventListener("change", (event) => {
    if (!event.target.closest?.("#analytics-root")) return;
    const filter = event.target.closest("[data-analytics-filter]");
    if (filter) {
      const key = filter.dataset.analyticsFilter;
      state.filters[key] = filter.value;
      state.pages = {};
      state.focusSelector = `[data-analytics-filter="${key}"]`;
      paint();
      return;
    }
    const dateInput = event.target.closest("[data-analytics-date]");
    if (dateInput) {
      if (dateInput.dataset.analyticsDate === "from") state.customFrom = dateInput.value;
      else state.customTo = dateInput.value;
    }
  });
}

/* Chart readouts: hovering or focusing a mark writes its value into the
   caption below that chart. Text only, so no positioning and no inline styles
   are involved. */
function bindHoverReadouts() {
  if (hoverBound) return;
  hoverBound = true;
  const update = (event) => {
    const mark = typeof event.target?.closest === "function" ? event.target.closest("[data-detail]") : null;
    if (!mark || !mark.closest("#analytics-root")) return;
    const readout = document.getElementById(mark.dataset.readout);
    if (readout) readout.textContent = mark.dataset.detail;
  };
  document.addEventListener("pointerover", update, { passive: true });
  document.addEventListener("focusin", update);
}

/* == Entry point ========================================================== */

export async function renderAnalytics(me, host) {
  HOST = host;
  state.me = me || {};
  bindListeners();
  bindHoverReadouts();
  if (!canAccessAnalytics(state.me)) {
    renderRestricted();
    return;
  }
  await refresh();
}
