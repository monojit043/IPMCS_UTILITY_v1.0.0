const { query } = require('../config/db');
const { ITEM_COLUMNS } = require('./items.service');

// Items extracted from the Smart P&ID for a line — same COSMAS columns as
// MTO / dump items so the two can be compared row by row.
async function getItemsByLine(lineId) {
  const { rows } = await query(
    `SELECT ${ITEM_COLUMNS} FROM extracted_items WHERE line_id = $1 ORDER BY id`,
    [lineId]
  );
  return rows;
}

module.exports = { getItemsByLine };
