require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { pool, epulsePool, query, queryEpulse } = require('../config/db');

// Nothing is seeded: the team of a job + unit starts from its Leads (GL / SGL
// on PC-2, read live), who appoint Material Leads and JEs in IPMCS.
async function run() {
  console.log('Running schema.sql ...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(schema);
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM ipmcs_user_assignments`);
  console.log(`IPMCS team assignments (ML / JE): ${n}`);

  // P&ID folders made before folders were per job + unit: take the job + unit
  // of the P&IDs in them (read from ePULSE). A folder whose P&IDs disagree, or
  // that is empty, is left unassigned and reported.
  const { rows: loose } = await query(`SELECT id, name FROM pid_folders WHERE job_no IS NULL OR unit_no IS NULL`);
  for (const f of loose) {
    const { rows: sel } = await query(`SELECT pims_master_index_id AS id FROM pid_folder_selections WHERE folder_id = $1`, [f.id]);
    const { rows: scopes } = sel.length
      ? await queryEpulse(`SELECT DISTINCT job_no, unit_no FROM pid_master_index WHERE id = ANY($1)`, [sel.map((s) => s.id)])
      : { rows: [] };
    if (scopes.length === 1) {
      await query(`UPDATE pid_folders SET job_no = $2, unit_no = $3 WHERE id = $1`, [f.id, scopes[0].job_no, scopes[0].unit_no]);
      console.log(`P&ID folder "${f.name}" → ${scopes[0].job_no} / ${scopes[0].unit_no}`);
    } else {
      console.warn(`P&ID folder "${f.name}" (id ${f.id}) has ${scopes.length ? 'P&IDs of several job/units' : 'no P&IDs'} — left without a job/unit; it is not shown until fixed.`);
    }
  }
  // Folders made before revisions were pinned: pin each P&ID at the revision
  // that is current now (that is what was being worked on).
  const pinCurrent = async (table, masterCol, docCol, revCol) => {
    const { rows } = await query(`SELECT DISTINCT ${masterCol} AS mi FROM ${table} WHERE ${docCol} IS NULL`);
    if (!rows.length) return;
    const { rows: cur } = await queryEpulse(
      `SELECT master_index_id AS mi, id, rev_label FROM pid_documents WHERE status = 'current' AND master_index_id = ANY($1)`,
      [rows.map((r) => r.mi)]);
    for (const c of cur) {
      await query(`UPDATE ${table} SET ${docCol} = $2${revCol ? `, ${revCol} = $3` : ''} WHERE ${masterCol} = $1 AND ${docCol} IS NULL`,
        revCol ? [c.mi, c.id, c.rev_label] : [c.mi, c.id]);
    }
    console.log(`${table}: pinned ${cur.length} P&ID(s) at their current revision`);
  };
  await pinCurrent('pid_folder_selections', 'pims_master_index_id', 'document_id', 'rev_label');
  await pinCurrent('pid_user_highlights', 'document_id', 'revision_doc_id', null);
  await pinCurrent('pid_zone_breaks', 'document_id', 'revision_doc_id', null);

  // MTO saved before folders: into the unit's first folder (user's choice: MTO-1)
  const { rows: loose2 } = await query(`SELECT DISTINCT job_no, unit_no FROM mto_line_zones WHERE folder_id IS NULL`);
  for (const u of loose2) {
    const { rows: [fold] } = await query(`SELECT id, name FROM pid_folders WHERE job_no = $1 AND unit_no = $2 ORDER BY created_at, id LIMIT 1`, [u.job_no, u.unit_no]);
    if (!fold) { console.warn(`MTO of ${u.job_no} / ${u.unit_no} has no folder to go into — left unassigned (not shown)`); continue; }
    const { rowCount } = await query(`UPDATE mto_line_zones SET folder_id = $3 WHERE job_no = $1 AND unit_no = $2 AND folder_id IS NULL`, [u.job_no, u.unit_no, fold.id]);
    console.log(`${rowCount} line + zone(s) of ${u.job_no} / ${u.unit_no} moved into folder "${fold.name}"`);
  }

  // Folders frozen before their P&IDs were copied into IPMCS: copy the
  // revision each was frozen at (pinned document_id) now.
  const pimsPid = require('../services/pimsPid.service');
  const folderFiles = require('../services/folderFiles.service');
  const { rows: bare } = await query(
    `SELECT f.id, f.name, f.frozen_by FROM pid_folders f WHERE f.status = 'frozen'
     AND EXISTS (SELECT 1 FROM pid_folder_selections s WHERE s.folder_id = f.id
                 AND NOT EXISTS (SELECT 1 FROM mto_folder_files ff WHERE ff.folder_id = f.id AND ff.master_index_id = s.pims_master_index_id))`);
  for (const f of bare) {
    const { rows: sel } = await query(`SELECT pims_master_index_id AS mi, document_id FROM pid_folder_selections WHERE folder_id = $1`, [f.id]);
    const docs = [];
    for (const s of sel) {
      const doc = s.document_id ? await pimsPid.getRevision(s.document_id) : null;
      const pdf = doc && folderFiles.readRevisionPdf(doc);
      if (pdf) docs.push({ doc, pdf }); else console.warn(`Folder "${f.name}": no PDF for P&ID #${s.mi} (revision ${s.document_id}) — not copied`);
    }
    const client = await pool.connect();
    try {
      await folderFiles.copyIn(client, f.id, docs, f.frozen_by);
    } finally {
      client.release();
    }
    console.log(`Folder "${f.name}": ${docs.length} P&ID file(s) copied into IPMCS`);
  }

  // Highlights made before copies existed: onto the first frozen folder's copy of the same revision
  for (const table of ['pid_user_highlights', 'pid_zone_breaks']) {
    const { rowCount } = await query(
      `UPDATE ${table} h SET folder_file_id = (
         SELECT ff.id FROM mto_folder_files ff WHERE ff.document_id = h.revision_doc_id ORDER BY ff.folder_id, ff.id LIMIT 1)
       WHERE h.folder_file_id IS NULL
         AND EXISTS (SELECT 1 FROM mto_folder_files ff WHERE ff.document_id = h.revision_doc_id)`);
    if (rowCount) console.log(`${table}: ${rowCount} row(s) attached to a folder copy`);
  }
  const { rows: stale } = await query(
    `SELECT DISTINCT h.folder_file_id AS id FROM pid_user_highlights h JOIN mto_folder_files ff ON ff.id = h.folder_file_id
     WHERE ff.highlighted_at IS NULL OR ff.highlighted_at < h.updated_at`);
  for (const s of stale) await folderFiles.refreshHighlighted(s.id);
  if (stale.length) console.log(`${stale.length} highlighted PDF copy(ies) written`);
  const { rows: [{ n: loose3 }] } = await query(`SELECT count(*)::int AS n FROM pid_user_highlights WHERE folder_file_id IS NULL`);
  if (loose3) console.log(`${loose3} older highlight row(s) are on no frozen folder copy — kept, not shown`);

  console.log('Done.');
  await Promise.all([pool.end(), epulsePool.end()]);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
