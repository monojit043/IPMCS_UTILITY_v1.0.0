const { query, queryPims } = require('../config/db');

const LINE_COLUMNS = `
  id, job_no AS "jobNo", unit_no AS "unitNo", zone, line_no AS "lineNo", seq_no AS "seqNo",
  size_in AS "sizeIn", service, piping_spec AS "pipingSpec", source,
  created_by AS "createdBy", created_at AS "createdAt",
  op_pressure AS "opPressure", op_temp AS "opTemp",
  design_pressure AS "designPressure", design_temp AS "designTemp",
  insulation_type AS "insulationType", insulation_thickness AS "insulationThickness",
  status, items_count AS items
`;

const combine = (value, unit) => (value ? [value, unit].filter(Boolean).join(' ') : null);

// Process/design data lives in a different PIMS table (linelist_lines) than
// line identity (piping_line_list), keyed differently: linelist_lines has no
// zone, and its job_no is only trustworthy via the linelist_uploads join —
// pid_no on linelist_lines itself is not a reliable job_no source. Applies
// to every zone/subline of a line, since it's not tracked per-zone there.
async function getDesignData(jobNo, unitNo, service, seqNo) {
  const { rows } = await queryPims(
    `SELECT ll.operating_press, ll.operating_press_unit, ll.operating_temp, ll.operating_temp_unit,
            ll.design_press, ll.design_press_unit, ll.design_temp, ll.design_temp_unit,
            ll.insulation, ll.insulation_thickness
     FROM linelist_lines ll
     JOIN linelist_uploads lu ON lu.id = ll.upload_id
     WHERE lu.job_no = $1 AND lu.is_latest = true
       AND split_part(ll.unit_no, ' ', 1) = $2
       AND ll.service = $3 AND ll.line_no = $4
     LIMIT 1`,
    [jobNo, unitNo, service, seqNo]
  );
  const d = rows[0];
  if (!d) return {};
  return {
    opPressure: combine(d.operating_press, d.operating_press_unit),
    opTemp: combine(d.operating_temp, d.operating_temp_unit),
    designPressure: combine(d.design_press, d.design_press_unit),
    designTemp: combine(d.design_temp, d.design_temp_unit),
    insulationType: d.insulation || null,
    insulationThickness: d.insulation_thickness || null,
  };
}

// "lines" holds only lines actually brought into IPMCS for MTO work, not a
// full mirror of PIMS — so this reads locally, no PIMS call here.
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

// Browsing the cascading dropdowns queries PIMS_SQL.piping_line_list live —
// nothing is written locally just from looking around. A local lines row
// only gets created once a specific line is resolved (see resolveLine
// below), i.e. actually selected for MTO work.
async function getServices(jobNo, unitNo) {
  const { rows } = await queryPims(
    `SELECT DISTINCT service FROM piping_line_list WHERE job_no = $1 AND unit_no = $2 ORDER BY service`,
    [jobNo, unitNo]
  );
  return rows.map((r) => r.service);
}

async function getSequences(jobNo, unitNo, service) {
  const { rows } = await queryPims(
    `SELECT DISTINCT seq_no FROM piping_line_list WHERE job_no = $1 AND unit_no = $2 AND service = $3 ORDER BY seq_no`,
    [jobNo, unitNo, service]
  );
  return rows.map((r) => r.seq_no);
}

async function getZones(jobNo, unitNo, service, seqNo) {
  const { rows } = await queryPims(
    `SELECT DISTINCT zone FROM piping_line_list
     WHERE job_no = $1 AND unit_no = $2 AND service = $3 AND seq_no = $4 ORDER BY zone`,
    [jobNo, unitNo, service, seqNo]
  );
  return rows.map((r) => r.zone);
}

// The moment a line is actually selected for MTO work: pulled live from
// PIMS, then upserted into our own lines table so it has a stable local id
// to hang mto_items/dump_items/extracted_items off of. IPMCS-only tracking
// fields (status, items_count) are left untouched on conflict — only the
// PIMS-sourced identity columns are refreshed.
async function resolveLine(jobNo, unitNo, service, seqNo, zone) {
  const { rows: pimsRows } = await queryPims(
    `SELECT job_no, unit_no, zone, line_no, seq_no, size_in, service, piping_spec, source, created_by
     FROM piping_line_list
     WHERE job_no = $1 AND unit_no = $2 AND service = $3 AND seq_no = $4 AND zone = $5`,
    [jobNo, unitNo, service, seqNo, zone]
  );
  const p = pimsRows[0];
  if (!p) return null;

  const d = await getDesignData(jobNo, unitNo, service, seqNo);

  const { rows } = await query(
    `INSERT INTO lines (
       job_no, unit_no, zone, line_no, seq_no, size_in, service, piping_spec, source, created_by,
       op_pressure, op_temp, design_pressure, design_temp, insulation_type, insulation_thickness
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (job_no, unit_no, service, seq_no, zone)
     DO UPDATE SET line_no = EXCLUDED.line_no, piping_spec = EXCLUDED.piping_spec,
       size_in = EXCLUDED.size_in, source = EXCLUDED.source, created_by = EXCLUDED.created_by,
       op_pressure = EXCLUDED.op_pressure, op_temp = EXCLUDED.op_temp,
       design_pressure = EXCLUDED.design_pressure, design_temp = EXCLUDED.design_temp,
       insulation_type = EXCLUDED.insulation_type, insulation_thickness = EXCLUDED.insulation_thickness
     RETURNING ${LINE_COLUMNS}`,
    [
      p.job_no, p.unit_no, p.zone, p.line_no, p.seq_no, p.size_in, p.service, p.piping_spec, p.source, p.created_by,
      d.opPressure, d.opTemp, d.designPressure, d.designTemp, d.insulationType, d.insulationThickness,
    ]
  );
  return rows[0];
}

module.exports = {
  getAllLines, getLineById, updateLineStatus,
  getServices, getSequences, getZones, resolveLine,
};
