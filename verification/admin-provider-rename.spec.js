// THE RENAME CONTROL, RENDERED BY THE REAL CONSOLE.
//
// The API tests prove the route. This proves the screen: that the form appears
// on a provider page, that it PUTs the path the API actually registers, that a
// name carrying markup is rendered as text rather than as HTML, and that a
// non-super-admin cannot submit it.
//
// The console is served from disk and the API is stubbed inside the page, so
// this runs with no database and no API process.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/admin-provider-rename.spec.js
//
// ADMIN_ROOT overrides the console directory so an extracted admin.zip can be
// tested exactly as it will be deployed.

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ADMIN_ROOT = process.env.ADMIN_ROOT || path.join(__dirname, "..", "admin");

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml",
  ".json": "application/json", ".txt": "text/plain"
};

function serve() {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent(String(req.url).split("?")[0]);
    if (file.endsWith("/")) file += "index.html";
    const resolved = path.join(ADMIN_ROOT, file);
    if (!resolved.startsWith(ADMIN_ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(fs.readFileSync(resolved));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Everything the provider page fetches, shaped exactly as the API returns it.
function stubApi(displayName, role) {
  const provider = {
    key: "docfox",
    label: displayName || "DocFox / FICA",
    defaultLabel: "DocFox / FICA",
    displayName: displayName || "",
    description: "KYC, FICA and verification provider.",
    category: "compliance",
    environment: "production",
    mode: "production",
    enabled: true,
    configured: false,
    baseUrl: "",
    secrets: {},
    fields: [
      { name: "enabled", label: "Enabled", type: "boolean", secret: false },
      { name: "baseUrl", label: "Base URL", type: "text", secret: false }
    ],
    health: { status: "not_tested", responseTimeMs: null, lastSuccessfulConnectionAt: null, errorMessage: "" }
  };
  return {
    "/admin/me": {
      ok: true,
      role,
      permissions: role === "super_admin" ? ["*"] : ["integrations"],
      user: { role, email: "root@titopay.test", full_name: "Root Owner" }
    },
    "/admin/integrations/config/docfox": { ok: true, provider },
    "/admin/provider-routing": {
      ok: true,
      services: [{ key: "kyc", label: "Identity Verification", provider: "docfox" }],
      providers: [{ key: "none", label: "Not configured" }, { key: "docfox", label: provider.label }]
    }
  };
}

async function openProviderPage(browser, origin, { displayName = "", role = "super_admin" } = {}) {
  const context = await browser.newContext();
  await context.addInitScript(([routes, adminRole]) => {
    localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({
      accessToken: "stub", refreshToken: "stub", role: adminRole, scope: "admin", clientLastSeenAt: Date.now()
    }));
    window.__puts = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const route = Object.keys(routes).find((candidate) => url.includes(candidate));
      if ((init.method || "GET").toUpperCase() === "PUT") {
        window.__puts.push({ url, body: init.body });
        return new Response(JSON.stringify({ ok: true, key: "docfox", label: "Verity KYC", displayName: "Verity KYC", defaultLabel: "DocFox / FICA" }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (route) {
        return new Response(JSON.stringify(routes[route]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("http") && !url.includes(location.host)) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    };
  }, [stubApi(displayName, role), role]);

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/integrations/docfox/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".integration-name-form", { timeout: 15000 }).catch(() => null);
  return { context, page, errors };
}

(async () => {
  console.log("\n=============================================================");
  console.log("  ADMIN -> rename a provider slot");
  console.log("=============================================================\n");

  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    // ---- 1. The control exists and shows the catalogue name ----------------
    let session = await openProviderPage(browser, origin);
    let form = await session.page.$(".integration-name-form");
    check("the rename form is on the provider page", Boolean(form));
    check("no page errors", session.errors.length === 0, session.errors.join(" | "));

    const placeholder = await session.page.getAttribute('.integration-name-form input[name="displayName"]', "placeholder");
    check("the catalogue name is the placeholder", placeholder === "DocFox / FICA", String(placeholder));
    const value = await session.page.inputValue('.integration-name-form input[name="displayName"]');
    check("an un-renamed slot shows an empty field, not the old name", value === "", JSON.stringify(value));

    const copy = (await session.page.innerText(".integration-name-form")).replace(/\s+/g, " ");
    check("the copy says the slot is not repointed",
      /does not change which company the API talks to/i.test(copy), copy.slice(0, 80));
    check("the copy names the slot key", /docfox/.test(copy));
    await session.context.close();

    // ---- 2. Submitting PUTs the registered path with the typed name --------
    session = await openProviderPage(browser, origin);
    await session.page.fill('.integration-name-form input[name="displayName"]', "Verity KYC");
    await session.page.click('.integration-name-form button[type="submit"]');
    await session.page.waitForFunction(() => window.__puts.length > 0, null, { timeout: 10000 }).catch(() => null);
    const puts = await session.page.evaluate(() => window.__puts);
    check("submitting sends exactly one PUT", puts.length === 1, JSON.stringify(puts.map((p) => p.url)));
    check("it PUTs /admin/integrations/docfox/name",
      puts[0]?.url.endsWith("/admin/integrations/docfox/name"), String(puts[0]?.url));
    check("it sends the typed name", JSON.parse(puts[0]?.body || "{}").displayName === "Verity KYC", String(puts[0]?.body));
    await session.context.close();

    // ---- 3. A renamed slot reads back its new name -------------------------
    session = await openProviderPage(browser, origin, { displayName: "Verity KYC" });
    const renamedHeading = await session.page.innerText(".integration-intro h3");
    check("the page heading uses the new name", renamedHeading.trim() === "Verity KYC", renamedHeading.trim());
    const renamedValue = await session.page.inputValue('.integration-name-form input[name="displayName"]');
    check("the field is pre-filled with the override", renamedValue === "Verity KYC", renamedValue);
    const stillDefault = await session.page.getAttribute('.integration-name-form input[name="displayName"]', "placeholder");
    check("the catalogue name is still offered as the reset", stillDefault === "DocFox / FICA", String(stillDefault));
    await session.context.close();

    // ---- 4. A name carrying markup is TEXT, never HTML ---------------------
    // The API refuses angle brackets, but a row rendered before that rule, or
    // written by any other path, must still be inert on the screen.
    session = await openProviderPage(browser, origin, { displayName: '<img src=x onerror="window.__xss=1">' });
    const injected = await session.page.evaluate(() => ({
      xss: Boolean(window.__xss),
      images: document.querySelectorAll(".integration-intro img").length,
      heading: document.querySelector(".integration-intro h3")?.textContent || ""
    }));
    check("markup in a provider name does not execute", injected.xss === false);
    check("markup in a provider name creates no element", injected.images === 0, String(injected.images));
    check("markup in a provider name is shown as text",
      injected.heading.includes("<img"), injected.heading.slice(0, 40));
    await session.context.close();

    // ---- 5. A non-super-admin cannot submit it -----------------------------
    session = await openProviderPage(browser, origin, { role: "customer_support" });
    const restricted = await session.page.evaluate(() => ({
      disabled: document.querySelector('.integration-name-form input[name="displayName"]')?.disabled,
      submits: document.querySelectorAll('.integration-name-form button[type="submit"]').length
    }));
    check("the field is disabled for restricted staff", restricted.disabled === true, String(restricted.disabled));
    check("no Save button for restricted staff", restricted.submits === 0, String(restricted.submits));
    await session.context.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((item) => !item.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
