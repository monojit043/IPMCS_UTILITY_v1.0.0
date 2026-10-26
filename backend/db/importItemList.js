// Imports the standard BoM item list (e.g. "ITEM LIST - STD.xls") into IPMCS, as is:
// the file itself (bytes) and every row of its first sheet, cell text verbatim.
// The imported list becomes the current one — the Input Code dropdown of BoM entry.
//   npm run import-item-list -- "C:\path\ITEM LIST - STD.xls" [EMPID]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { pool, epulsePool } = require('../config/db');

const COLUMNS = ['SYMBOL', 'DESCR', 'ELMTCD', 'GRPCD', 'SRNO', 'SELECTION'];

async function run() {
  const file = process.argv[2];
  const empId = process.argv[3] || null;
  if (!file || !fs.existsSync(file)) throw new Error(`Item list file not found: ${file || '(none given)'}`);
  const bytes = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');

  const wb = XLSX.read(bytes, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
  const header = (rows[0] || []).map((h) => String(h).trim().toUpperCase());
  if (COLUMNS.some((c, i) => header[i] !== c)) {
    throw new Error(`Unexpected columns ${JSON.stringify(rows[0])} — expected ${COLUMNS.join(', ')}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [same] } = await client.query(`SELECT id FROM bom_item_list_files WHERE sha256 = $1 AND is_current`, [sha]);
    if (same) {
      console.log(`This file is already the current item list (#${same.id}) — nothing to do.`);
      await client.query('ROLLBACK');
      return;
    }
    await client.query(`UPDATE bom_item_list_files SET is_current = false WHERE is_current`);
    const { rows: [f] } = await client.query(
      `INSERT INTO bom_item_list_files (file_name, file_bytes, size, sha256, sheet_name, header, row_count, imported_by, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id`,
      [path.basename(file), bytes, bytes.length, sha, sheetName, JSON.stringify(rows[0]), rows.length - 1, empId]
    );
    // every row below the header, cell text as in the sheet (Excel row number kept)
    for (let i = 1; i < rows.length; i++) {
      const cells = COLUMNS.map((_, c) => (rows[i][c] === undefined || rows[i][c] === null ? '' : String(rows[i][c])));
      await client.query(
        `INSERT INTO bom_item_list (file_id, row_no, symbol, descr, elmtcd, grpcd, srno, selection)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [f.id, i + 1, ...cells]
      );
    }
    await client.query('COMMIT');
    console.log(`Item list #${f.id} imported: ${path.basename(file)}, sheet "${sheetName}", ${rows.length - 1} rows — now current.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

run()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => Promise.all([pool.end(), epulsePool.end()]));
