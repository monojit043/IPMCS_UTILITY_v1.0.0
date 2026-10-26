const { pool, query, queryEpulse } = require('../config/db');
const folderFiles = require('./folderFiles.service');
const { namesFor } = require('./auth.service');

// Folders belong to one job + unit and record who made them by employee ID;
// the name is read live from PC-2.
const FOLDER_COLUMNS = `
  f.id, f.job_no AS "jobNo", f.unit_no AS "unitNo", f.name, f.created_at AS "createdAt", f.created_by AS "createdByEmpId",
  f.status, f.frozen_by AS "frozenByEmpId", f.frozen_at AS "frozenAt", f.freeze_note AS "freezeNote",
  (SELECT COUNT(*) FROM mto_folder_files ff WHERE ff.folder_id = f.id)::int AS "fileCount",
  (SELECT COUNT(*) FROM mto_folder_missing_pids mp WHERE mp.folder_id = f.id)::int AS "missingCount",
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

// Records docs (copied in, pinned in pid_folder_selections) + missing P&IDs
async function snapshot(client, id, empId, docs, missing) {
  for (const { doc } of docs) {
    await client.query(
      `INSERT INTO pid_folder_selections (folder_id, pims_master_index_id, document_id, rev_label, added_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (folder_id, pims_master_index_id) DO UPDATE SET document_id = $3, rev_label = $4`,
      [id, doc.masterIndexId, doc.documentId, doc.revLabel, empId]);
  }
  await folderFiles.copyIn(client, id, docs, empId);
  await folderFiles.recordMissing(client, id, missing);
}

// Freezing fixes the folder: EVERY P&ID of the unit's index at the revision
// current NOW, its PDF copied into IPMCS (docs = [{ doc, pdf }]); P&IDs with
// no PDF are recorded as missing. Newer revisions go into the next folder.
async function freeze(id, empId, docs, missing) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE pid_folders SET status = 'frozen', frozen_by = $2, frozen_at = now() WHERE id = $1 AND status = 'open'`,
      [id, empId]);
    if (!rowCount) { await client.query('ROLLBACK'); return false; }
    await snapshot(client, id, empId, docs, missing);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// A folder frozen with only some P&IDs (before Freeze took all): add the
// P&IDs it lacks, at their revision current NOW; the freeze time stays and
// freeze_note says when / how it was completed. Returns { added, missing }.
async function completeFrozen(id, empId) {
  const folder = await getFolder(id);
  const { docs, missing } = await folderFiles.gatherAll(folder.jobNo, folder.unitNo);
  const { rows: have } = await query(`SELECT master_index_id AS mi FROM mto_folder_files WHERE folder_id = $1`, [id]);
  const had = new Set(have.map((h) => h.mi));
  const add = docs.filter((d) => !had.has(d.doc.masterIndexId));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await snapshot(client, id, empId, add, missing);
    const note = `Completed with all P&IDs of the index on ${new Date().toLocaleDateString('en-IN')}: ${add.length} added, ${missing.length} without PDF`;
    await client.query(`UPDATE pid_folders SET freeze_note = $2 WHERE id = $1`, [id, note]);
    await client.query('COMMIT');
    return { added: add.map((d) => `${d.doc.pidName} Rev ${d.doc.revLabel || '-'}`), missing: missing.length, note };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Rev label of a newer ePULSE revision than documentId, if there is one
async function newerRevision(masterIndexId, documentId) {
  const { rows } = await queryEpulse(
    `SELECT id, rev_label FROM pid_documents WHERE master_index_id = $1 AND status = 'current'`, [masterIndexId]);
  return rows[0] && rows[0].id !== documentId ? rows[0].rev_label : null;
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

module.exports = { getAll, getFolder, create, freeze, completeFrozen, newerRevision, getSelections, addSelection, removeSelection };
