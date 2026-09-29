"use strict";

// Server storage for the admin console's Service Builder.
//
// The builder shipped storing definitions in the browser's localStorage, with
// a banner saying it would switch to API storage "the moment the endpoint
// exists" — it probes GET /admin/service-builder/services on load and flips
// to API mode when the response carries a services array. These are those
// endpoints. Definitions move with the account instead of the browser, and a
// cleared cache or a second machine no longer loses the registry.
//
// A definition is CONFIGURATION ONLY — a JSON document the console composed.
// Nothing in it is executed here, nothing is served to customers from this
// table, and storing one changes no behaviour anywhere: the PWA's service
// catalogue is a separate, deliberately untouched system. The console's own
// words on the page ("nothing here is executable code, and nothing is visible
// to customers until the API catalogue carries it") stay true.

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");

// The console mints ids as `svc_${slug}_${timestamp36}`. Anchoring the format
// keeps arbitrary strings out of the primary key.
const SERVICE_ID_PATTERN = /^svc_[a-z0-9_-]{1,80}$/i;

// A definition is a form's worth of configuration plus up to four branding
// images stored as data URIs. The console caps each image at 400KB before
// encoding, so the largest honest definition is about 2.3MB once base64
// inflates them; the cap above that is there so the endpoint cannot be used
// as general blob storage.
const MAX_DEFINITION_BYTES = 3 * 1024 * 1024;

let schemaReady = null;
function ensureServiceBuilderSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS service_builder_definitions (
        id TEXT PRIMARY KEY,
        definition JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        updated_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch((error) => { schemaReady = null; throw error; });
  }
  return schemaReady;
}

async function listDefinitions() {
  await ensureServiceBuilderSchema();
  const { rows } = await pool.query(
    "SELECT definition FROM service_builder_definitions ORDER BY updated_at DESC"
  );
  return rows.map((row) => row.definition);
}

async function saveDefinition(service, adminId) {
  await ensureServiceBuilderSchema();
  if (!service || typeof service !== "object" || Array.isArray(service)) {
    throw new AppError(400, "A service definition object is required");
  }
  const id = String(service.id || "");
  if (!SERVICE_ID_PATTERN.test(id)) {
    throw new AppError(400, "Service id must look like svc_name_timestamp");
  }
  if (typeof service.name !== "string" || !service.name.trim()) {
    throw new AppError(400, "A service definition needs a name");
  }
  const serialised = JSON.stringify(service);
  if (Buffer.byteLength(serialised, "utf8") > MAX_DEFINITION_BYTES) {
    throw new AppError(413, "Service definition is too large to store. Remove embedded images and keep branding as uploaded assets.");
  }
  const status = ["draft", "active", "disabled", "archived"].includes(service.status) ? service.status : "draft";
  const { rows } = await pool.query(
    `INSERT INTO service_builder_definitions (id, definition, status, updated_by)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET definition = EXCLUDED.definition, status = EXCLUDED.status,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING id, status, updated_at`,
    [id, serialised, status, adminId || null]
  );
  return rows[0];
}

async function deleteDefinition(id) {
  await ensureServiceBuilderSchema();
  if (!SERVICE_ID_PATTERN.test(String(id || ""))) {
    throw new AppError(400, "Service id must look like svc_name_timestamp");
  }
  const { rowCount } = await pool.query("DELETE FROM service_builder_definitions WHERE id = $1", [id]);
  if (!rowCount) throw new AppError(404, "Service definition not found");
  return { deleted: true };
}

module.exports = {
  ensureServiceBuilderSchema,
  listDefinitions,
  saveDefinition,
  deleteDefinition,
  SERVICE_ID_PATTERN,
  MAX_DEFINITION_BYTES
};
