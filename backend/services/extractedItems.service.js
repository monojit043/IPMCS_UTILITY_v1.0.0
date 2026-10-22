const { query } = require('../config/db');

const ITEM_COLUMNS = `
  id, line_id AS "lineId", description AS desc, size, spec, sch, unit, qty
`;

async function getItemsByLine(lineId) {
  const { rows } = await query(
    `SELECT ${ITEM_COLUMNS} FROM extracted_items WHERE line_id = $1 ORDER BY id`,
    [lineId]
  );
  return rows;
}

module.exports = { getItemsByLine };
