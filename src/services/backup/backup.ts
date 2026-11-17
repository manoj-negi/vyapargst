import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { env } from "../../config/env";

const run = promisify(execFile);

export const PROJECT_ROOT = path.join(__dirname, "../../..");
// The app always stores uploads in public/uploads; the override exists so restore can be tested on a copy.
export const UPLOADS_DIR = process.env.BACKUP_UPLOADS_DIR || path.join(PROJECT_ROOT, "public/uploads");

/** Tables and money/stock totals recorded with every backup and re-checked after a restore. */
const COUNT_QUERIES: Record<string, string> = {
  Business: `SELECT count(*)::text FROM "Business"`,
  Customer: `SELECT count(*)::text FROM "Customer"`,
  Product: `SELECT count(*)::text FROM "Product"`,
  SaleInvoice: `SELECT count(*)::text FROM "SaleInvoice"`,
  SaleInvoiceItem: `SELECT count(*)::text FROM "SaleInvoiceItem"`,
  StockTransaction: `SELECT count(*)::text FROM "StockTransaction"`,
  "SaleInvoice.total": `SELECT COALESCE(sum(total),0)::text FROM "SaleInvoice"`,
  "SaleInvoice.balance": `SELECT COALESCE(sum(balance),0)::text FROM "SaleInvoice"`,
  "Product.currentStock": `SELECT COALESCE(sum("currentStock"),0)::text FROM "Product"`,
};
// Tables that only exist once the 2026-11 migration has run
const OPTIONAL_COUNT_QUERIES: Record<string, string> = {
  PaymentVoucher: `SELECT count(*)::text FROM "PaymentVoucher"`,
  Expense: `SELECT count(*)::text FROM "Expense"`,
};

/** libpq rejects Prisma's ?schema= parameter, so strip the query string for pg tools. */
export function pgUrl(databaseUrl = env.databaseUrl): URL {
  const url = new URL(databaseUrl);
  url.search = "";
  return url;
}

export function databaseName(databaseUrl = env.databaseUrl): string {
  return decodeURIComponent(pgUrl(databaseUrl).pathname.replace(/^\//, ""));
}

export function urlForDatabase(name: string, databaseUrl = env.databaseUrl): string {
  const url = pgUrl(databaseUrl);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}

async function query(databaseUrl: string, sql: string): Promise<string> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const res = await client.query(sql);
    return res.rows[0] ? String(Object.values(res.rows[0])[0]) : "";
  } finally {
    await client.end();
  }
}

export async function adminQuery(sql: string, params: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString: urlForDatabase("postgres") });
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

export async function collectCounts(databaseUrl = pgUrl().toString()): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  for (const [name, sql] of Object.entries(COUNT_QUERIES)) counts[name] = await query(databaseUrl, sql);
  for (const [name, sql] of Object.entries(OPTIONAL_COUNT_QUERIES)) {
    try {
      counts[name] = await query(databaseUrl, sql);
    } catch {
      // table not present in this (older) schema
    }
  }
  return counts;
}

/**
 * Finds pg_dump / pg_restore whose major version is at least the server's (an older pg_dump
 * refuses to dump a newer server). PG_BIN_DIR wins when set.
 */
export async function findPgTool(tool: "pg_dump" | "pg_restore"): Promise<string> {
  const serverMajor = Number((await query(pgUrl().toString(), "SHOW server_version_num")).slice(0, -4));
  const candidates = [
    env.pgBinDir,
    ...[20, 19, 18, 17, 16, 15, 14].flatMap((v) => [`/opt/homebrew/opt/postgresql@${v}/bin`, `/usr/local/opt/postgresql@${v}/bin`, `/usr/lib/postgresql/${v}/bin`]),
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ].filter(Boolean);
  for (const dir of candidates) {
    const bin = path.join(dir, tool);
    if (!existsSync(bin)) continue;
    try {
      const { stdout } = await run(bin, ["--version"]);
      const major = Number(/(\d+)(?:\.\d+)?/.exec(stdout)?.[1]);
      if (major >= serverMajor) return bin;
    } catch {
      // not runnable; try the next one
    }
  }
  throw new Error(`No ${tool} for PostgreSQL ${serverMajor} or newer was found. Install it or set PG_BIN_DIR in .env.`);
}

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface BackupManifest {
  createdAt: string;
  label: string;
  database: string;
  serverVersion: string;
  pgDump: string;
  migrations: string[];
  counts: Record<string, string>;
  files: Record<string, string>;
}

/** Writes database.dump (pg_dump custom format), uploads.tar.gz and manifest.json into a new folder. */
export async function createBackup(label = "manual"): Promise<{ dir: string; manifest: BackupManifest }> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  // Local time, so the folder name matches the clock the user sees
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const dir = path.join(env.backupDir, `${stamp}_${label.replace(/[^A-Za-z0-9-]/g, "")}`);
  await fs.mkdir(dir, { recursive: true });

  const pgDump = await findPgTool("pg_dump");
  const db = pgUrl().toString();
  await run(pgDump, ["--format=custom", "--no-owner", `--file=${path.join(dir, "database.dump")}`, `--dbname=${db}`], { maxBuffer: 64 * 1024 * 1024 });
  await run("tar", ["-czf", path.join(dir, "uploads.tar.gz"), "-C", path.dirname(UPLOADS_DIR), path.basename(UPLOADS_DIR)]);

  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    label,
    database: databaseName(),
    serverVersion: await query(db, "SHOW server_version"),
    pgDump: (await run(pgDump, ["--version"])).stdout.trim(),
    migrations: (await query(db, `SELECT string_agg(migration_name, ',' ORDER BY migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)).split(","),
    counts: await collectCounts(db),
    files: {
      "database.dump": await sha256(path.join(dir, "database.dump")),
      "uploads.tar.gz": await sha256(path.join(dir, "uploads.tar.gz")),
    },
  };
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

/** Checks the backup's files against its manifest checksums and that pg_restore can read the dump. */
export async function verifyBackup(dir: string): Promise<BackupManifest> {
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
  for (const [file, expected] of Object.entries(manifest.files)) {
    const actual = await sha256(path.join(dir, file));
    if (actual !== expected) throw new Error(`${file} is corrupt or was changed (checksum mismatch)`);
  }
  await run(await findPgTool("pg_restore"), ["--list", path.join(dir, "database.dump")], { maxBuffer: 64 * 1024 * 1024 });
  await run("tar", ["-tzf", path.join(dir, "uploads.tar.gz")], { maxBuffer: 64 * 1024 * 1024 });
  return manifest;
}

export async function listBackups(): Promise<{ name: string; dir: string; manifest: BackupManifest | null; sizeBytes: number }[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(env.backupDir);
  } catch {
    return [];
  }
  const result = [];
  for (const name of names.sort().reverse()) {
    const dir = path.join(env.backupDir, name);
    if (!(await fs.stat(dir)).isDirectory()) continue;
    let manifest: BackupManifest | null = null;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
    } catch {
      // folder from a manual backup without a manifest
    }
    let sizeBytes = 0;
    for (const f of await fs.readdir(dir)) sizeBytes += (await fs.stat(path.join(dir, f))).size;
    result.push({ name, dir, manifest, sizeBytes });
  }
  return result;
}
