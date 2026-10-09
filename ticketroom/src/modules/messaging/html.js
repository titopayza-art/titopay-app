// Branded HTML version of a plain-text message. Email clients ignore external
// CSS, so styles are inline; no images, so nothing is blocked by default.
//   "Label: https://…" on its own line  -> button
//   "- item" lines                      -> bullet list
//   text after the "-- " line           -> footer
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" style="color:#1B3770">${u}</a>`);
const BUTTON = /^([^:\n]{2,40}): (https?:\/\/\S+)$/;

function toHtml(subject, text) {
  const [main, footer = ""] = String(text).split(/\n\n-- \n/);
  const blocks = main.split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    const m = lines.length === 1 && lines[0].match(BUTTON);
    if (m) return `<p style="margin:24px 0"><a href="${esc(m[2])}" style="background:#F2A93B;color:#0B1D3F;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">${esc(m[1])}</a></p>`;
    const bullets = lines.filter((l) => l.startsWith("- "));
    if (bullets.length && bullets.length >= lines.length - 1) {
      const head = lines.length > bullets.length ? `<p style="margin:16px 0 6px">${linkify(lines[0])}</p>` : "";
      return `${head}<ul style="margin:0 0 16px;padding-left:20px">${bullets.map((l) => `<li style="margin:4px 0">${linkify(l.slice(2))}</li>`).join("")}</ul>`;
    }
    return `<p style="margin:0 0 16px">${lines.map(linkify).join("<br>")}</p>`;
  }).join("");
  return `<!doctype html><html lang="en-ZA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#F5F7FB;font-family:Arial,Helvetica,sans-serif;color:#0E1A30">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FB"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#0B1D3F;padding:20px 28px;font-size:22px;font-weight:800;letter-spacing:1px;color:#ffffff">TICKET<span style="color:#F2A93B">ROOM</span><div style="font-size:11px;font-weight:600;letter-spacing:3px;color:#AFC0DD;margin-top:4px">YOUR EVENT. YOUR TICKET.</div></td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.55">${blocks}</td></tr>
<tr><td style="padding:16px 28px;background:#EEF1F6;font-size:12px;color:#5E6C84;line-height:1.5">${footer.split("\n").map(linkify).join("<br>")}</td></tr>
</table></td></tr></table></body></html>`;
}

module.exports = { toHtml };
