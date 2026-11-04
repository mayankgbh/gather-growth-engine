import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const { ensureManagedOutreachSchema, assertExpectedSchema, trustedMigrationStatements, schemaFromDatabaseUrl,
  CATALOG_SQL, MIGRATION_SHA256 } = require("../../scripts/ensure-managed-outreach-schema.cjs");
type Row = Record<string, any>;
const migration = readFileSync(join(__dirname, "../../prisma/migrations/20261104000000_add_managed_outreach/migration.sql"), "utf8");
const statements = trustedMigrationStatements(migration) as string[];

// Catalog fixtures are derived from the checked-in migration, independently of
// the script's expected-schema constants. These tests never open a connection.
function snapshot(schemaName = "public") {
  const tables: Row[] = []; const columns: Row[] = []; const indexes: Row[] = []; const constraints: Row[] = [];
  function addIndex(tableName: string, name: string, fields: string[], unique: boolean, primary: boolean) {
    indexes.push({ tableName, name, columns: fields.map(field => /^[a-z]+$/.test(field) ? field : `"${field}"`),
      unique, primary, method: "btree", valid: true, ready: true, keyCount: fields.length, attributeCount: fields.length,
      predicate: null, expressions: null, options: fields.map(() => 0), nullsNotDistinct: false,
      defaultOpclasses: fields.map(() => true), collationsMatch: true });
  }
  for (const statement of statements) {
    const create = statement.match(/^CREATE TABLE "([^"]+)"/);
    if (create) {
      const tableName = create[1];
      tables.push({ tableName, kind: "r", persistence: "p", rowSecurity: false, forceRowSecurity: false,
        partition: false, userTriggers: false, inheritance: false });
      for (const line of statement.split("\n")) {
        const field = line.trim().match(/^"([^"]+)" (TEXT|INTEGER|TIMESTAMP\(3\))( NOT NULL)?(?: DEFAULT ([^,]+))?,?$/);
        if (!field) continue;
        columns.push({ tableName, name: field[1], type: field[2] === "TEXT" ? "text" : field[2] === "INTEGER" ? "integer" : "timestamp(3) without time zone",
          notNull: !!field[3], defaultValue: field[4] === "'held'" ? "'held'::text" : field[4] || null,
          identity: "", generated: "", defaultCollation: true });
      }
      const primary = statement.match(/CONSTRAINT "([^"]+)" PRIMARY KEY \("([^"]+)"\)/)!;
      constraints.push({ tableName, name: primary[1], type: "p", columns: [primary[2]], validated: true, deferrable: false, deferred: false });
      addIndex(tableName, primary[1], [primary[2]], true, true);
      continue;
    }
    const index = statement.match(/^CREATE (UNIQUE )?INDEX "([^"]+)" ON "([^"]+)"\((.+)\)$/);
    if (index) {
      addIndex(index[3], index[2], Array.from(index[4].matchAll(/"([^"]+)"/g), match => match[1]), !!index[1], false);
      continue;
    }
    const foreign = statement.match(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" FOREIGN KEY \("([^"]+)"\) REFERENCES "([^"]+)"\("([^"]+)"\) ON DELETE (CASCADE|SET NULL) ON UPDATE CASCADE$/);
    if (!foreign) throw new Error("Unexpected trusted migration statement in fixture");
    constraints.push({ tableName: foreign[1], name: foreign[2], type: "f", columns: [foreign[3]], foreignTable: foreign[4],
      foreignSchema: schemaName, foreignColumns: [foreign[5]], deleteAction: foreign[6] === "CASCADE" ? "c" : "n",
      updateAction: "c", matchType: "s", validated: true, deferrable: false, deferred: false });
  }
  return { tables, columns, indexes, constraints };
}

function fakeDatabase(options: { initial?: "absent" | "present" | "partial"; schemaName?: string; schemaExists?: boolean; drift?: (value: ReturnType<typeof snapshot>) => void; failDdlAt?: number } = {}) {
  const target = snapshot(options.schemaName); options.drift?.(target);
  let created = options.initial !== "absent";
  const executed: string[] = []; const calls: string[] = [];
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string, parameter: string) => {
      calls.push(sql);
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return [{ acquired: "" }];
      expect(parameter).toBe(options.schemaName || "public");
      if (sql === CATALOG_SQL.schema) return [{ present: options.schemaExists !== false }];
      if (sql === CATALOG_SQL.tables) return options.initial === "partial" ? target.tables.slice(0, 1) : created ? target.tables : [];
      if (sql === CATALOG_SQL.columns) return target.columns;
      if (sql === CATALOG_SQL.indexes) return target.indexes;
      if (sql === CATALOG_SQL.constraints) return target.constraints;
      throw new Error("Unexpected catalog query");
    }),
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      calls.push(sql); executed.push(sql);
      const ddl = executed.filter(command => !command.startsWith("SET LOCAL"));
      if (options.failDdlAt === ddl.length && !sql.startsWith("SET LOCAL")) throw new Error("Synthetic database credential must not escape");
      if (ddl.length === statements.length) created = true;
      return 0;
    }),
  };
  const client = { $transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
    const before = created;
    try { return await callback(tx); } catch (error) { created = before; throw error; }
  }) };
  return { client, tx, executed, calls, wasCreated: () => created };
}

describe("isolated managed outreach schema setup", () => {
  it("pins the exact additive migration and refuses any changed or appended SQL", () => {
    expect(MIGRATION_SHA256).toBe("2c586ab5a6685daf5eb5749d40ce950b7119418a1d0f28f269a201fe9a07cd3f");
    expect(statements).toHaveLength(11);
    expect(() => trustedMigrationStatements(`${migration}\nDROP TABLE "Workspace";`)).toThrow("migration_checksum_mismatch");
    expect(() => trustedMigrationStatements(migration.replace("DEFAULT 'held'", "DEFAULT 'ready'"))).toThrow("migration_checksum_mismatch");
    expect(statements.every(statement => /^(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ALTER TABLE) "ManagedOutreach(?:Job|Event)/.test(statement))).toBe(true);
  });

  it("accepts precisely the catalog schema described by the pinned migration", () => {
    const value = snapshot();
    expect(value.columns).toHaveLength(28); expect(value.indexes).toHaveLength(8); expect(value.constraints).toHaveLength(5);
    expect(() => assertExpectedSchema(value, "public")).not.toThrow();
  });

  it("creates only the pinned tables and verifies them in one advisory-locked transaction", async () => {
    const database = fakeDatabase({ initial: "absent" });
    expect(await ensureManagedOutreachSchema(database.client)).toEqual({ created: true, verified: true });
    expect(database.client.$transaction).toHaveBeenCalledTimes(1);
    expect(database.client.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 30_000, timeout: 60_000 });
    expect(database.calls[0]).toMatch(/^SELECT pg_advisory_xact_lock/);
    expect(database.executed).toEqual(['SET LOCAL search_path TO "public", pg_catalog', ...statements]);
    expect(database.calls.indexOf(CATALOG_SQL.columns)).toBeGreaterThan(database.calls.indexOf(statements[10]));
    expect(database.calls.some(sql => /_prisma_migrations|INSERT|UPDATE "Workspace"|DROP TABLE/.test(sql))).toBe(false);
  });

  it("verifies an existing exact schema repeatedly without changing any tables or migration history", async () => {
    const database = fakeDatabase({ initial: "present" });
    expect(await ensureManagedOutreachSchema(database.client)).toEqual({ created: false, verified: true });
    expect(await ensureManagedOutreachSchema(database.client)).toEqual({ created: false, verified: true });
    expect(database.executed).toEqual(['SET LOCAL search_path TO "public", pg_catalog', 'SET LOCAL search_path TO "public", pg_catalog']);
  });

  it("fails closed on a partial installation without attempting any migration DDL", async () => {
    const database = fakeDatabase({ initial: "partial" });
    await expect(ensureManagedOutreachSchema(database.client)).rejects.toMatchObject({ code: "partial_outreach_schema" });
    expect(database.executed).toEqual(['SET LOCAL search_path TO "public", pg_catalog']);
  });

  it("fails before setting a search path when the target schema is missing", async () => {
    const database = fakeDatabase({ initial: "absent", schemaExists: false });
    await expect(ensureManagedOutreachSchema(database.client)).rejects.toMatchObject({ code: "target_schema_missing" });
    expect(database.executed).toHaveLength(0);
  });

  it("rolls back the transaction when one of the trusted DDL statements fails", async () => {
    const database = fakeDatabase({ initial: "absent", failDdlAt: 4 });
    await expect(ensureManagedOutreachSchema(database.client)).rejects.toThrow("Synthetic database credential");
    expect(database.wasCreated()).toBe(false);
    expect(database.executed.filter(sql => !sql.startsWith("SET LOCAL"))).toEqual(statements.slice(0, 4));
  });

  it("refuses a newly created schema if its final catalog verification fails", async () => {
    const database = fakeDatabase({ initial: "absent", drift: value => { value.columns[0].notNull = false; } });
    await expect(ensureManagedOutreachSchema(database.client)).rejects.toMatchObject({ code: "column_schema_mismatch" });
    expect(database.wasCreated()).toBe(false);
  });

  it("quotes a configured schema name as one identifier and parameterizes its catalog lookup", async () => {
    const schemaName = 'app"schema';
    const database = fakeDatabase({ initial: "present", schemaName });
    expect(await ensureManagedOutreachSchema(database.client, { schemaName })).toEqual({ created: false, verified: true });
    expect(database.executed).toEqual(['SET LOCAL search_path TO "app""schema", pg_catalog']);
    expect(database.tx.$queryRawUnsafe).toHaveBeenCalledWith(CATALOG_SQL.tables, schemaName);
  });
});

describe("schema drift rejection", () => {
  it.each([
    ["nullable required column", (value: Row) => { value.columns[0].notNull = false; }],
    ["wrong type", (value: Row) => { value.columns[0].type = "uuid"; }],
    ["wrong default", (value: Row) => { value.columns.find((row: Row) => row.name === "status").defaultValue = "'ready'::text"; }],
    ["extra column", (value: Row) => { value.columns.push({ ...value.columns[0], name: "unexpected" }); }],
    ["missing column", (value: Row) => { value.columns.pop(); }],
    ["identity column", (value: Row) => { value.columns[0].identity = "a"; }],
    ["column collation", (value: Row) => { value.columns[0].defaultCollation = false; }],
    ["missing unique index", (value: Row) => { value.indexes.splice(2, 1); }],
    ["nonunique index", (value: Row) => { value.indexes[0].unique = false; }],
    ["wrong column order", (value: Row) => { value.indexes.find((row: Row) => row.columns.length > 1).columns.reverse(); }],
    ["partial index", (value: Row) => { value.indexes[0].predicate = "true"; }],
    ["invalid index", (value: Row) => { value.indexes[0].valid = false; }],
    ["descending index", (value: Row) => { value.indexes[0].options = [1]; }],
    ["different operator class", (value: Row) => { value.indexes[0].defaultOpclasses = [false]; }],
    ["index collation", (value: Row) => { value.indexes[0].collationsMatch = false; }],
    ["different null semantics", (value: Row) => { value.indexes[0].nullsNotDistinct = true; }],
    ["foreign table", (value: Row) => { value.constraints.find((row: Row) => row.type === "f").foreignTable = "Unrelated"; }],
    ["foreign schema", (value: Row) => { value.constraints.find((row: Row) => row.type === "f").foreignSchema = "other_app"; }],
    ["foreign deletion action", (value: Row) => { value.constraints.find((row: Row) => row.type === "f").deleteAction = "a"; }],
    ["unvalidated foreign key", (value: Row) => { value.constraints.find((row: Row) => row.type === "f").validated = false; }],
    ["deferrable key", (value: Row) => { value.constraints[0].deferrable = true; }],
    ["view instead of table", (value: Row) => { value.tables[0].kind = "v"; }],
    ["row security", (value: Row) => { value.tables[0].rowSecurity = true; }],
    ["user trigger", (value: Row) => { value.tables[0].userTriggers = true; }],
  ])("rejects %s", (_name, mutate) => {
    const value = snapshot(); (mutate as (value: Row) => void)(value);
    expect(() => assertExpectedSchema(value, "public")).toThrow();
  });
});

describe("schema setup runtime boundary", () => {
  it("extracts only the target schema from the database URL", () => {
    expect(schemaFromDatabaseUrl("postgresql://example:synthetic-secret@example.invalid/app")).toBe("public");
    expect(schemaFromDatabaseUrl("postgresql://example:synthetic-secret@example.invalid/app?schema=app_schema")).toBe("app_schema");
    expect(() => schemaFromDatabaseUrl("postgresql://example:synthetic-secret@example.invalid/app?schema=pg_catalog")).toThrow("invalid_database_configuration");
  });

  it("rejects a protected schema before entering any transaction", async () => {
    const database = fakeDatabase();
    await expect(ensureManagedOutreachSchema(database.client, { schemaName: "pg_catalog" })).rejects.toMatchObject({ code: "invalid_target_schema" });
    expect(database.client.$transaction).not.toHaveBeenCalled();
  });

  it("the executable fails safely on invalid configuration without exposing secrets or opening a connection", () => {
    const result = spawnSync(process.execPath, [join(__dirname, "../../scripts/ensure-managed-outreach-schema.cjs")], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: "invalid-synthetic-secret" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid_database_configuration");
    expect(result.stderr).not.toMatch(/synthetic-secret|DATABASE_URL|Prisma/);
  });
});
