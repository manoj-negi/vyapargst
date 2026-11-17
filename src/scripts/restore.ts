/* eslint-disable no-console */
/**
 * Usage (stop the app first):  npm run restore -- <backup-folder> --confirm
 *
 * Nothing is dropped or overwritten:
 *  1. the backup's checksums and dump are verified
 *  2. a fresh backup of the current data is taken
 *  3. the backup is restored into a NEW database and its counts compared with the manifest
 *  4. the current database is renamed to <name>_before_restore_<time> and the new one takes its name
 *  5. public/uploads is moved aside to uploads.before-restore-<time> and the backup's uploads unpacked
 *  6. prisma migrate deploy brings an older backup's schema up to date (additive migrations only)
 * To undo, rename the databases / folders back.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { env } from "../config/env";
import { PROJECT_ROOT, UPLOADS_DIR, adminQuery, collectCounts, createBackup, databaseName, findPgTool, urlForDatabase, verifyBackup } from "../services/backup/backup";

const run = promisify(execFile);

async function otherConnections(db: string): Promise<number> {
  const client = new Client({ connectionString: urlForDatabase("postgres") });
  await client.connect();
  try {
    const res = await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [db]);
    return res.rows[0].n as number;
  } finally {
    await client.end();
  }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function main() {
  const dir = process.argv[2];
  if (!dir || !process.argv.includes("--confirm")) {
    console.log("Usage: npm run restore -- <backup-folder> --confirm   (stop the app first)");
    process.exit(1);
  }
  const backupDir = path.resolve(dir);
  const db = databaseName();
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

  console.log(`1/6 Verifying ${backupDir} …`);
  const manifest = await verifyBackup(backupDir);

  const open = await otherConnections(db);
  if (open > 0) throw new Error(`${open} connection(s) are open to "${db}". Stop the app (and close psql/Prisma Studio) and try again.`);

  console.log("2/6 Backing up the current data first …");
  const safety = await createBackup("pre-restore");
  console.log(`    current data saved to ${safety.dir}`);

  const tempDb = `${db}_restoring_${stamp}`;
  console.log(`3/6 Restoring into new database "${tempDb}" …`);
  await adminQuery(`CREATE DATABASE ${ident(tempDb)}`);
  await run(await findPgTool("pg_restore"), ["--no-owner", "--exit-on-error", `--dbname=${urlForDatabase(tempDb)}`, path.join(backupDir, "database.dump")], { maxBuffer: 64 * 1024 * 1024 });

  const restored = await collectCounts(urlForDatabase(tempDb));
  const mismatches = Object.entries(manifest.counts).filter(([k, v]) => restored[k] !== v);
  if (mismatches.length) {
    throw new Error(`Restored data does not match the backup (${mismatches.map(([k, v]) => `${k}: expected ${v}, got ${restored[k]}`).join("; ")}). Current database left untouched; "${tempDb}" kept for inspection.`);
  }
  console.log("    counts and totals match the backup manifest");

  const keptDb = `${db}_before_restore_${stamp}`;
  console.log(`4/6 Swapping databases (current kept as "${keptDb}") …`);
  await adminQuery(`ALTER DATABASE ${ident(db)} RENAME TO ${ident(keptDb)}`);
  await adminQuery(`ALTER DATABASE ${ident(tempDb)} RENAME TO ${ident(db)}`);

  const keptUploads = `${UPLOADS_DIR}.before-restore-${stamp}`;
  console.log(`5/6 Restoring uploads (current kept as ${path.basename(keptUploads)}) …`);
  await fs.rename(UPLOADS_DIR, keptUploads);
  await run("tar", ["-xzf", path.join(backupDir, "uploads.tar.gz"), "-C", path.dirname(UPLOADS_DIR)]);

  console.log("6/6 Applying any newer migrations …");
  const { stdout } = await run("npx", ["prisma", "migrate", "deploy"], { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: env.databaseUrl } });
  console.log(stdout.split("\n").filter((l) => /migration|applied/i.test(l)).join("\n"));

  console.log(`\nRestore complete. Previous data is still available in database "${keptDb}" and ${keptUploads}.`);
}

main().catch((err) => {
  console.error(`\nRestore FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
