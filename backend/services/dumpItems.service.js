const { query } = require('../config/db');

const ITEM_COLUMNS = `
  id, line_id AS "lineId", category AS cat, description AS desc,
  size, spec, sch, unit, qty, remarks AS rem
`;

async function getItemsByLine(lineId) {
  const { rows } = await query(
    `SELECT ${ITEM_COLUMNS} FROM dump_items WHERE line_id = $1 ORDER BY id`,
    [lineId]
  );
  return rows;
}

async function addItem(lineId, item) {
  const { rows } = await query(
    `INSERT INTO dump_items (line_id, category, description, size, spec, sch, unit, qty, remarks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING ${ITEM_COLUMNS}`,
    [lineId, item.cat, item.desc, item.size, item.spec, item.sch, item.unit, item.qty, item.rem || '']
  );
  return rows[0];
}

async function updateItemQty(itemId, qty) {
  const { rows } = await query(
    `UPDATE dump_items SET qty = $2 WHERE id = $1 RETURNING ${ITEM_COLUMNS}`,
    [itemId, qty]
  );
  return rows[0] || null;
}

async function deleteItem(itemId) {
  const { rowCount } = await query(`DELETE FROM dump_items WHERE id = $1`, [itemId]);
  return rowCount > 0;
}

module.exports = { getItemsByLine, addItem, updateItemQty, deleteItem };
