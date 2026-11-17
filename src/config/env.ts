import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  sessionSecret: required("SESSION_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",
  // Where backups are written (outside the project so a re-clone or `git clean` cannot remove them)
  backupDir: process.env.BACKUP_DIR || path.join(os.homedir(), "vyapargst-backups"),
  // Folder holding pg_dump/pg_restore matching the database server version (auto-detected when unset)
  pgBinDir: process.env.PG_BIN_DIR || "",
};
