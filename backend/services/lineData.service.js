const { queryEpulse } = require('../config/db');

// LINE DATA — read live from ePULSE every time, never stored in IPMCS:
//   1. line_list — the uploaded line list: size, class, insulation, design /
//      operating P&T, P&ID no. Its unit_no reads "101 (PDH Unit)", so match on
//      parent_unit or the leading unit number.
//   2. pid_extracted_lines — lines read off the CURRENT revision of each
//      uploaded P&ID: size, spec, insulation (and sub-lines, 05341-01).
// A line is identified the COSMAS way: Service / Unit / LSR NO / Subline No.
// Letters are part of the LSR NO (05341A); a sub-line exists only on P&IDs.
const LL_SCOPE = `project_id = $1 AND (parent_unit = $2 OR split_part(unit_no, ' ', 1) = $2)`;
const PID_LINES = `
  FROM pid_extracted_lines e
  JOIN pid_documents d ON d.id = e.document_id AND d.status = 'current'
  JOIN pid_master_index m ON m.id = e.master_index_id AND m.status = 'active'
  WHERE m.job_no = $1 AND e.unit_no = $2`;

const combine = (value, unit) => (value ? [value, unit].filter(Boolean).join(' ') : null);

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

// LSR NO — the line number without any sub-line (05341, 05341A)
async function getLsrNos(jobNo, unitNo, service) {
  const { rows } = await queryEpulse(
    `SELECT line_no AS lsr FROM line_list WHERE ${LL_SCOPE} AND service = $3 AND coalesce(line_no, '') <> ''
     UNION
     SELECT e.seq_no ${PID_LINES} AND e.service = $3 AND coalesce(e.seq_no, '') <> ''
     ORDER BY 1`,
    [jobNo, unitNo, service]
  );
  return rows.map((r) => r.lsr);
}

// Subline No. for one LSR NO — the P&ID sub-lines (01, 02…), with '' for the
// line itself when it exists without a sub-line.
async function getSublines(jobNo, unitNo, service, lsrNo) {
  const { rows } = await queryEpulse(
    `SELECT '' AS sub FROM line_list WHERE ${LL_SCOPE} AND service = $3 AND line_no = $4
     UNION
     SELECT coalesce(e.sub_line, '') ${PID_LINES} AND e.service = $3 AND e.seq_no = $4
     ORDER BY 1`,
    [jobNo, unitNo, service, lsrNo]
  );
  return rows.map((r) => r.sub);
}

const LL_COLUMNS = `service, line_no, line_size, line_class, insulation, insulation_thickness, pid_no,
  oper_press, oper_press_unit, oper_temp, oper_temp_unit,
  design_press, design_press_unit, design_temp, design_temp_unit,
  min_operating_temp, min_operating_temp_unit, min_design_temp, min_design_temp_unit`;
const PID_COLUMNS = `e.service, e.seq_no, coalesce(e.sub_line, '') AS sub_line,
  e.full_line_no, e.size_in, e.piping_spec, e.insul_type, m.pid_name`;

const sameValue = (a, b) => String(a || '').replace(/["\s]/g, '').toUpperCase()
  === String(b || '').replace(/["\s]/g, '').toUpperCase();
// The line list may give several sizes ("4\", 2\"") — a P&ID size matching any of them is fine
const sizeListed = (llSize, pidSize) => String(llSize || '').split(',').some((s) => sameValue(s, pidSize));

// One line from both sources. Line list wins for size / spec / insulation and
// the P&ID fills gaps; disagreements are reported. A sub-line isn't in the
// line list — its size/spec/insulation are the P&ID's, P&T from the parent.
function mergeSources({ unitNo, service, lsrNo, sublineNo, ll, pid }) {
  if (!pid.length && (sublineNo || !ll)) return null;   // a sub-line must be on a P&ID
  const p = pid[0] || {};
  const sub = !!sublineNo;
  const size = sub ? p.size_in || null : ll?.line_size || p.size_in || null;
  const spec = sub ? p.piping_spec || ll?.line_class || null : ll?.line_class || p.piping_spec || null;
  const insul = sub ? p.insul_type || ll?.insulation || null : ll?.insulation || p.insul_type || null;

  const mismatches = [];
  if (ll && pid.length && !sub) {
    const distinct = (f) => [...new Set(pid.map((r) => r[f]).filter(Boolean))];
    const badSizes = distinct('size_in').filter((s) => ll.line_size && !sizeListed(ll.line_size, s));
    if (badSizes.length) mismatches.push(`Size: line list ${ll.line_size}, P&ID ${badSizes.join(', ')}`);
    const badSpecs = distinct('piping_spec').filter((s) => ll.line_class && !sameValue(ll.line_class, s));
    if (badSpecs.length) mismatches.push(`Spec: line list ${ll.line_class}, P&ID ${badSpecs.join(', ')}`);
    const badInsul = distinct('insul_type').filter((s) => ll.insulation && !sameValue(ll.insulation, s));
    if (badInsul.length) mismatches.push(`Insulation: line list ${ll.insulation}, P&ID ${badInsul.join(', ')}`);
  }

  const pidNames = new Set(pid.map((r) => r.pid_name));
  String(ll?.pid_no || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => pidNames.add(n));
  const seq = sub ? `${lsrNo}-${sublineNo}` : lsrNo;

  return {
    service, unitNo, lsrNo, sublineNo: sublineNo || '',
    lineNo: [size, service, unitNo, seq, spec, insul].filter(Boolean).join('-'),
    sizeIn: size, pipingSpec: spec, insulationType: insul,
    insulationThickness: ll?.insulation_thickness || null,
    opPressure: combine(ll?.oper_press, ll?.oper_press_unit),
    opTemp: combine(ll?.oper_temp, ll?.oper_temp_unit),
    opTemp2: combine(ll?.min_operating_temp, ll?.min_operating_temp_unit),
    designPressure: combine(ll?.design_press, ll?.design_press_unit),
    designTemp: combine(ll?.design_temp, ll?.design_temp_unit),
    designTemp2: combine(ll?.min_design_temp, ll?.min_design_temp_unit),
    pidNo: [...pidNames].join(', ') || null,
    source: sub ? (ll ? 'pid+parent_line' : 'pid') : ll && pid.length ? 'line_list+pid' : ll ? 'line_list' : 'pid',
    dataMismatch: mismatches.join('; ') || null,
  };
}

// The line data shown as soon as Service / Unit / LSR NO / Subline No. are chosen
async function getLineData(jobNo, unitNo, service, lsrNo, sublineNo = '') {
  const [{ rows: ll }, { rows: pid }] = await Promise.all([
    queryEpulse(
      `SELECT ${LL_COLUMNS} FROM line_list WHERE ${LL_SCOPE} AND service = $3 AND line_no = $4 ORDER BY id LIMIT 1`,
      [jobNo, unitNo, service, lsrNo]
    ),
    queryEpulse(
      `SELECT ${PID_COLUMNS} ${PID_LINES} AND e.service = $3 AND e.seq_no = $4 AND coalesce(e.sub_line, '') = $5
       ORDER BY m.pid_name, e.id`,
      [jobNo, unitNo, service, lsrNo, sublineNo || '']
    ),
  ]);
  return mergeSources({ unitNo, service, lsrNo, sublineNo, ll: ll[0] || null, pid });
}

// Line data for many lines of one unit at once (lists of saved zones):
// two queries, merged in memory. Returns Map "service|lsr|subline" → data.
async function getLineDataBulk(jobNo, unitNo, keys) {
  const out = new Map();
  if (!keys.length) return out;
  const services = [...new Set(keys.map((k) => k.service))];
  const [{ rows: ll }, { rows: pid }] = await Promise.all([
    queryEpulse(`SELECT id, ${LL_COLUMNS} FROM line_list WHERE ${LL_SCOPE} AND service = ANY($3) ORDER BY id`, [jobNo, unitNo, services]),
    queryEpulse(`SELECT ${PID_COLUMNS} ${PID_LINES} AND e.service = ANY($3) ORDER BY m.pid_name, e.id`, [jobNo, unitNo, services]),
  ]);
  const llBy = new Map();
  ll.forEach((r) => { const k = `${r.service}|${r.line_no}`; if (!llBy.has(k)) llBy.set(k, r); });
  const pidBy = new Map();
  pid.forEach((r) => { const k = `${r.service}|${r.seq_no}|${r.sub_line}`; if (!pidBy.has(k)) pidBy.set(k, []); pidBy.get(k).push(r); });
  for (const { service, lsrNo, sublineNo } of keys) {
    const key = `${service}|${lsrNo}|${sublineNo || ''}`;
    if (out.has(key)) continue;
    out.set(key, mergeSources({
      unitNo, service, lsrNo, sublineNo,
      ll: llBy.get(`${service}|${lsrNo}`) || null,
      pid: pidBy.get(key) || [],
    }));
  }
  return out;
}

module.exports = { getServices, getLsrNos, getSublines, getLineData, getLineDataBulk };
