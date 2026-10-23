const { query, queryEpulse } = require('../config/db');

const LINE_COLUMNS = `
  id, job_no AS "jobNo", unit_no AS "unitNo", zone, line_no AS "lineNo", seq_no AS "seqNo",
  size_in AS "sizeIn", service, piping_spec AS "pipingSpec", source, pid_no AS "pidNo",
  data_mismatch AS "dataMismatch",
  created_by AS "createdBy", created_at AS "createdAt",
  op_pressure AS "opPressure", op_temp AS "opTemp",
  design_pressure AS "designPressure", design_temp AS "designTemp",
  insulation_type AS "insulationType", insulation_thickness AS "insulationThickness",
  status, items_count AS items
`;

const combine = (value, unit) => (value ? [value, unit].filter(Boolean).join(' ') : null);

// Where lines come from (both read live from ePULSE, nothing copied):
//   1. line_list — the uploaded line list: size, class, insulation, design /
//      operating P&T, P&ID no. Its unit_no reads "101 (PDH Unit)", so match on
//      parent_unit or the leading unit number.
//   2. pid_extracted_lines — lines read off the CURRENT revision of each
//      uploaded P&ID: size, spec, insulation only.
// Neither has a zone — zones are set by the engineer in IPMCS (see getZones).
const LL_SCOPE = `project_id = $1 AND (parent_unit = $2 OR split_part(unit_no, ' ', 1) = $2)`;
const PID_LINES = `
  FROM pid_extracted_lines e
  JOIN pid_documents d ON d.id = e.document_id AND d.status = 'current'
  JOIN pid_master_index m ON m.id = e.master_index_id AND m.status = 'active'
  WHERE m.job_no = $1 AND e.unit_no = $2`;

// A P&ID sub-line (05341-01: seq_no 05341, sub_line 01) is its own line in
// IPMCS, listed as "05341-01". Letters are part of the line no. itself
// (05341A). Design data for a sub-line comes from its parent in the line list.
const PID_SEQ = `e.seq_no || coalesce('-' || e.sub_line, '')`;
function splitSeq(seqNo) {
  const m = String(seqNo).match(/^(.+?)-(\d{1,3})$/);
  return m ? { base: m[1], subLine: m[2] } : { base: String(seqNo), subLine: null };
}

async function getServices(jobNo, unitNo) {
  const { rows } = await queryEpulse(
    `SELECT service FROM line_list WHERE ${LL_SCOPE} AND coalesce(service, '') <> ''
     UNION
     SELECT e.service ${PID_LINES} AND coalesce(e.service, '') <> ''
     ORDER BY 1`,
    [jobNo, unitNo]
  );
  return rows.map((r) => r.service);
}

async function getSequences(jobNo, unitNo, service) {
  const { rows } = await queryEpulse(
    `SELECT line_no AS seq FROM line_list WHERE ${LL_SCOPE} AND service = $3 AND coalesce(line_no, '') <> ''
     UNION
     SELECT ${PID_SEQ} ${PID_LINES} AND e.service = $3 AND coalesce(e.seq_no, '') <> ''
     ORDER BY 1`,
    [jobNo, unitNo, service]
  );
  return rows.map((r) => r.seq);
}

// Zones already in use for this line in IPMCS; "A" when it hasn't been
// worked on yet. The engineer can add more (B, C…) when a line is split.
async function getZones(jobNo, unitNo, service, seqNo) {
  const { rows } = await query(
    `SELECT DISTINCT zone FROM lines
     WHERE job_no = $1 AND unit_no = $2 AND service = $3 AND seq_no = $4 ORDER BY zone`,
    [jobNo, unitNo, service, seqNo]
  );
  return rows.length ? rows.map((r) => r.zone) : ['A'];
}

const ZONE_RE = /^[A-Z0-9]{1,3}$/;
function normalizeZone(zone) {
  const z = String(zone || '').trim().toUpperCase();
  return ZONE_RE.test(z) ? z : null;
}

// Everything both sources know about one line. Line list wins for size /
// spec / insulation; the P&ID fills gaps; any disagreement is recorded.
async function readSources(jobNo, unitNo, service, seqNo) {
  const { base, subLine } = splitSeq(seqNo);
  const [{ rows: ll }, { rows: pid }] = await Promise.all([
    queryEpulse(
      `SELECT line_size, line_class, insulation, insulation_thickness, pid_no,
              oper_press, oper_press_unit, oper_temp, oper_temp_unit,
              design_press, design_press_unit, design_temp, design_temp_unit
       FROM line_list WHERE ${LL_SCOPE} AND service = $3 AND line_no = $4
       ORDER BY id LIMIT 1`,
      [jobNo, unitNo, service, base]
    ),
    queryEpulse(
      `SELECT e.full_line_no, e.size_in, e.piping_spec, e.insul_type, m.pid_name
       ${PID_LINES} AND e.service = $3 AND e.seq_no = $4 AND e.sub_line IS NOT DISTINCT FROM $5
       ORDER BY m.pid_name, e.id`,
      [jobNo, unitNo, service, base, subLine]
    ),
  ]);
  return { ll: ll[0] || null, pid, subLine };
}

const sameValue = (a, b) => String(a || '').replace(/["\s]/g, '').toUpperCase()
  === String(b || '').replace(/["\s]/g, '').toUpperCase();
// The line list may give several sizes ("4\", 2\"") — a P&ID size matching any of them is fine
const sizeListed = (llSize, pidSize) => String(llSize || '').split(',').some((s) => sameValue(s, pidSize));

function mergeSources({ ll, pid, subLine }) {
  const p = pid[0] || {};
  // A sub-line isn't in the line list itself — its own size/spec/insulation
  // are what the P&ID shows; only P&T comes from the parent line (ll).
  const size = subLine ? p.size_in || null : ll?.line_size || p.size_in || null;
  const spec = subLine ? p.piping_spec || ll?.line_class || null : ll?.line_class || p.piping_spec || null;
  const insul = subLine ? p.insul_type || ll?.insulation || null : ll?.insulation || p.insul_type || null;

  const mismatches = [];
  if (ll && pid.length && !subLine) {
    const pidSizes = [...new Set(pid.map((r) => r.size_in).filter(Boolean))];
    const pidSpecs = [...new Set(pid.map((r) => r.piping_spec).filter(Boolean))];
    const pidInsul = [...new Set(pid.map((r) => r.insul_type).filter(Boolean))];
    const badSizes = pidSizes.filter((s) => ll.line_size && !sizeListed(ll.line_size, s));
    if (badSizes.length) mismatches.push(`Size: line list ${ll.line_size}, P&ID ${badSizes.join(', ')}`);
    const badSpecs = pidSpecs.filter((s) => ll.line_class && !sameValue(ll.line_class, s));
    if (badSpecs.length) mismatches.push(`Spec: line list ${ll.line_class}, P&ID ${badSpecs.join(', ')}`);
    const badInsul = pidInsul.filter((s) => ll.insulation && !sameValue(ll.insulation, s));
    if (badInsul.length) mismatches.push(`Insulation: line list ${ll.insulation}, P&ID ${badInsul.join(', ')}`);
  }

  const pidNames = new Set(pid.map((r) => r.pid_name));
  String(ll?.pid_no || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => pidNames.add(n));

  return {
    size, spec, insul,
    source: subLine ? (ll ? 'pid+parent_line' : 'pid') : ll && pid.length ? 'line_list+pid' : ll ? 'line_list' : 'pid',
    pidNo: [...pidNames].join(', ') || null,
    mismatch: mismatches.join('; ') || null,
    opPressure: combine(ll?.oper_press, ll?.oper_press_unit),
    opTemp: combine(ll?.oper_temp, ll?.oper_temp_unit),
    designPressure: combine(ll?.design_press, ll?.design_press_unit),
    designTemp: combine(ll?.design_temp, ll?.design_temp_unit),
    insulationThickness: ll?.insulation_thickness || null,
  };
}

// "lines" holds only lines actually brought into IPMCS for MTO work, not a
// full mirror of the line list — so this reads locally.
async function getAllLines(jobNo, unitNo) {
  const { rows } = await query(
    `SELECT ${LINE_COLUMNS} FROM lines WHERE job_no = $1 AND unit_no = $2 ORDER BY id`,
    [jobNo, unitNo]
  );
  return rows;
}

async function getLineById(id) {
  const { rows } = await query(`SELECT ${LINE_COLUMNS} FROM lines WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function updateLineStatus(id, status, itemsCount) {
  const { rows } = await query(
    `UPDATE lines SET status = $2, items_count = $3 WHERE id = $1 RETURNING ${LINE_COLUMNS}`,
    [id, status, itemsCount]
  );
  return rows[0] || null;
}

// The moment a line + zone is actually selected for MTO work: read live from
// ePULSE, then upserted into our own lines table so it has a stable local id
// to hang mto_items/dump_items/extracted_items off of. IPMCS-only tracking
// fields (status, items_count, created_by) are left untouched on conflict —
// only the source-derived columns are refreshed.
async function resolveLine(jobNo, unitNo, service, seqNo, zone, empId) {
  const z = normalizeZone(zone);
  if (!z) return null;
  const src = await readSources(jobNo, unitNo, service, seqNo);
  if (!src.pid.length && (src.subLine || !src.ll)) return null;   // a sub-line must be on a P&ID
  const m = mergeSources(src);

  const lineNo = [m.size, service, unitNo, seqNo, m.spec, m.insul].filter(Boolean).join('-');
  const { rows } = await query(
    `INSERT INTO lines (
       job_no, unit_no, zone, line_no, seq_no, size_in, service, piping_spec, source, created_by,
       op_pressure, op_temp, design_pressure, design_temp, insulation_type, insulation_thickness,
       pid_no, data_mismatch
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (job_no, unit_no, service, seq_no, zone)
     DO UPDATE SET line_no = EXCLUDED.line_no, piping_spec = EXCLUDED.piping_spec,
       size_in = EXCLUDED.size_in, source = EXCLUDED.source,
       op_pressure = EXCLUDED.op_pressure, op_temp = EXCLUDED.op_temp,
       design_pressure = EXCLUDED.design_pressure, design_temp = EXCLUDED.design_temp,
       insulation_type = EXCLUDED.insulation_type, insulation_thickness = EXCLUDED.insulation_thickness,
       pid_no = EXCLUDED.pid_no, data_mismatch = EXCLUDED.data_mismatch
     RETURNING ${LINE_COLUMNS}`,
    [
      jobNo, unitNo, z, lineNo, seqNo, m.size, service, m.spec, m.source, empId || null,
      m.opPressure, m.opTemp, m.designPressure, m.designTemp, m.insul, m.insulationThickness,
      m.pidNo, m.mismatch,
    ]
  );
  return rows[0];
}

module.exports = {
  getAllLines, getLineById, updateLineStatus,
  getServices, getSequences, getZones, resolveLine, normalizeZone,
};
