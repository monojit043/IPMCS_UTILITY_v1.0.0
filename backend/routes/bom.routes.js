const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const { query } = require('../config/db');

const router = express.Router();

const currentFile = async (kind) => (await query(
  `SELECT id, file_name AS "fileName", imported_at AS "importedAt", row_count AS "rowCount"
   FROM bom_item_list_files WHERE kind = $1 AND is_current`, [kind])).rows[0] || null;

// What may be entered as an Input Code in BoM entry, in sheet order:
//   items      — the standard item list (SYMBOL; rows without one left out)
//   assemblies — the assembly directory (ASMBCODE + the elements it is made of)
router.get('/item-list', asyncHandler(async (req, res) => {
  const [itemFile, asmFile] = await Promise.all([currentFile('item_list'), currentFile('assembly_directory')]);
  const { rows: items } = itemFile
    ? await query(
      `SELECT trim(symbol) AS symbol, trim(descr) AS descr, trim(elmtcd) AS elmtcd, grpcd, srno
       FROM bom_item_list WHERE file_id = $1 AND trim(symbol) <> '' ORDER BY row_no`, [itemFile.id])
    : { rows: [] };
  const { rows: parts } = asmFile
    ? await query(
      `SELECT trim(asmbcode) AS code, trim(elcd) AS elcd, diacode1, diacode2, trim(override) AS override, jtype, asqty
       FROM bom_assembly_directory WHERE file_id = $1 AND trim(asmbcode) <> '' ORDER BY row_no`, [asmFile.id])
    : { rows: [] };
  const byCode = new Map();
  parts.forEach(({ code, ...p }) => {
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(p);
  });
  res.json({
    file: itemFile, assemblyFile: asmFile, items,
    assemblies: [...byCode].map(([code, components]) => ({ code, components })),
  });
}));

module.exports = router;
