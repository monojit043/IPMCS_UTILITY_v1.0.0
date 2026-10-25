const { query } = require('../config/db');
const { namesFor } = require('./auth.service');

// Folders belong to one job + unit and record who made them by employee ID;
// the name is read live from PC-2.
const FOLDER_COLUMNS = `
  f.id, f.job_no AS "jobNo", f.unit_no AS "unitNo", f.name, f.created_at AS "createdAt", f.created_by AS "createdByEmpId",
  f.status, f.frozen_by AS "frozenByEmpId", f.frozen_at AS "frozenAt",
  (SELECT COUNT(*) FROM pid_folder_selections s WHERE s.folder_id = f.id)::int AS "documentCount"
`;

async function withNames(rows) {
  const names = await namesFor(rows.flatMap((r) => [r.createdByEmpId, r.frozenByEmpId]).filter(Boolean));
  const nm = (id) => (id ? names.get(String(id).toUpperCase()) || id : null);
  return rows.map((r) => ({ ...r, createdBy: nm(r.createdByEmpId), frozenBy: nm(r.frozenByEmpId) }));
}

async function getAll(jobNo, unitNo) {
  const { rows } = await query(
    `SELECT ${FOLDER_COLUMNS} FROM pid_folders f WHERE f.job_no = $1 AND f.unit_no = $2 ORDER BY f.name`,
    [jobNo, unitNo]
  );
  return withNames(rows);
}

async function getFolder(id) {
  const { rows } = await query(`SELECT ${FOLDER_COLUMNS} FROM pid_folders f WHERE f.id = $1`, [Number(id) || 0]);
  return rows[0] || null;
}

// Freezing fixes the folder: its P&ID list and their pinned revisions no
// longer change. Newer revisions go into the next MTO folder.
async function freeze(id, empId) {
  const { rowCount } = await query(
    `UPDATE pid_folders SET status = 'frozen', frozen_by = $2, frozen_at = now() WHERE id = $1 AND status = 'open'`,
    [id, empId]
  );
  return rowCount > 0;
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

// The ePULSE P&ID sheets in a folder, each pinned at one revision
// (documentId = ePULSE pid_documents.id) — the one current when it was added.
async function getSelections(folderId) {
  const { rows } = await query(
    `SELECT pims_master_index_id AS "masterIndexId", document_id AS "documentId", rev_label AS "revLabel",
            added_by AS "addedBy", added_at AS "addedAt"
     FROM pid_folder_selections WHERE folder_id = $1 ORDER BY id`,
    [folderId]
  );
  return rows;
}

async function addSelection(folderId, masterIndexId, documentId, revLabel, empId) {
  await query(
    `INSERT INTO pid_folder_selections (folder_id, pims_master_index_id, document_id, rev_label, added_by)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (folder_id, pims_master_index_id) DO NOTHING`,
    [folderId, masterIndexId, documentId, revLabel, empId]
  );
}

async function removeSelection(folderId, masterIndexId) {
  await query(
    `DELETE FROM pid_folder_selections WHERE folder_id = $1 AND pims_master_index_id = $2`,
    [folderId, masterIndexId]
  );
}

module.exports = { getAll, getFolder, create, freeze, getSelections, addSelection, removeSelection };
