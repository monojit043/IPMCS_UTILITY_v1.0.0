const { query } = require('../config/db');

const FOLDER_COLUMNS = `
  f.id, f.name, f.created_at AS "createdAt",
  u.name AS "createdBy",
  (SELECT COUNT(*) FROM pid_folder_selections s WHERE s.folder_id = f.id)::int AS "documentCount"
`;

async function getAll() {
  const { rows } = await query(
    `SELECT ${FOLDER_COLUMNS} FROM pid_folders f LEFT JOIN users u ON u.id = f.created_by ORDER BY f.name`
  );
  return rows;
}

async function create(name, userId) {
  const { rows } = await query(
    `INSERT INTO pid_folders (name, created_by) VALUES ($1, $2) RETURNING id`,
    [name, userId]
  );
  const { rows: full } = await query(
    `SELECT ${FOLDER_COLUMNS} FROM pid_folders f LEFT JOIN users u ON u.id = f.created_by WHERE f.id = $1`,
    [rows[0].id]
  );
  return full[0];
}

// Which PIMS P&ID sheets (master index ids) are selected into a folder.
async function getSelections(folderId) {
  const { rows } = await query(
    `SELECT pims_master_index_id AS "masterIndexId" FROM pid_folder_selections WHERE folder_id = $1 ORDER BY id`,
    [folderId]
  );
  return rows.map((r) => r.masterIndexId);
}

async function addSelection(folderId, masterIndexId, userId) {
  await query(
    `INSERT INTO pid_folder_selections (folder_id, pims_master_index_id, added_by)
     VALUES ($1,$2,$3) ON CONFLICT (folder_id, pims_master_index_id) DO NOTHING`,
    [folderId, masterIndexId, userId]
  );
}

async function removeSelection(folderId, masterIndexId) {
  await query(
    `DELETE FROM pid_folder_selections WHERE folder_id = $1 AND pims_master_index_id = $2`,
    [folderId, masterIndexId]
  );
}

module.exports = { getAll, create, getSelections, addSelection, removeSelection };
