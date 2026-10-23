const { query } = require('../config/db');

// MTO items and dump items are the same shape, in COSMAS Bill of Material
// terms: Piping Class | Input Code | Item Code | Dia1 | Dia2 | Qty.
// (spec / size are the existing columns for Piping Class / Dia1.)
const ITEM_COLUMNS = `
  id, line_id AS "lineId", spec AS "pipingClass", input_code AS "inputCode",
  item_code AS "itemCode", size AS dia1, dia2, qty
`;

const FIELDS = { pipingClass: 'spec', inputCode: 'input_code', itemCode: 'item_code', dia1: 'size', dia2: 'dia2', qty: 'qty' };

const clean = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
function cleanQty(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function makeItemsService(table) {
  async function getItemsByLine(lineId) {
    const { rows } = await query(`SELECT ${ITEM_COLUMNS} FROM ${table} WHERE line_id = $1 ORDER BY id`, [lineId]);
    return rows;
  }

  async function addItem(lineId, item = {}) {
    const { rows } = await query(
      `INSERT INTO ${table} (line_id, spec, input_code, item_code, size, dia2, qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${ITEM_COLUMNS}`,
      [lineId, clean(item.pipingClass), clean(item.inputCode), clean(item.itemCode),
        clean(item.dia1), clean(item.dia2), cleanQty(item.qty)]
    );
    return rows[0];
  }

  // Partial update — only the fields sent are changed
  async function updateItem(itemId, fields = {}) {
    const sets = [];
    const params = [itemId];
    for (const [key, col] of Object.entries(FIELDS)) {
      if (!(key in fields)) continue;
      params.push(key === 'qty' ? cleanQty(fields[key]) : clean(fields[key]));
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) {
      const { rows } = await query(`SELECT ${ITEM_COLUMNS} FROM ${table} WHERE id = $1`, [itemId]);
      return rows[0] || null;
    }
    const { rows } = await query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 RETURNING ${ITEM_COLUMNS}`, params);
    return rows[0] || null;
  }

  async function deleteItem(itemId) {
    const { rowCount } = await query(`DELETE FROM ${table} WHERE id = $1`, [itemId]);
    return rowCount > 0;
  }

  return { getItemsByLine, addItem, updateItem, deleteItem };
}

module.exports = { makeItemsService, ITEM_COLUMNS, FIELDS };
