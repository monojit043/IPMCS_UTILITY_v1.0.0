const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const { query } = require('../config/db');

const router = express.Router();

// The current standard item list (Input Code dropdown of BoM entry), in sheet
// order; rows without a SYMBOL are left out of the dropdown
router.get('/item-list', asyncHandler(async (req, res) => {
  const { rows: [file] } = await query(
    `SELECT id, file_name AS "fileName", imported_at AS "importedAt", row_count AS "rowCount" FROM bom_item_list_files WHERE is_current`);
  if (!file) return res.json({ file: null, items: [] });
  const { rows } = await query(
    `SELECT trim(symbol) AS symbol, trim(descr) AS descr, trim(elmtcd) AS elmtcd, grpcd, srno
     FROM bom_item_list WHERE file_id = $1 AND trim(symbol) <> '' ORDER BY row_no`, [file.id]);
  res.json({ file, items: rows });
}));

module.exports = router;
