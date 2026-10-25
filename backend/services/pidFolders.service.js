const { query } = require('../config/db');
const { namesFor } = require('./auth.service');

// Folders belong to one job + unit and record who made them by employee ID;
// the name is read live from PC-2.
const FOLDER_COLUMNS = `
  f.id, f.job_no AS "jobNo", f.unit_no AS "unitNo", f.name, f.created_at AS "createdAt", f.created_by AS "createdByEmpId",
  (SELECT COUNT(*) FROM pid_folder_selections s WHERE s.folder_id = f.id)::int AS "documentCount"
`;

async function withNames(rows) {
  const names = await namesFor(rows.map((r) => r.createdByEmpId));
  return rows.map((r) => ({ ...r, createdBy: names.get(String(r.createdByEmpId || '').toUpperCase()) || r.createdByEmpId }));
}

async function getAll(jobNo, unitNo) {
  const { rows } = await query(
    `SELECT ${FOLDER_COLUMNS} FROM pid_folders f WHERE f.job_no = $1 AND f.unit_no = $2 ORDER BY f.name`,
    [jobNo, unitNo]
  );
  return withNames(rows);
}

async function getFolder(id) {
  const { rows } = await query(`SELECT ${FOLDER_COLUMNS} FROM pid_folders f WHERE f.id = $1`, [id]);
  return rows[0] || null;
}

// null when the job + unit already has a folder of that name
async function create(jobNo, unitNo, name, empId) {
  const { rows } = await query(
    `INSERT INTO pid_folders (job_no, unit_no, name, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (job_no, unit_no, name) DO NOTHING RETURNING id`,
    [jobNo, unitNo, name, empId]
  );
  if (!rows.length) return null;
  return (await withNames([await getFolder(rows[0].id)]))[0];
}

// Which ePULSE P&ID sheets (master index ids) are selected into a folder.
async function getSelections(folderId) {
  const { rows } = await query(
    `SELECT pims_master_index_id AS "masterIndexId" FROM pid_folder_selections WHERE folder_id = $1 ORDER BY id`,
    [folderId]
  );
  return rows.map((r) => r.masterIndexId);
}

async function addSelection(folderId, masterIndexId, empId) {
  await query(
    `INSERT INTO pid_folder_selections (folder_id, pims_master_index_id, added_by)
     VALUES ($1,$2,$3) ON CONFLICT (folder_id, pims_master_index_id) DO NOTHING`,
    [folderId, masterIndexId, empId]
  );
}

async function removeSelection(folderId, masterIndexId) {
  await query(
    `DELETE FROM pid_folder_selections WHERE folder_id = $1 AND pims_master_index_id = $2`,
    [folderId, masterIndexId]
  );
}

module.exports = { getAll, getFolder, create, getSelections, addSelection, removeSelection };
