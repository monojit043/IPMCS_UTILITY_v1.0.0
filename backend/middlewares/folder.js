const { query, queryEpulse } = require('../config/db');
const { latestScope } = require('../services/lineData.service');

// MTO is always taken inside one FROZEN MTO folder of the unit being worked
// in (MTO is kept per folder). The page sends it as X-Folder-Id; this loads
// req.folder = { id, name, status, frozenBy, frozenAt, scope, drawings }:
//   scope    = the lines open for MTO — always every line-list line + every
//              line on the job's LATEST P&IDs (lineData.latestScope)
//   drawings = the folder's own P&IDs at their frozen revisions, same shape
//              { docIds, pidNames, pinned: Map pidName → { rev, documentId, masterIndexId } }
async function loadFolder(folderId) {
  const { rows: [f] } = await query(
    `SELECT id, job_no AS "jobNo", unit_no AS "unitNo", name, status, frozen_by AS "frozenBy", frozen_at AS "frozenAt"
     FROM pid_folders WHERE id = $1`, [folderId]);
  if (!f) return null;
  const { rows: sel } = await query(
    `SELECT pims_master_index_id AS "masterIndexId", document_id AS "documentId", rev_label AS rev
     FROM pid_folder_selections WHERE folder_id = $1 AND document_id IS NOT NULL`, [folderId]);
  const { rows: docs } = sel.length
    ? await queryEpulse(
      `SELECT d.id AS "documentId", m.pid_name AS "pidName" FROM pid_documents d
       JOIN pid_master_index m ON m.id = d.master_index_id WHERE d.id = ANY($1)`, [sel.map((s) => s.documentId)])
    : { rows: [] };
  const nameOf = new Map(docs.map((d) => [d.documentId, d.pidName]));
  const pinned = new Map();
  sel.forEach((s) => { const n = nameOf.get(s.documentId); if (n) pinned.set(n, s); });
  f.drawings = { docIds: sel.map((s) => s.documentId), pidNames: [...pinned.keys()], pinned };
  const { rows: miss } = await query(`SELECT pid_name FROM mto_folder_missing_pids WHERE folder_id = $1`, [folderId]);
  f.missingPidNames = miss.map((m) => m.pid_name);   // in the index, no PDF at Freeze
  f.scope = await latestScope(f.jobNo);
  return f;
}

function requireFolder({ frozen = true } = {}) {
  return async (req, res, next) => {
    try {
      const id = Number(req.get('X-Folder-Id'));
      if (!id) return res.status(400).json({ error: 'Choose an MTO folder first' });
      const f = await loadFolder(id);
      if (!f || f.jobNo !== req.user.jobNo || f.unitNo !== req.user.unitNo) {
        return res.status(404).json({ error: 'MTO folder not found in this job / unit' });
      }
      if (frozen && f.status !== 'frozen') {
        return res.status(409).json({ error: `MTO folder "${f.name}" is not frozen yet — its Material Lead must freeze it before MTO is taken` });
      }
      req.folder = f;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireFolder, loadFolder };
