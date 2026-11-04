#!/usr/bin/env node
"use strict";

// This database is shared. Never run the repository's historical migration chain
// here. Only the checksum-pinned additive outreach DDL below may be applied.
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const MIGRATION_PATH = join(__dirname, "../prisma/migrations/20261104000000_add_managed_outreach/migration.sql");
const MIGRATION_SHA256 = "2c586ab5a6685daf5eb5749d40ce950b7119418a1d0f28f269a201fe9a07cd3f";
const TABLE_NAMES = ["ManagedOutreachJob", "ManagedOutreachEvent"];

class SchemaGuardError extends Error {
  constructor(code) { super(`Managed outreach schema guard: ${code}`); this.name = "SchemaGuardError"; this.code = code; }
}
function requireCondition(condition, code) { if (!condition) throw new SchemaGuardError(code); }
function validateSchemaName(schemaName) {
  requireCondition(typeof schemaName === "string" && schemaName.length > 0 && Buffer.byteLength(schemaName) <= 63
    && !schemaName.includes("\0") && !/^pg_/i.test(schemaName) && schemaName !== "information_schema", "invalid_target_schema");
  return schemaName;
}
function schemaFromDatabaseUrl(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    requireCondition(["postgres:", "postgresql:"].includes(url.protocol), "invalid_database_configuration");
    return validateSchemaName(url.searchParams.get("schema") || "public");
  } catch { throw new SchemaGuardError("invalid_database_configuration"); }
}
function trustedMigrationStatements(sql = readFileSync(MIGRATION_PATH, "utf8")) {
  requireCondition(createHash("sha256").update(sql).digest("hex") === MIGRATION_SHA256, "migration_checksum_mismatch");
  const statements = sql.replace(/^\s*--[^\r\n]*$/gm, "").split(";").map(statement => statement.trim()).filter(Boolean);
  requireCondition(statements.length === 11, "migration_statement_count_mismatch");
  return statements;
}

const column = (name, type = "text", notNull = true, defaultValue = null) => ({ name, type, notNull, defaultValue, identity: "", generated: "", defaultCollation: true });
const timestamp = (name, notNull = false, defaultValue = null) => column(name, "timestamp(3) without time zone", notNull, defaultValue);
const EXPECTED_COLUMNS = {
  ManagedOutreachJob: [
    column("id"), column("workspaceId"), column("externalId"), column("email"), column("companyDomain"), column("candidateJson"),
    column("stepsJson"), column("experimentId"), column("variant"), column("senderEmail"), column("status", "text", true, "'held'::text"),
    column("providerCampaignId", "text", false), column("sequenceFingerprint", "text", false), column("nextStep", "integer", true, "1"),
    timestamp("dueAt"), column("leaseToken", "text", false), timestamp("leaseUntil"), column("lastError", "text", false),
    timestamp("createdAt", true, "CURRENT_TIMESTAMP"), timestamp("updatedAt", true),
  ],
  ManagedOutreachEvent: [column("id"), column("jobId", "text", false), column("workspaceId"), column("type"),
    column("providerMessageId", "text", false), timestamp("occurredAt", true), column("dataJson"), timestamp("createdAt", true, "CURRENT_TIMESTAMP")],
};
const index = (name, columns, unique = false, primary = false) => ({ name, columns, unique, primary });
const EXPECTED_INDEXES = {
  ManagedOutreachJob: [index("ManagedOutreachJob_pkey", ["id"], true, true),
    index("ManagedOutreachJob_providerCampaignId_key", ['"providerCampaignId"'], true),
    index("ManagedOutreachJob_workspaceId_externalId_key", ['"workspaceId"', '"externalId"'], true),
    index("ManagedOutreachJob_workspaceId_email_key", ['"workspaceId"', "email"], true),
    index("ManagedOutreachJob_workspaceId_status_dueAt_idx", ['"workspaceId"', "status", '"dueAt"'])],
  ManagedOutreachEvent: [index("ManagedOutreachEvent_pkey", ["id"], true, true),
    index("ManagedOutreachEvent_workspaceId_type_occurredAt_idx", ['"workspaceId"', "type", '"occurredAt"']),
    index("ManagedOutreachEvent_jobId_occurredAt_idx", ['"jobId"', '"occurredAt"'])],
};
const EXPECTED_CONSTRAINTS = {
  ManagedOutreachJob: [{ name: "ManagedOutreachJob_pkey", type: "p", columns: ["id"] },
    { name: "ManagedOutreachJob_workspaceId_fkey", type: "f", columns: ["workspaceId"], foreignTable: "Workspace", foreignColumns: ["id"], deleteAction: "c" }],
  ManagedOutreachEvent: [{ name: "ManagedOutreachEvent_pkey", type: "p", columns: ["id"] },
    { name: "ManagedOutreachEvent_jobId_fkey", type: "f", columns: ["jobId"], foreignTable: "ManagedOutreachJob", foreignColumns: ["id"], deleteAction: "n" },
    { name: "ManagedOutreachEvent_workspaceId_fkey", type: "f", columns: ["workspaceId"], foreignTable: "Workspace", foreignColumns: ["id"], deleteAction: "c" }],
};

// All catalog queries are static and parameterized. Only checksum-pinned DDL and
// the safely quoted SET LOCAL command are passed to executeRawUnsafe.
const CATALOG_SQL = {
  schema: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS present`,
  tables: `SELECT c.relname AS "tableName", c.relkind::text AS kind, c.relpersistence::text AS persistence,
    c.relrowsecurity AS "rowSecurity", c.relforcerowsecurity AS "forceRowSecurity", c.relispartition AS partition,
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger tr WHERE tr.tgrelid = c.oid AND NOT tr.tgisinternal) AS "userTriggers",
    EXISTS (SELECT 1 FROM pg_catalog.pg_inherits inh WHERE inh.inhrelid = c.oid OR inh.inhparent = c.oid) AS inheritance
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = $1 AND c.relname IN ('ManagedOutreachJob', 'ManagedOutreachEvent')`,
  columns: `SELECT c.relname AS "tableName", a.attname AS name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull",
    pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "defaultValue", a.attidentity::text AS identity, a.attgenerated::text AS generated,
    (a.attcollation = typ.typcollation) AS "defaultCollation"
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_type typ ON typ.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE ns.nspname = $1 AND c.relname IN ('ManagedOutreachJob', 'ManagedOutreachEvent')`,
  indexes: `SELECT t.relname AS "tableName", ic.relname AS name, am.amname AS method,
    i.indisunique AS unique, i.indisprimary AS primary, i.indisvalid AS valid, i.indisready AS ready,
    i.indnkeyatts::integer AS "keyCount", i.indnatts::integer AS "attributeCount",
    i.indoption::smallint[] AS options,
    COALESCE((pg_catalog.to_jsonb(i)->>'indnullsnotdistinct')::boolean, false) AS "nullsNotDistinct",
    ARRAY(SELECT opc.opcdefault FROM pg_catalog.unnest(i.indclass) WITH ORDINALITY AS cls(oid, position)
      JOIN pg_catalog.pg_opclass opc ON opc.oid = cls.oid ORDER BY cls.position) AS "defaultOpclasses",
    NOT EXISTS (SELECT 1 FROM pg_catalog.generate_series(0, i.indnkeyatts - 1) AS position
      WHERE i.indcollation[position] <> (SELECT a.attcollation FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = t.oid AND a.attnum = i.indkey[position])) AS "collationsMatch",
    pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate, pg_catalog.pg_get_expr(i.indexprs, i.indrelid) AS expressions,
    ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid, position, true)
      FROM pg_catalog.generate_series(1, i.indnatts) AS position ORDER BY position) AS columns
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = t.relnamespace
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid JOIN pg_catalog.pg_am am ON am.oid = ic.relam
    WHERE ns.nspname = $1 AND t.relname IN ('ManagedOutreachJob', 'ManagedOutreachEvent')`,
  constraints: `SELECT t.relname AS "tableName", con.conname AS name, con.contype::text AS type,
    con.convalidated AS validated, con.condeferrable AS deferrable, con.condeferred AS deferred,
    ARRAY(SELECT a.attname FROM pg_catalog.unnest(con.conkey) WITH ORDINALITY AS k(attnum, position)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.position) AS columns,
    ft.relname AS "foreignTable", fns.nspname AS "foreignSchema",
    ARRAY(SELECT a.attname FROM pg_catalog.unnest(con.confkey) WITH ORDINALITY AS k(attnum, position)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = ft.oid AND a.attnum = k.attnum ORDER BY k.position) AS "foreignColumns",
    con.confdeltype::text AS "deleteAction", con.confupdtype::text AS "updateAction", con.confmatchtype::text AS "matchType"
    FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = t.relnamespace
    LEFT JOIN pg_catalog.pg_class ft ON ft.oid = con.confrelid LEFT JOIN pg_catalog.pg_namespace fns ON fns.oid = ft.relnamespace
    WHERE ns.nspname = $1 AND t.relname IN ('ManagedOutreachJob', 'ManagedOutreachEvent')`,
};

function sameArray(actual, expected) { return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected); }
function exactRows(rows, expectedByTable, verify, code) {
  requireCondition(Array.isArray(rows) && rows.length === Object.values(expectedByTable).reduce((count, items) => count + items.length, 0), code);
  for (const tableName of TABLE_NAMES) {
    for (const expected of expectedByTable[tableName]) {
      const matches = rows.filter(row => row.tableName === tableName && row.name === expected.name);
      requireCondition(matches.length === 1 && verify(matches[0], expected), code);
    }
  }
}
function assertExpectedSchema(snapshot, schemaName) {
  requireCondition(Array.isArray(snapshot.tables) && snapshot.tables.length === 2
    && TABLE_NAMES.every(tableName => snapshot.tables.filter(table => table.tableName === tableName).length === 1)
    && snapshot.tables.every(table => table.kind === "r" && table.persistence === "p" && table.rowSecurity === false
      && table.forceRowSecurity === false && table.partition === false && table.userTriggers === false && table.inheritance === false), "unexpected_table_properties");
  exactRows(snapshot.columns, EXPECTED_COLUMNS, (actual, expected) => Object.keys(expected).every(key => actual[key] === expected[key]), "column_schema_mismatch");
  exactRows(snapshot.indexes, EXPECTED_INDEXES, (actual, expected) => actual.method === "btree"
    && actual.unique === expected.unique && actual.primary === expected.primary && actual.valid === true && actual.ready === true
    && actual.predicate === null && actual.expressions === null && sameArray(actual.columns, expected.columns)
    && actual.nullsNotDistinct === false && actual.collationsMatch === true
    && sameArray(actual.options, expected.columns.map(() => 0)) && sameArray(actual.defaultOpclasses, expected.columns.map(() => true))
    && actual.keyCount === expected.columns.length && actual.attributeCount === expected.columns.length, "index_schema_mismatch");
  exactRows(snapshot.constraints, EXPECTED_CONSTRAINTS, (actual, expected) => actual.type === expected.type
    && actual.validated === true && actual.deferrable === false && actual.deferred === false && sameArray(actual.columns, expected.columns)
    && (expected.type !== "f" || (actual.foreignSchema === schemaName && actual.foreignTable === expected.foreignTable
      && sameArray(actual.foreignColumns, expected.foreignColumns) && actual.deleteAction === expected.deleteAction
      && actual.updateAction === "c" && actual.matchType === "s")), "constraint_schema_mismatch");
}

async function ensureManagedOutreachSchema(client, { schemaName = "public" } = {}) {
  validateSchemaName(schemaName);
  const statements = trustedMigrationStatements(); // Validate before any database activity.
  return client.$transaction(async tx => {
    await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS acquired", `gather-managed-outreach-schema-v1:${schemaName}`);
    const namespace = await tx.$queryRawUnsafe(CATALOG_SQL.schema, schemaName);
    requireCondition(namespace.length === 1 && namespace[0].present === true, "target_schema_missing");
    // Explicit path prevents an unqualified FK or CREATE from resolving to another application schema.
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schemaName.replace(/"/g, '""')}", pg_catalog`);
    let tables = await tx.$queryRawUnsafe(CATALOG_SQL.tables, schemaName);
    requireCondition(tables.length === 0 || tables.length === 2, "partial_outreach_schema");
    const created = tables.length === 0;
    if (created) {
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      tables = await tx.$queryRawUnsafe(CATALOG_SQL.tables, schemaName);
    }
    const columns = await tx.$queryRawUnsafe(CATALOG_SQL.columns, schemaName);
    const indexes = await tx.$queryRawUnsafe(CATALOG_SQL.indexes, schemaName);
    const constraints = await tx.$queryRawUnsafe(CATALOG_SQL.constraints, schemaName);
    assertExpectedSchema({ tables, columns, indexes, constraints }, schemaName);
    return { created, verified: true };
  }, { maxWait: 30_000, timeout: 60_000 });
}

module.exports = { ensureManagedOutreachSchema, assertExpectedSchema, trustedMigrationStatements, schemaFromDatabaseUrl,
  SchemaGuardError, MIGRATION_SHA256, CATALOG_SQL };

if (require.main === module) {
  (async () => {
    let client;
    try {
      const schemaName = schemaFromDatabaseUrl(process.env.DATABASE_URL);
      const { PrismaClient } = require("@prisma/client");
      client = new PrismaClient({ log: [] });
      const result = await ensureManagedOutreachSchema(client, { schemaName });
      process.stdout.write(`[managed-outreach-schema] ${result.created ? "Created and verified" : "Verified"} managed outreach tables.\n`);
    } catch (error) {
      const code = error instanceof SchemaGuardError ? error.code : "schema_preparation_failed";
      process.stderr.write(`[managed-outreach-schema] Failed (${code}). No historical migrations were run.\n`);
      process.exitCode = 1;
    } finally {
      if (client) { try { await client.$disconnect(); } catch { process.exitCode = 1; } }
    }
  })();
}
