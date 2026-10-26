const path = require('path');
const { queryEpulse } = require('../config/db');

// Full path of an ePULSE upload — pid_documents.file_path ("B862/101/PID/…pdf")
// is relative to ePULSE's uploads folder (EPULSE_UPLOADS_ROOT). null if outside it.
function uploadPath(filePath) {
  const root = process.env.EPULSE_UPLOADS_ROOT;
  if (!root) throw new Error('EPULSE_UPLOADS_ROOT is not configured');
  const base = path.resolve(root);
  const full = path.resolve(base, filePath || '');
  return full.startsWith(base + path.sep) ? full : null;
}

// P&IDs come from ePULSE's P&ID module (index + uploaded drawings), read
// live; only a frozen MTO folder keeps copies (services/folderFiles.service.js).
const MASTER_INDEX_COLUMNS = `
  mi.id AS "masterIndexId", mi.job_no AS "jobNo", mi.unit_no AS "unitNo",
  mi.zone, mi.pid_name AS "pidName", mi.description, mi.status
`;

const DOCUMENT_COLUMNS = `
  d.id AS "documentId", d.file_name AS "fileName", d.file_path AS "filePath",
  d.rev_label AS "revLabel", d.uploaded_by AS "uploadedBy", d.uploaded_at AS "uploadedAt"
`;

// The unit's whole P&ID index (active sheets), each with its current
// revision when ePULSE has a PDF for it (documentId null when it hasn't)
async function listIndex(jobNo, unitNo) {
  const { rows } = await queryEpulse(
    `SELECT ${MASTER_INDEX_COLUMNS}, d.id AS "documentId", d.file_name AS "fileName", d.file_path AS "filePath",
            d.rev_label AS "revLabel", d.uploaded_by AS "uploadedBy", d.uploaded_at AS "uploadedAt"
     FROM pid_master_index mi
     LEFT JOIN pid_documents d ON d.master_index_id = mi.id AND d.status = 'current'
     WHERE mi.job_no = $1 AND mi.unit_no = $2 AND mi.status = 'active'
     ORDER BY mi.pid_name`,
    [jobNo, unitNo]
  );
  return rows;
}

// One drawing REVISION (ePULSE pid_documents.id), current or superseded —
// a frozen MTO folder keeps the revision it was frozen with. isCurrent tells
// whether ePULSE has a newer one since.
async function getRevision(documentId) {
  const { rows } = await queryEpulse(
    `SELECT ${MASTER_INDEX_COLUMNS}, ${DOCUMENT_COLUMNS}, d.status = 'current' AS "isCurrent",
            (SELECT c.rev_label FROM pid_documents c WHERE c.master_index_id = mi.id AND c.status = 'current' LIMIT 1) AS "currentRevLabel",
            (SELECT c.id FROM pid_documents c WHERE c.master_index_id = mi.id AND c.status = 'current' LIMIT 1) AS "currentDocumentId"
     FROM pid_documents d JOIN pid_master_index mi ON mi.id = d.master_index_id
     WHERE d.id = $1`,
    [Number(documentId) || 0]
  );
  return rows[0] || null;
}

// Which of an MTO folder's drawings (scope = folder.drawings) a line is on. First choice: a
// pinned revision the line was actually read off (pid_extracted_lines).
// Otherwise the P&ID no(s). the line list gives for it (may be "A, B"),
// if the folder holds them.
async function findForLine(jobNo, unitNo, scope, service, seqNo) {
  if (!scope.docIds.length) return null;
  const { rows } = await queryEpulse(
    `SELECT DISTINCT e.document_id AS id, m.pid_name FROM pid_extracted_lines e
     JOIN pid_master_index m ON m.id = e.master_index_id
     WHERE e.document_id = ANY($3::int[]) AND m.job_no = $1
       AND e.unit_no = $2 AND e.service = $4
       AND e.seq_no || coalesce('-' || e.sub_line, '') = $5   -- sub-lines are listed as "05341-01"
     ORDER BY m.pid_name LIMIT 1`,
    [jobNo, unitNo, scope.docIds, service, seqNo]
  );
  if (rows[0]) return getRevision(rows[0].id);

  const { rows: ll } = await queryEpulse(
    `SELECT pid_no FROM line_list
     WHERE project_id = $1 AND (parent_unit = $2 OR split_part(unit_no, ' ', 1) = $2)
       AND service = $3 AND line_no = $4 AND coalesce(pid_no, '') <> ''
     ORDER BY id LIMIT 1`,
    [jobNo, unitNo, service, seqNo]
  );
  const names = String(ll[0]?.pid_no || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    const hit = [...scope.pinned.keys()].find((p) => p === n || p.includes(n) || n.includes(p));
    if (hit) return getRevision(scope.pinned.get(hit).documentId);
  }
  return null;
}

module.exports = { uploadPath, listIndex, getRevision, findForLine };
