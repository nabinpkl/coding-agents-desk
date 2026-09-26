/* Consistent snapshot of the live database: VACUUM INTO a timestamped file
 * under <data dir>/backups. Safe while the server runs (WAL). Run inside the
 * container: node server/src/backup.ts */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = process.env.ANNOTATOR_DATA_DIR;
if (!dataDir) throw new Error("missing required environment variable ANNOTATOR_DATA_DIR");
const dir = path.join(dataDir, "backups");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `annotator-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
const db = new DatabaseSync(path.join(dataDir, "annotator.db"), { readOnly: true });
try {
  db.prepare("VACUUM INTO ?").run(file);
} finally {
  db.close();
}
console.log(file);
