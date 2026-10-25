const { pool, query } = require('../config/db');
const lineData = require('./lineData.service');

// mto_line_zones: what an engineer saves for one line + zone — the COSMAS
// header and the BoM rows (manual MTO / model dump), never the line data.

// COSMAS header: API name → column, max length
const HEADER = {
  contrCode: ['contr_code', 20], pipingClass: ['piping_class', 40], drgIndicator: ['drg_indicator', 1],
  drgAreaNo: ['drg_area_no', 20], drgRevNo: ['drg_rev_no', 20], insType: ['ins_type', 20],
  insExtent: ['ins_extent', 40], oprTemp1: ['opr_temp1', 30], oprTemp2: ['opr_temp2', 30],
  desTemp1: ['des_temp1', 30], desTemp2: ['des_temp2', 30], batchNo: ['batch_no', 30],
  batchRevNo: ['batch_rev_no', 20], cleaningCode: ['cleaning_code', 20],
  insThirdParty: ['ins_third_party', 60], paintThirdParty: ['paint_third_party', 60],
};
const ZONE_COLUMNS = `
  id, job_no AS "jobNo", unit_no AS "unitNo", service, lsr_no AS "lsrNo", subline_no AS "sublineNo", zone,
  ${Object.entries(HEADER).map(([k, [c]]) => `${c} AS "${k}"`).join(', ')},
  bolt_tensioning AS "boltTensioning", status, items_count AS items,
  created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"
`;
const ITEM_COLUMNS = `id, spec AS "pipingClass", input_code AS "inputCode", item_code AS "itemCode", size AS dia1, dia2, qty`;
// BoM tables per tab; 'extracted' = SmartPlant P&ID reference (read-only here)
const ITEM_TABLES = { mto: 'mto_items', dump: 'model_dump_data' };

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

// Saved zones of a unit, each with its live line data (for the summary list / navigation)
async function listZones(jobNo, unitNo) {
  const { rows } = await query(
    `SELECT ${ZONE_COLUMNS} FROM mto_line_zones WHERE job_no = $1 AND unit_no = $2
     ORDER BY service, lsr_no, subline_no, zone`,
    [jobNo, unitNo]
  );
  const data = await lineData.getLineDataBulk(jobNo, unitNo, rows.map(keyOf));
  return rows.map((z) => ({ ...z, line: data.get(dataKey(z)) || null }));
}

// Zones already saved for one line ("A" offered when none)
async function zonesForLine(jobNo, unitNo, service, lsrNo, sublineNo) {
  const { rows } = await query(
    `SELECT id, zone, status, items_count AS items FROM mto_line_zones
     WHERE job_no = $1 AND unit_no = $2 AND service = $3 AND lsr_no = $4 AND subline_no = $5 ORDER BY zone`,
    [jobNo, unitNo, service, lsrNo, sublineNo || '']
  );
  return rows;
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

// Everything the page needs for one saved zone
async function getZoneFull(id) {
  const zone = await getZone(id);
  if (!zone) return null;
  const [line, mto, dump, extracted] = await Promise.all([
    lineData.getLineData(zone.jobNo, zone.unitNo, zone.service, zone.lsrNo, zone.sublineNo),
    getItems('mto', id), getItems('dump', id), getItems('extracted', id),
  ]);
  return { zone, line, mto, dump, extracted };
}

// Save = upsert the line + zone with its header, and replace the BoM rows of
// one tab (kind 'mto' or 'dump') — all in one transaction.
async function saveZone({ jobNo, unitNo, empId, service, lsrNo, sublineNo, zone, header, kind, rows }) {
  const z = normalizeZone(zone);
  if (!z) throw new InputError('Zone must be 1–3 letters or digits, e.g. A');
  const table = ITEM_TABLES[kind];
  if (!table) throw new InputError('kind must be mto or dump');
  const line = await lineData.getLineData(jobNo, unitNo, service, lsrNo, sublineNo || '');
  if (!line) throw new InputError('This line is not in the line list or the uploaded P&IDs');
  const h = cleanHeader(header);
  const values = cleanRows(rows);

  const cols = Object.keys(h);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [saved] } = await client.query(
      `INSERT INTO mto_line_zones (job_no, unit_no, service, lsr_no, subline_no, zone, ${cols.join(', ')}, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6, ${cols.map((_, i) => `$${i + 7}`).join(', ')}, $${cols.length + 7}, $${cols.length + 7})
       ON CONFLICT (job_no, unit_no, service, lsr_no, subline_no, zone)
       DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
                     updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING id, status`,
      [jobNo, unitNo, service, lsrNo, sublineNo || '', z, ...cols.map((c) => h[c]), empId]
    );
    await client.query(`DELETE FROM ${table} WHERE line_zone_id = $1`, [saved.id]);
    for (const v of values) {
      await client.query(
        `INSERT INTO ${table} (line_zone_id, spec, input_code, item_code, size, dia2, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [saved.id, ...v]
      );
    }
    if (kind === 'mto') {
      const status = values.length ? (saved.status === 'complete' ? 'complete' : 'inprogress') : 'pending';
      await client.query(`UPDATE mto_line_zones SET items_count = $2, status = $3 WHERE id = $1`, [saved.id, values.length, status]);
    }
    await client.query('COMMIT');
    return getZoneFull(saved.id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { listZones, zonesForLine, getZone, getZoneFull, saveZone, normalizeZone, InputError };
