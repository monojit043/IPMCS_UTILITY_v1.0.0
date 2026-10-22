const { queryPims } = require('../config/db');

const MASTER_INDEX_COLUMNS = `
  mi.id AS "masterIndexId", mi.job_no AS "jobNo", mi.unit_no AS "unitNo",
  mi.zone, mi.pid_name AS "pidName", mi.status
`;

const DOCUMENT_COLUMNS = `
  d.id AS "documentId", d.file_name AS "fileName", d.file_path AS "filePath",
  d.rev_label AS "revLabel", d.uploaded_by AS "uploadedBy", d.uploaded_at AS "uploadedAt"
`;

// Every active P&ID sheet for a job/unit, with its current (non-superseded)
// file revision — this is what ADMIN ticks from to build an MTO folder.
async function listAvailable(jobNo, unitNo) {
  const { rows } = await queryPims(
    `SELECT ${MASTER_INDEX_COLUMNS}, ${DOCUMENT_COLUMNS}
     FROM pid_master_index mi
     JOIN pid_documents d ON d.master_index_id = mi.id AND d.status = 'current'
     WHERE mi.job_no = $1 AND mi.unit_no = $2 AND mi.status = 'active'
     ORDER BY mi.pid_name`,
    [jobNo, unitNo]
  );
  return rows;
}

// Resolves one P&ID sheet (master index id) to its current file revision —
// always live, so a folder automatically reflects PIMS's latest revision.
async function getCurrentDocument(masterIndexId) {
  const { rows } = await queryPims(
    `SELECT ${MASTER_INDEX_COLUMNS}, ${DOCUMENT_COLUMNS}
     FROM pid_master_index mi
     JOIN pid_documents d ON d.master_index_id = mi.id AND d.status = 'current'
     WHERE mi.id = $1`,
    [masterIndexId]
  );
  return rows[0] || null;
}

// Which P&ID sheet a given line is actually drawn on. Reuses the same
// linelist_lines join as lines.service.js getDesignData (job_no only
// trustworthy via linelist_uploads, unit_no normalized), but pulls pid_no
// instead of process data, then matches it against pid_master_index.pid_name.
async function findForLine(jobNo, unitNo, service, seqNo) {
  const { rows: llRows } = await queryPims(
    `SELECT ll.pid_no
     FROM linelist_lines ll
     JOIN linelist_uploads lu ON lu.id = ll.upload_id
     WHERE lu.job_no = $1 AND lu.is_latest = true
       AND split_part(ll.unit_no, ' ', 1) = $2
       AND ll.service = $3 AND ll.line_no = $4
     LIMIT 1`,
    [jobNo, unitNo, service, seqNo]
  );
  const pidNo = llRows[0] && llRows[0].pid_no;
  if (!pidNo) return null;

  const { rows } = await queryPims(
    `SELECT ${MASTER_INDEX_COLUMNS}, ${DOCUMENT_COLUMNS}
     FROM pid_master_index mi
     JOIN pid_documents d ON d.master_index_id = mi.id AND d.status = 'current'
     WHERE mi.job_no = $1 AND mi.unit_no = $2 AND mi.pid_name = $3
     LIMIT 1`,
    [jobNo, unitNo, pidNo]
  );
  return rows[0] || null;
}

module.exports = { listAvailable, getCurrentDocument, findForLine };
