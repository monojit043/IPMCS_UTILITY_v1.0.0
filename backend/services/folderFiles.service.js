const fs = require('fs');
const crypto = require('crypto');
const { query } = require('../config/db');
const pimsPid = require('./pimsPid.service');
const { renderHighlighted } = require('./pdfHighlight.service');

// The P&ID files of a frozen MTO folder, kept IN IPMCS (mto_folder_files):
// at Freeze each P&ID's then-current revision PDF is copied out of ePULSE as
// the FRESH copy; engineers highlight on that copy, and every highlight save
// rewrites the HIGHLIGHTED copy (fresh PDF + everyone's highlights drawn in).

const META = `
  ff.id AS "fileId", ff.folder_id AS "folderId", ff.master_index_id AS "masterIndexId", ff.document_id AS "documentId",
  ff.pid_name AS "pidName", ff.rev_label AS "revLabel", ff.file_name AS "fileName",
  ff.fresh_size AS "freshSize", ff.fresh_sha256 AS "freshSha256", ff.highlighted_at AS "highlightedAt",
  (ff.highlighted_pdf IS NOT NULL) AS "hasHighlighted", ff.copied_by AS "copiedBy", ff.copied_at AS "copiedAt",
  f.name AS "folderName", f.job_no AS "jobNo", f.unit_no AS "unitNo"`;

// Reads the PDF of one ePULSE revision (doc from pimsPid.getRevision / getCurrentDocument)
function readRevisionPdf(doc) {
  const full = pimsPid.uploadPath(doc.filePath);
  if (!full || !fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}

// What Freeze takes: every active P&ID of the unit's index — those with a
// PDF now as { doc, pdf }, the rest as missing (with the reason)
async function gatherAll(jobNo, unitNo) {
  const index = await pimsPid.listIndex(jobNo, unitNo);
  const docs = [], missing = [];
  for (const e of index) {
    if (!e.documentId) { missing.push({ ...e, reason: 'No PDF uploaded' }); continue; }
    const pdf = readRevisionPdf(e);
    if (pdf) docs.push({ doc: e, pdf }); else missing.push({ ...e, reason: 'PDF file not found on disk' });
  }
  return { docs, missing };
}

async function recordMissing(client, folderId, missing) {
  for (const m of missing) {
    await client.query(
      `INSERT INTO mto_folder_missing_pids (folder_id, master_index_id, pid_name, description, reason)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (folder_id, master_index_id) DO NOTHING`,
      [folderId, m.masterIndexId, m.pidName, m.description || null, m.reason]);
  }
}

async function listMissing(folderId) {
  const { rows } = await query(
    `SELECT master_index_id AS "masterIndexId", pid_name AS "pidName", description, reason
     FROM mto_folder_missing_pids WHERE folder_id = $1 ORDER BY pid_name`, [folderId]);
  return rows;
}

// Copies the given revisions into a folder (inside the caller's transaction)
async function copyIn(client, folderId, docs, empId) {
  for (const { doc, pdf } of docs) {
    await client.query(
      `INSERT INTO mto_folder_files (folder_id, master_index_id, document_id, pid_name, rev_label, file_name,
         fresh_pdf, fresh_size, fresh_sha256, copied_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (folder_id, master_index_id) DO NOTHING`,
      [folderId, doc.masterIndexId, doc.documentId, doc.pidName, doc.revLabel, doc.fileName,
        pdf, pdf.length, crypto.createHash('sha256').update(pdf).digest('hex'), empId]
    );
  }
}

async function listFiles(folderId) {
  const { rows } = await query(
    `SELECT ${META} FROM mto_folder_files ff JOIN pid_folders f ON f.id = ff.folder_id
     WHERE ff.folder_id = $1 ORDER BY ff.pid_name`, [folderId]);
  return rows;
}

async function getFile(fileId) {
  const { rows } = await query(
    `SELECT ${META} FROM mto_folder_files ff JOIN pid_folders f ON f.id = ff.folder_id WHERE ff.id = $1`,
    [Number(fileId) || 0]);
  return rows[0] || null;
}

// The folder's copy of a given revision
async function fileForRevision(folderId, documentId) {
  const { rows } = await query(
    `SELECT ${META} FROM mto_folder_files ff JOIN pid_folders f ON f.id = ff.folder_id
     WHERE ff.folder_id = $1 AND ff.document_id = $2`, [folderId, documentId]);
  return rows[0] || null;
}

// kind: 'fresh' | 'highlighted' (highlighted falls back to fresh when nobody has highlighted yet)
async function getPdf(fileId, kind) {
  const { rows: [r] } = await query(
    `SELECT fresh_pdf, highlighted_pdf FROM mto_folder_files WHERE id = $1`, [Number(fileId) || 0]);
  if (!r) return null;
  return kind === 'highlighted' && r.highlighted_pdf ? r.highlighted_pdf : r.fresh_pdf;
}

// Rewrites the highlighted copy from the fresh copy + every highlight on it
async function refreshHighlighted(fileId) {
  const { rows: [r] } = await query(
    `SELECT ff.fresh_pdf, ff.pid_name, ff.rev_label, f.name AS folder FROM mto_folder_files ff
     JOIN pid_folders f ON f.id = ff.folder_id WHERE ff.id = $1`, [fileId]);
  if (!r) return;
  const { rows: hl } = await query(
    `SELECT emp_id, page_num, strokes FROM pid_user_highlights WHERE folder_file_id = $1 ORDER BY page_num, emp_id`, [fileId]);
  const strokes = hl.flatMap((h) => (h.strokes || []).map((s) => ({ page: h.page_num, empId: h.emp_id, stroke: s })));
  if (!strokes.length) {
    await query(`UPDATE mto_folder_files SET highlighted_pdf = NULL, highlighted_at = NULL WHERE id = $1`, [fileId]);
    return;
  }
  const pdf = await renderHighlighted(r.fresh_pdf, strokes,
    `IPMCS highlighted copy · MTO folder ${r.folder} · ${r.pid_name} Rev ${r.rev_label || '-'} · ${new Date().toLocaleString('en-IN')}`);
  await query(`UPDATE mto_folder_files SET highlighted_pdf = $2, highlighted_at = now() WHERE id = $1`, [fileId, pdf]);
}

module.exports = { gatherAll, recordMissing, listMissing, readRevisionPdf, copyIn, listFiles, getFile, fileForRevision, getPdf, refreshHighlighted };
