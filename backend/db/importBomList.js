// Imports a standard BoM reference list into IPMCS, as is: the file itself
// (bytes) and every row of its first sheet, cell text verbatim. The imported
// file becomes the current one of its kind; both kinds feed the Input Code
// dropdown of BoM entry.
//   npm run import-item-list    -- "C:\path\ITEM LIST - STD.xls" [EMPID]
//   npm run import-assembly-dir -- "C:\path\IPMCS Assembly Directory.xls" [EMPID]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { pool, epulsePool } = require('../config/db');

const KINDS = {
  // item symbols (SYMBOL = an Input Code)
  item_list: {
    table: 'bom_item_list',
    columns: ['SYMBOL', 'DESCR', 'ELMTCD', 'GRPCD', 'SRNO', 'SELECTION'],
  },
  // assemblies (ASMBCODE = an Input Code), one row per component
  assembly_directory: {
    table: 'bom_assembly_directory',
    columns: ['ASMBCODE', 'ELCD', 'DIACODE1', 'DIACODE2', 'OVERRIDE', 'JTYPE', 'ASQTY'],
  },
};

async function run() {
  const [kind, file, empId = null] = process.argv.slice(2);
  const def = KINDS[kind];
  if (!def) throw new Error(`Unknown list kind "${kind}" — one of ${Object.keys(KINDS).join(', ')}`);
  if (!file || !fs.existsSync(file)) throw new Error(`File not found: ${file || '(none given)'}`);
  const bytes = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');

  const wb = XLSX.read(bytes, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
  const header = (rows[0] || []).map((h) => String(h).trim().toUpperCase());
  if (def.columns.some((c, i) => header[i] !== c)) {
    throw new Error(`Unexpected columns ${JSON.stringify(rows[0])} — expected ${def.columns.join(', ')}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [same] } = await client.query(
      `SELECT id FROM bom_item_list_files WHERE kind = $1 AND sha256 = $2 AND is_current`, [kind, sha]);
    if (same) {
      console.log(`This file is already the current ${kind} (#${same.id}) — nothing to do.`);
      await client.query('ROLLBACK');
      return;
    }
    await client.query(`UPDATE bom_item_list_files SET is_current = false WHERE kind = $1 AND is_current`, [kind]);
    const { rows: [f] } = await client.query(
      `INSERT INTO bom_item_list_files (kind, file_name, file_bytes, size, sha256, sheet_name, header, row_count, imported_by, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING id`,
      [kind, path.basename(file), bytes, bytes.length, sha, sheetName, JSON.stringify(rows[0]), rows.length - 1, empId]
    );
    // every row below the header, cell text as in the sheet (Excel row number kept)
    const cols = def.columns.map((c) => c.toLowerCase());
    for (let i = 1; i < rows.length; i++) {
      const cells = cols.map((_, c) => (rows[i][c] === undefined || rows[i][c] === null ? '' : String(rows[i][c])));
      await client.query(
        `INSERT INTO ${def.table} (file_id, row_no, ${cols.join(', ')})
         VALUES ($1, $2, ${cols.map((_, c) => `$${c + 3}`).join(', ')})`,
        [f.id, i + 1, ...cells]
      );
    }
    await client.query('COMMIT');
    console.log(`${kind} #${f.id} imported: ${path.basename(file)}, sheet "${sheetName}", ${rows.length - 1} rows — now current.`);
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
