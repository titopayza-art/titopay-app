"use strict";

const MISSING_DB_OBJECT_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42883", // undefined_function
  "42704" // undefined_object
]);

function isMissingDbObjectError(error) {
  return Boolean(error && MISSING_DB_OBJECT_CODES.has(error.code));
}

function logDbCompatibilityWarning(scope, error) {
  console.warn("[db-compat]", {
    scope,
    code: error?.code,
    message: error?.message
  });
}

async function safeQuery(pool, scope, sql, params = [], fallbackRows = []) {
  try {
    return await pool.query(sql, params);
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning(scope, error);
    return { rows: fallbackRows };
  }
}

module.exports = {
  isMissingDbObjectError,
  logDbCompatibilityWarning,
  safeQuery
};
