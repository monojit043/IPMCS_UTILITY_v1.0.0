const { pool, query, queryEpulse } = require('../config/db');
const lineData = require('./lineData.service');
const { drawingStatus } = require('./drawingStatus');

// mto_line_zones: what an engineer saves for one line + zone — the COSMAS
// header and the BoM rows (manual MTO / model dump), never the line data.

// COSMAS header: API name → column, max length
const HEADER = {
  contrCode: ['contr_code', 20], drgIndicator: ['drg_indicator', 1],
  drgAreaNo: ['drg_area_no', 20], drgRevNo: ['drg_rev_no', 20],
  insExtent: ['ins_extent', 40], batchNo: ['batch_no', 30],
  batchRevNo: ['batch_rev_no', 20], cleaningCode: ['cleaning_code', 20],
  insThirdParty: ['ins_third_party', 60], paintThirdParty: ['paint_third_party', 60],
};
const ZONE_COLUMNS = `
  id, folder_id AS "folderId", job_no AS "jobNo", unit_no AS "unitNo", service, lsr_no AS "lsrNo", subline_no AS "sublineNo", zone,
  ${Object.entries(HEADER).map(([k, [c]]) => `${c} AS "${k}"`).join(', ')},
  bolt_tensioning AS "boltTensioning", status, items_count AS items,
  created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"
`;
const ITEM_COLUMNS = `id, piping_class AS "pipingClass", input_code AS "inputCode", item_code AS "itemCode", dia1, dia2, qty`;
// BoM tables per tab; 'extracted' = SmartPlant P&ID reference (read-only here)
const ITEM_TABLES = { mto: 'manual_mto_data', dump: 'model_dump_data' };

const ZONE_RE = /^[A-Z0-9]{1,3}$/;
function normalizeZone(zone) {
  const z = String(zone || '').trim().toUpperCase();
  return ZONE_RE.test(z) ? z : null;
}

class InputError extends Error {}

function cleanHeader(h = {}) {
  const out = {};
  for (const [key, [col, max]] of Object.entries(HEADER)) {
    const v = h[key] === undefined || h[key] === null ? '' : String(h[key]).trim();
    if (v.length > max) throw new InputError(`${key} is longer than ${max} characters`);
    out[col] = v || null;
  }
  if (out.drg_indicator) {
    out.drg_indicator = out.drg_indicator.toUpperCase();
    if (!/^[PIGS]$/.test(out.drg_indicator)) throw new InputError('DRG Indicator must be P, I, G or S');
  }
  out.bolt_tensioning = h.boltTensioning === true;
  return out;
}

function cleanRows(rows) {
  if (!Array.isArray(rows)) throw new InputError('rows must be a list');
  if (rows.length > 2000) throw new InputError('Too many rows (max 2000)');
  const text = (v, max, name) => {
    const s = v === undefined || v === null ? '' : String(v).trim();
    if (s.length > max) throw new InputError(`${name} "${s.slice(0, 20)}…" is longer than ${max} characters`);
    return s || null;
  };
  return rows.map((r) => {
    const qty = parseFloat(r.qty);
    return [text(r.pipingClass, 40, 'Piping Class'), text(r.inputCode, 60, 'Input Code'), text(r.itemCode, 60, 'Item Code'),
      text(r.dia1, 20, 'Dia1'), text(r.dia2, 20, 'Dia2'), Number.isFinite(qty) ? qty : 0];
  });
}

const keyOf = (z) => ({ service: z.service, lsrNo: z.lsrNo, sublineNo: z.sublineNo });
const dataKey = (z) => `${z.service}|${z.lsrNo}|${z.sublineNo || ''}`;

// Saved zones of an MTO folder, each with its line data (navigation)
async function listZones(jobNo, unitNo, folder) {
  const { rows } = await query(
    `SELECT ${ZONE_COLUMNS} FROM mto_line_zones WHERE job_no = $1 AND unit_no = $2 AND folder_id = $3
     ORDER BY service, lsr_no, subline_no, zone`,
    [jobNo, unitNo, folder.id]
  );
  const data = await lineData.getLineDataBulk(jobNo, unitNo, folder.scope, rows.map(keyOf));
  return rows.map((z) => ({ ...z, line: data.get(dataKey(z)) || null }));
}

// Zones for one line: the zones ePULSE's zone plan (piping_line_list) gives
// it, plus any zone already saved in IPMCS — each with its state.
// unitHasPlan tells the page whether this unit has a zone plan at all.
async function zonesForLine(jobNo, unitNo, folder, service, lsrNo, sublineNo) {
  const seq = sublineNo ? `${lsrNo}-${sublineNo}` : lsrNo;
  const [{ rows: saved }, { rows: planned }, { rows: [plan] }] = await Promise.all([
    query(
      `SELECT id, zone, status, items_count AS items FROM mto_line_zones
       WHERE job_no = $1 AND unit_no = $2 AND service = $3 AND lsr_no = $4 AND subline_no = $5 AND folder_id = $6`,
      [jobNo, unitNo, service, lsrNo, sublineNo || '', folder.id]
    ),
    queryEpulse(
      `SELECT DISTINCT upper(zone) AS zone FROM piping_line_list
       WHERE job_no = $1 AND unit_no = $2 AND service = $3 AND seq_no = $4`,
      [jobNo, unitNo, service, seq]
    ),
    queryEpulse(`SELECT EXISTS (SELECT 1 FROM piping_line_list WHERE job_no = $1 AND unit_no = $2) AS has`, [jobNo, unitNo]),
  ]);
  const byZone = new Map(saved.map((z) => [z.zone, { ...z, planned: false }]));
  planned.forEach(({ zone }) => {
    if (byZone.has(zone)) byZone.get(zone).planned = true;
    else byZone.set(zone, { id: null, zone, status: null, items: 0, planned: true });
  });
  const zones = [...byZone.values()].sort((a, b) => a.zone.localeCompare(b.zone));
  return { zones, unitHasPlan: plan.has };
}

async function getZone(id) {
  const { rows } = await query(`SELECT ${ZONE_COLUMNS} FROM mto_line_zones WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getItems(kind, zoneId) {
  const table = kind === 'extracted' ? 'sppid_extracted_data' : ITEM_TABLES[kind];
  const { rows } = await query(`SELECT ${ITEM_COLUMNS} FROM ${table} WHERE line_zone_id = $1 ORDER BY id`, [zoneId]);
  return rows;
}

const REVISION_SUMMARY = `rev_no AS "revNo", kind, saved_by AS "savedBy", saved_at AS "savedAt", row_count AS "rowCount", note`;

async function lastRevision(zoneId) {
  const { rows } = await query(
    `SELECT ${REVISION_SUMMARY}, basis FROM mto_line_zone_revisions WHERE line_zone_id = $1 ORDER BY rev_no DESC LIMIT 1`,
    [zoneId]
  );
  return rows[0] || null;
}

// Everything the page needs for one saved zone, plus what changed in the
// line data since it was last saved (live basis vs the last revision's basis)
async function getZoneFull(id, folder) {
  const zone = await getZone(id);
  if (!zone) return null;
  const [line, mto, dump, extracted, last] = await Promise.all([
    lineData.getLineData(zone.jobNo, zone.unitNo, folder.scope, zone.service, zone.lsrNo, zone.sublineNo),
    getItems('mto', id), getItems('dump', id), getItems('extracted', id), lastRevision(id),
  ]);
  let basisChanges = [];
  if (last) {
    basisChanges = line
      ? lineData.compareBasis(last.basis, await lineData.getBasis(zone.jobNo, line, folder.scope))
      : [{ field: 'line', label: 'Line', was: last.basis.lineNo, now: 'no longer in the line list / latest P&IDs' }];
  }
  const lastRev = last ? (({ basis, ...rest }) => rest)(last) : null;
  return { zone, line, drawing: drawingStatus(line, folder), mto, dump, extracted, lastRevision: lastRev, basisChanges };
}

// Revision history of a zone (newest first) and one revision in full
async function listRevisions(zoneId) {
  const { rows } = await query(
    `SELECT ${REVISION_SUMMARY},
            basis->>'lineNo' AS "lineNo", basis->>'pipingSpec' AS "pipingClass", basis->'pids' AS pids, basis->'lineList' AS "lineList"
     FROM mto_line_zone_revisions WHERE line_zone_id = $1 ORDER BY rev_no DESC`,
    [zoneId]
  );
  return rows;
}

async function getRevision(zoneId, revNo) {
  const { rows } = await query(
    `SELECT ${REVISION_SUMMARY}, basis, header, rows FROM mto_line_zone_revisions WHERE line_zone_id = $1 AND rev_no = $2`,
    [zoneId, revNo]
  );
  return rows[0] || null;
}

// Save = upsert the line + zone with its header, and replace the BoM rows of
// one tab (kind 'mto' or 'dump') — all in one transaction.
async function saveZone({ jobNo, unitNo, empId, folder, service, lsrNo, sublineNo, zone, header, kind, rows }) {
  const z = normalizeZone(zone);
  if (!z) throw new InputError('Zone must be 1–3 letters or digits, e.g. A');
  const table = ITEM_TABLES[kind];
  if (!table) throw new InputError('kind must be mto or dump');
  const line = await lineData.getLineData(jobNo, unitNo, folder.scope, service, lsrNo, sublineNo || '');
  if (!line) throw new InputError('This line is not in the line list or on the latest P&IDs');
  const h = cleanHeader(header);
  const values = cleanRows(rows);
  const basis = await lineData.getBasis(jobNo, line, folder.scope);   // what this save is based on
  basis.folder = { id: folder.id, name: folder.name };
  basis.drawing = drawingStatus(line, folder);   // was the drawing in the folder when this was saved

  const cols = Object.keys(h);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [saved] } = await client.query(
      `INSERT INTO mto_line_zones (job_no, unit_no, service, lsr_no, subline_no, zone, ${cols.join(', ')}, created_by, updated_by, folder_id)
       VALUES ($1,$2,$3,$4,$5,$6, ${cols.map((_, i) => `$${i + 7}`).join(', ')}, $${cols.length + 7}, $${cols.length + 7}, $${cols.length + 8})
       ON CONFLICT (folder_id, job_no, unit_no, service, lsr_no, subline_no, zone)
       DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
                     updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING id, status`,
      [jobNo, unitNo, service, lsrNo, sublineNo || '', z, ...cols.map((c) => h[c]), empId, folder.id]
    );
    await client.query(`DELETE FROM ${table} WHERE line_zone_id = $1`, [saved.id]);
    for (const v of values) {
      await client.query(
        `INSERT INTO ${table} (line_zone_id, piping_class, input_code, item_code, dia1, dia2, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [saved.id, ...v]
      );
    }
    if (kind === 'mto') {
      const status = values.length ? (saved.status === 'complete' ? 'complete' : 'inprogress') : 'pending';
      await client.query(`UPDATE mto_line_zones SET items_count = $2, status = $3 WHERE id = $1`, [saved.id, values.length, status]);
    }
    // One revision per save: header + rows as saved, and the line data they were based on.
    // The zone row is locked by the upsert above, so revision numbers can't collide.
    const headerSaved = Object.fromEntries(Object.entries(HEADER).map(([k, [c]]) => [k, h[c]]).filter(([, v]) => v != null));
    if (h.bolt_tensioning) headerSaved.boltTensioning = true;
    const rowsSaved = values.map(([pipingClass, inputCode, itemCode, dia1, dia2, qty]) => ({ pipingClass, inputCode, itemCode, dia1, dia2, qty }));
    await client.query(
      `INSERT INTO mto_line_zone_revisions (line_zone_id, rev_no, kind, saved_by, basis, header, rows, row_count)
       VALUES ($1, (SELECT coalesce(max(rev_no), 0) + 1 FROM mto_line_zone_revisions WHERE line_zone_id = $1), $2, $3, $4, $5, $6, $7)`,
      [saved.id, kind, empId, JSON.stringify(basis), JSON.stringify(headerSaved), JSON.stringify(rowsSaved), rowsSaved.length]
    );
    await client.query('COMMIT');
    return getZoneFull(saved.id, folder);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Delete a line + zone: archive the zone, its rows and every revision as one
// snapshot (mto_line_zone_deletions), then delete — all in one transaction.
async function deleteZone(id, empId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [zone] } = await client.query(`SELECT * FROM mto_line_zones WHERE id = $1 FOR UPDATE`, [id]);
    if (!zone) { await client.query('ROLLBACK'); return null; }
    const part = async (sql) => (await client.query(sql, [id])).rows;
    const snapshot = {
      zone,
      manualMto: await part(`SELECT * FROM manual_mto_data WHERE line_zone_id = $1 ORDER BY id`),
      modelDump: await part(`SELECT * FROM model_dump_data WHERE line_zone_id = $1 ORDER BY id`),
      sppid: await part(`SELECT * FROM sppid_extracted_data WHERE line_zone_id = $1 ORDER BY id`),
      revisions: await part(`SELECT * FROM mto_line_zone_revisions WHERE line_zone_id = $1 ORDER BY rev_no`),
    };
    const { rows: [archived] } = await client.query(
      `INSERT INTO mto_line_zone_deletions (line_zone_id, job_no, unit_no, service, lsr_no, subline_no, zone, snapshot, reason, deleted_by, folder_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, deleted_at AS "deletedAt"`,
      [id, zone.job_no, zone.unit_no, zone.service, zone.lsr_no, zone.subline_no, zone.zone, JSON.stringify(snapshot), reason || null, empId, zone.folder_id]
    );
    await client.query(`DELETE FROM mto_line_zones WHERE id = $1`, [id]);   // rows + revisions cascade
    await client.query('COMMIT');
    return { archiveId: archived.id, deletedAt: archived.deletedAt, rows: snapshot.manualMto.length + snapshot.modelDump.length, revisions: snapshot.revisions.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { deleteZone, listZones, zonesForLine, getZone, getZoneFull, saveZone, listRevisions, getRevision, normalizeZone, InputError };
