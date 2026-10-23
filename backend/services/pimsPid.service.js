const { queryEpulse } = require('../config/db');

// P&IDs come from ePULSE's P&ID module (index + uploaded drawings), read
// live — IPMCS keeps no copy. Only the CURRENT revision of an ACTIVE sheet.
const MASTER_INDEX_COLUMNS = `
  mi.id AS "masterIndexId", mi.job_no AS "jobNo", mi.unit_no AS "unitNo",
  mi.zone, mi.pid_name AS "pidName", mi.description, mi.status
`;

const DOCUMENT_COLUMNS = `
  d.id AS "documentId", d.file_name AS "fileName", d.file_path AS "filePath",
  d.rev_label AS "revLabel", d.uploaded_by AS "uploadedBy", d.uploaded_at AS "uploadedAt"
`;

const CURRENT_SHEETS = `
  FROM pid_master_index mi
  JOIN pid_documents d ON d.master_index_id = mi.id AND d.status = 'current'`;

// Every active P&ID sheet for a job/unit, with its current (non-superseded)
// file revision — this is what ADMIN ticks from to build an MTO folder.
async function listAvailable(jobNo, unitNo) {
  const { rows } = await queryEpulse(
    `SELECT ${MASTER_INDEX_COLUMNS}, ${DOCUMENT_COLUMNS} ${CURRENT_SHEETS}
     WHERE mi.job_no = $1 AND mi.unit_no = $2 AND mi.status = 'active'
     ORDER BY mi.pid_name`,
    [jobNo, unitNo]
  );
  return rows;
}

// Resolves one P&ID sheet (master index id) to its current file revision —
// always live, so a folder automatically reflects the latest revision.
async function getCurrentDocument(masterIndexId) {
  const { rows } = await queryEpulse(
    `SELECT ${MASTER_INDEX_COLUMNS}, ${DOCUMENT_COLUMNS} ${CURRENT_SHEETS}
     WHERE mi.id = $1`,
    [masterIndexId]
  );
  return rows[0] || null;
}

// Which P&ID sheet a line is drawn on. First choice: a current drawing the
// line was actually read off (pid_extracted_lines). Otherwise the P&ID no(s).
// the line list gives for it (may be "A, B"). Any job's unit — a unit-101
// line can sit on a P&ID filed under another unit.
async function findForLine(jobNo, unitNo, service, seqNo) {
  const { rows } = await queryEpulse(
    `SELECT ${MASTER_INDEX_COLUMNS}, ${DOCUMENT_COLUMNS} ${CURRENT_SHEETS}
     JOIN pid_extracted_lines e ON e.document_id = d.id
     WHERE mi.job_no = $1 AND mi.status = 'active'
       AND e.unit_no = $2 AND e.service = $3
       AND e.seq_no || coalesce('-' || e.sub_line, '') = $4   -- sub-lines are listed as "05341-01"
     ORDER BY mi.pid_name
     LIMIT 1`,
    [jobNo, unitNo, service, seqNo]
  );
  if (rows[0]) return rows[0];

  const { rows: ll } = await queryEpulse(
    `SELECT pid_no FROM line_list
     WHERE project_id = $1 AND (parent_unit = $2 OR split_part(unit_no, ' ', 1) = $2)
       AND service = $3 AND line_no = $4 AND coalesce(pid_no, '') <> ''
     ORDER BY id LIMIT 1`,
    [jobNo, unitNo, service, seqNo]
  );
  const names = String(ll[0]?.pid_no || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return null;

  const { rows: docs } = await queryEpulse(
    `SELECT ${MASTER_INDEX_COLUMNS}, ${DOCUMENT_COLUMNS} ${CURRENT_SHEETS}
     WHERE mi.job_no = $1 AND mi.status = 'active' AND mi.pid_name = ANY($2)
     ORDER BY array_position($2::text[], mi.pid_name::text)
     LIMIT 1`,
    [jobNo, names]
  );
  return docs[0] || null;
}

module.exports = { listAvailable, getCurrentDocument, findForLine };
