// make_release.js step: puts the CURRENT standard BoM lists of this PC's IPMCS (the .xls files
// themselves, as imported) into the package, deploy/production/data/<kind>/<file name>.
// On production, load_reference_lists.js imports them with db/importBomList.js.
const fs = require('fs');
const path = require('path');
const { ROOT, readEnv, dbConfig, appRequire, main } = require('./production/lib');

main(async () => {
  const staging = process.argv[2];
  const { Client } = appRequire(ROOT, 'pg');
  const db = new Client(dbConfig(readEnv(ROOT)));
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT kind, file_name, file_bytes, row_count FROM bom_item_list_files WHERE is_current ORDER BY kind`);
    for (const r of rows) {
      const out = path.join(staging, 'deploy', 'production', 'data', r.kind, r.file_name);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, r.file_bytes);
      console.log(`Standard list: ${r.kind} — ${r.file_name} (${r.row_count} rows)`);
    }
    if (!rows.length) console.log('No standard BoM lists imported on this PC — none packed.');
  } finally {
    await db.end();
  }
});
