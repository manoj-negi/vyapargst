/* eslint-disable no-console */
// Usage: npm run backup [-- label]
import { createBackup, verifyBackup } from "../services/backup/backup";

async function main() {
  const label = process.argv[2] || "manual";
  const { dir, manifest } = await createBackup(label);
  await verifyBackup(dir);
  console.log(`Backup written and verified: ${dir}`);
  console.table(manifest.counts);
}

main().catch((err) => {
  console.error(`Backup FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
