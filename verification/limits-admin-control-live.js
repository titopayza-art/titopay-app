"use strict";

/* THE LIMITS SCREEN IS CONTROLLED FROM THE CONSOLE, END TO END.
 *
 * The claim being tested is not "an endpoint exists". It is that an operator
 * changing a number or a sentence in the admin console changes what the
 * customer's Limits & Verification screen serves, on the very next read, with
 * an audit record behind it and without a deploy.
 *
 *  1. The numbers a customer is served come from the stored configuration.
 *  2. Editing one rail through the admin endpoint changes that read at once.
 *  3. A typo can no longer REMOVE a limit. This was the real hole: the store
 *     had no validation and the engine reads a non-finite value as "no limit",
 *     so "25,000" in a text box silently uncapped a level and reported success.
 *  4. An incoherent-but-legal change is WARNED about, not blocked.
 *  5. The wording is editable, and the customer's screen serves the new copy.
 *  6. The two caveat sentences cannot be emptied.
 *  7. Wording that claims a regulator set the amount is refused, by sentence.
 *  8. Restoring the shipped wording works, and is not the same as emptying it.
 *  9. Every change is audit-logged with the reason.
 * 10. A limit change is versioned and reversible.
 *
 * Run: node verification/limits-admin-control-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const API = path.join(__dirname, "..", "api");
const { pool } = require(path.join(API, "src", "db", "pool.js"));

const TAG = crypto.randomUUID().slice(0, 8);
let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS  " + m); };

(async () => {
  const compliance = require(path.join(API, "src", "services", "compliance-service.js"));
  const content = require(path.join(API, "src", "services", "limits-content-service.js"));
  const actor = { userId: null };

  // Whatever this shared database happens to hold, put back at the end.
  const { rows: beforeLimits } = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'compliance_tier_limits'");
  const { rows: beforeCopy } = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'limits_screen_content'");

  try {
    // 1 + 2. A stored number reaches the customer read.
    await compliance.saveComplianceConfig(actor,
      { tiers: { 1: { singleTransaction: 12345 } } },
      { reason: `harness ${TAG}: prove a console change reaches the customer` });
    const afterEdit = await compliance.loadComplianceConfig();
    assert.equal(afterEdit.tiers["1"].singleTransaction, 12345);
    const limits = require(path.join(API, "src", "services", "limit-engine.js"))
      .buildEffectiveLimits({ config: afterEdit, tier: 1, riskStatus: "normal", earned: { applies: false, multiplier: 1 } });
    assert.equal(limits.limits.singleTransaction, 12345, "the engine enforces the edited number, not the shipped one");
    // Captured NOW, because every later save writes a version of its own and
    // "the newest one mentioning this run" would be the wrong one by step 10.
    const firstVersion = (await compliance.listComplianceConfigVersions(20))
      .find((row) => String(row.reason || "").includes(TAG));
    assert.ok(firstVersion, "the change is a version of its own");
    ok("a number saved in the console is the number the engine enforces, with no deploy");

    // A PARTIAL SAVE RESETS EVERY RAIL IT DOES NOT MENTION to the shipped
    // default. That is how the configuration merge has always worked, it is
    // what lets a version be restored cleanly, and it is a trap for any client
    // that sends only the field it changed. The console form sends all three
    // levels in full for exactly this reason. Pinned here so the behaviour is
    // visible rather than discovered.
    assert.equal(afterEdit.tiers["1"].dailySend, 20000,
      "a rail the save did not mention came back as the shipped default");
    ok("a partial save resets unmentioned rails to the shipped defaults, so a client must send the whole level");

    // 3. THE HOLE THIS CLOSES. A non-numeric value reads as "no limit".
    let removed = null;
    await compliance.saveComplianceConfig(actor,
      { tiers: { 1: { monthlySend: "25,000" } } }, { reason: `harness ${TAG}: typo` })
      .catch((error) => { removed = error; });
    assert.ok(removed, "a typed amount with a comma must be refused, not stored");
    assert.match(String(removed.message), /would have removed the limit entirely/i);
    const stillCapped = await compliance.loadComplianceConfig();
    assert.equal(stillCapped.tiers["1"].monthlySend, 200000, "and the live limit is untouched");
    ok("a typo can no longer silently remove a limit and report success");

    // Negative amounts too.
    const negative = await compliance.saveComplianceConfig(actor,
      { tiers: { 0: { dailySend: -100 } } }, { reason: `harness ${TAG}: negative` })
      .then(() => null).catch((error) => error);
    assert.ok(negative && /cannot be negative/i.test(negative.message));
    ok("a negative amount is refused");

    // 4. Incoherent but legal: warned, never blocked. Narrowing one rail in a
    //    hurry is a real thing an operator does, and the engine takes the
    //    narrowest of everything anyway.
    const warned = await compliance.saveComplianceConfig(actor,
      { tiers: { 1: { dailySend: 900000 } } }, { reason: `harness ${TAG}: incoherent` });
    assert.ok(Array.isArray(warned.warnings) && warned.warnings.length, "the operator is told what they just did");
    assert.match(warned.warnings.join(" "), /daily limit is above the monthly one/i);
    assert.equal((await compliance.loadComplianceConfig()).tiers["1"].dailySend, 900000, "and it still saved");
    ok("an incoherent change is warned about rather than blocked");

    // 5. The wording, and the read a customer's screen actually uses.
    const newLead = `Your limits depend on your verification status and TitoPay's risk framework. ${TAG}`;
    await content.saveLimitsContent(actor, {
      ...content.LIMITS_CONTENT_DEFAULTS,
      lead: newLead
    });
    const served = await content.getLimitsContent();
    assert.equal(served.lead, newLead, "the customer read serves the edited sentence");
    assert.equal(served.disclaimer, content.LIMITS_CONTENT_DEFAULTS.disclaimer, "untouched fields stay as they were");
    ok("the wording on the screen is editable and reaches the customer read");

    // 6. The two caveat sentences cannot be emptied.
    for (const field of ["disclaimer", "topLevelNote"]) {
      const emptied = await content.saveLimitsContent(actor, {
        ...content.LIMITS_CONTENT_DEFAULTS, [field]: "   "
      }).then(() => null).catch((error) => error);
      assert.ok(emptied, `${field} cannot be emptied`);
      assert.match(String(emptied.message), /cannot be emptied/i);
    }
    const intact = await content.getLimitsContent();
    assert.ok(intact.disclaimer && intact.topLevelNote, "and both are still being served");
    ok("the disclaimer and the no-fixed-limit note cannot be emptied");

    // 7. No saved sentence may claim a regulator set the amount.
    const CLAIMS = [
      ["disclaimer", "This is the FICA limit for your account."],
      ["disclaimer", "These amounts are required by law."],
      ["lead", "Your monthly cash threshold is set by regulation."],
      ["topLevelNote", "Unlimited transactions at this level."],
      ["disclaimer", "These limits were approved by the regulator."]
    ];
    for (const [field, text] of CLAIMS) {
      const refused = await content.saveLimitsContent(actor, {
        ...content.LIMITS_CONTENT_DEFAULTS, [field]: text
      }).then(() => null).catch((error) => error);
      assert.ok(refused, `"${text}" must be refused`);
      assert.match(String(refused.message), new RegExp(field), "and the reason names the sentence");
    }
    ok("wording that claims a regulator set or allows the amount is refused, by sentence");

    // 8. Restoring is its own instruction, not an empty form.
    await content.saveLimitsContent(actor, {}, { reset: true });
    const restored = await content.getLimitsContent();
    for (const [key, value] of Object.entries(content.LIMITS_CONTENT_DEFAULTS)) {
      assert.equal(restored[key], value, `${key} is back to what TitoPay ships`);
    }
    ok("restoring TitoPay's own wording works, and is not the same as emptying it");

    // 9. Both kinds of change are audit-logged.
    const { rows: audits } = await pool.query(
      `SELECT action, metadata FROM audit_logs
        WHERE action IN ('compliance_limits_updated', 'limits_screen_content_updated')
          AND created_at > NOW() - INTERVAL '5 minutes'
        ORDER BY created_at DESC LIMIT 20`);
    const limitAudit = audits.find((row) => row.action === "compliance_limits_updated"
      && String(row.metadata?.reason || "").includes(TAG));
    assert.ok(limitAudit, "the limit change is audit-logged with its stated reason");
    assert.ok(limitAudit.metadata.previous && limitAudit.metadata.config,
      "with the previous and new values side by side");
    ok("every limit change carries its reason, and both values, into the audit log");

    // 10. Versioned and reversible.
    await compliance.restoreComplianceConfigVersion(actor, firstVersion.id, `harness ${TAG}: reverse it`);
    assert.equal((await compliance.loadComplianceConfig()).tiers["1"].singleTransaction, 12345,
      "restoring puts the earlier configuration back");
    ok("a limit configuration is versioned and can be reversed");

    console.log(`\n  ${passed}/11 admin control checks passed. The screen is operated from the console.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    // Put the shared database back exactly as it was found.
    if (beforeLimits[0]) {
      await pool.query(
        `INSERT INTO platform_settings (key, value, updated_at) VALUES ('compliance_tier_limits', $1::JSONB, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(beforeLimits[0].value)]).catch(() => {});
    } else {
      await pool.query("DELETE FROM platform_settings WHERE key = 'compliance_tier_limits'").catch(() => {});
    }
    if (beforeCopy[0]) {
      await pool.query(
        `INSERT INTO platform_settings (key, value, updated_at) VALUES ('limits_screen_content', $1::JSONB, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(beforeCopy[0].value)]).catch(() => {});
    } else {
      await pool.query("DELETE FROM platform_settings WHERE key = 'limits_screen_content'").catch(() => {});
    }
    await pool.query("DELETE FROM compliance_config_versions WHERE reason LIKE $1", [`%${TAG}%`]).catch(() => {});
    await pool.query("DELETE FROM audit_logs WHERE metadata->>'reason' LIKE $1", [`%${TAG}%`]).catch(() => {});
    await pool.end().catch(() => {});
  }
})();
