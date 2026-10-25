const { queryEpulse } = require('../config/db');

// LINE DATA — read live from ePULSE every time, never stored in IPMCS, and
// always for ONE MTO FOLDER (its "scope"): the folder pins P&ID revisions, so
//   1. pid_extracted_lines — lines read off exactly those pinned revisions
//      (ePULSE keeps the lines of every revision): size, spec, insulation,
//      sub-lines (05341-01);
//   2. line_list — the line-list lines whose P&ID no. names one of the
//      folder's P&IDs: size, class, insulation, design / operating P&T. Its
//      unit_no reads "101 (PDH Unit)", so match on parent_unit or the leading
//      unit number.
// scope = { docIds: [pinned pid_documents ids], pidNames: [...], pinned: Map pidName → { rev, documentId } }
// A line is identified the COSMAS way: Service / Unit / LSR NO / Subline No.
// Letters are part of the LSR NO (05341A); a sub-line exists only on P&IDs.

// $1 job, $2 unit, $3 pinned doc ids, $4 folder P&ID names
const LL_SCOPE = `project_id = $1 AND (parent_unit = $2 OR split_part(unit_no, ' ', 1) = $2)
  AND EXISTS (SELECT 1 FROM unnest($4::text[]) n WHERE line_list.pid_no ILIKE '%' || n || '%')
  AND $3::int[] IS NOT NULL`;   // every query binds all four, so each must be typed
const PID_LINES = `
  FROM pid_extracted_lines e
  JOIN pid_master_index m ON m.id = e.master_index_id
  WHERE e.document_id = ANY($3::int[]) AND e.unit_no = $2 AND $1::text IS NOT NULL AND $4::text[] IS NOT NULL`;
const base = (jobNo, unitNo, scope) => [jobNo, unitNo, scope.docIds, scope.pidNames];

const combine = (value, unit) => (value ? [value, unit].filter(Boolean).join(' ') : null);

async function getServices(jobNo, unitNo, scope) {
  const { rows } = await queryEpulse(
    `SELECT service FROM line_list WHERE ${LL_SCOPE} AND coalesce(service, '') <> ''
     UNION
     SELECT e.service ${PID_LINES} AND coalesce(e.service, '') <> ''
     ORDER BY 1`,
    base(jobNo, unitNo, scope)
  );
  return rows.map((r) => r.service);
}

// LSR NO — the line number without any sub-line (05341, 05341A)
async function getLsrNos(jobNo, unitNo, scope, service) {
  const { rows } = await queryEpulse(
    `SELECT line_no AS lsr FROM line_list WHERE ${LL_SCOPE} AND service = $5 AND coalesce(line_no, '') <> ''
     UNION
     SELECT e.seq_no ${PID_LINES} AND e.service = $5 AND coalesce(e.seq_no, '') <> ''
     ORDER BY 1`,
    [...base(jobNo, unitNo, scope), service]
  );
  return rows.map((r) => r.lsr);
}

// Subline No. for one LSR NO — the P&ID sub-lines (01, 02…), with '' for the
// line itself when it exists without a sub-line.
async function getSublines(jobNo, unitNo, scope, service, lsrNo) {
  const { rows } = await queryEpulse(
    `SELECT '' AS sub FROM line_list WHERE ${LL_SCOPE} AND service = $5 AND line_no = $6
     UNION
     SELECT coalesce(e.sub_line, '') ${PID_LINES} AND e.service = $5 AND e.seq_no = $6
     ORDER BY 1`,
    [...base(jobNo, unitNo, scope), service, lsrNo]
  );
  return rows.map((r) => r.sub);
}

// Every line of the folder as "service|seq" (seq with "-sub-line") — summaries
async function getLineKeys(jobNo, unitNo, scope) {
  const { rows } = await queryEpulse(
    `SELECT service || '|' || line_no AS k FROM line_list WHERE ${LL_SCOPE}
     UNION
     SELECT e.service || '|' || e.seq_no || coalesce('-' || e.sub_line, '') ${PID_LINES}`,
    base(jobNo, unitNo, scope)
  );
  return new Set(rows.map((r) => r.k));
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
async function getLineData(jobNo, unitNo, scope, service, lsrNo, sublineNo = '') {
  const [{ rows: ll }, { rows: pid }] = await Promise.all([
    queryEpulse(
      `SELECT ${LL_COLUMNS} FROM line_list WHERE ${LL_SCOPE} AND service = $5 AND line_no = $6 ORDER BY id LIMIT 1`,
      [...base(jobNo, unitNo, scope), service, lsrNo]
    ),
    queryEpulse(
      `SELECT ${PID_COLUMNS} ${PID_LINES} AND e.service = $5 AND e.seq_no = $6 AND coalesce(e.sub_line, '') = $7
       ORDER BY m.pid_name, e.id`,
      [...base(jobNo, unitNo, scope), service, lsrNo, sublineNo || '']
    ),
  ]);
  return mergeSources({ unitNo, service, lsrNo, sublineNo, ll: ll[0] || null, pid });
}

// Line data for many lines of the folder at once (lists of saved zones):
// two queries, merged in memory. Returns Map "service|lsr|subline" → data.
async function getLineDataBulk(jobNo, unitNo, scope, keys) {
  const out = new Map();
  if (!keys.length) return out;
  const services = [...new Set(keys.map((k) => k.service))];
  const [{ rows: ll }, { rows: pid }] = await Promise.all([
    queryEpulse(`SELECT id, ${LL_COLUMNS} FROM line_list WHERE ${LL_SCOPE} AND service = ANY($5) ORDER BY id`, [...base(jobNo, unitNo, scope), services]),
    queryEpulse(`SELECT ${PID_COLUMNS} ${PID_LINES} AND e.service = ANY($5) ORDER BY m.pid_name, e.id`, [...base(jobNo, unitNo, scope), services]),
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

// ── Basis: the line data an MTO is based on, recorded with every save ──
const BASIS_FIELDS = {
  lineNo: 'Line No', sizeIn: 'Size', pipingSpec: 'Piping Class', insulationType: 'INS Type',
  insulationThickness: 'INS Thickness', opPressure: 'OPR Pressure', opTemp: 'OPR Temp 1', opTemp2: 'OPR Temp 2',
  designPressure: 'Des Pressure', designTemp: 'Des Temp1', designTemp2: 'Des Temp2', source: 'Source',
};

async function latestLineList(jobNo) {
  const { rows } = await queryEpulse(
    `SELECT id AS "uploadId", rev_no AS "revNo", uploaded_at AS "uploadedAt"
     FROM linelist_uploads WHERE job_no = $1 AND is_latest ORDER BY id DESC LIMIT 1`,
    [jobNo]
  );
  return rows[0] || null;
}

// The line data plus WHICH revisions it came from: the folder's pinned
// revision of each P&ID (P&IDs named by the line list but not in the folder
// have none) and the job's latest line-list upload revision.
function basisOf(line, scope, lineList) {
  const names = String(line.pidNo || '').split(',').map((s) => s.trim()).filter(Boolean).sort();
  return {
    ...Object.fromEntries(Object.keys(BASIS_FIELDS).map((k) => [k, line[k] ?? null])),
    lsrNo: line.lsrNo, sublineNo: line.sublineNo, service: line.service, unitNo: line.unitNo,
    dataMismatch: line.dataMismatch || null,
    pids: names.map((n) => {
      const p = scope.pinned.get(n);
      return p ? { pidName: n, rev: p.rev, documentId: p.documentId } : { pidName: n, rev: null, documentId: null, notInFolder: true };
    }),
    lineList,
  };
}

async function getBasis(jobNo, line, scope) {
  return basisOf(line, scope, await latestLineList(jobNo));
}

async function getBasisBulk(jobNo, lines, scope) {
  const ll = await latestLineList(jobNo);
  return lines.map((line) => (line ? basisOf(line, scope, ll) : null));
}

// What changed between a saved basis and now — [{ field, label, was, now }]
function compareBasis(saved, now) {
  if (!saved || !now) return [];
  const out = [];
  for (const [k, label] of Object.entries(BASIS_FIELDS)) {
    if ((saved[k] ?? null) !== (now[k] ?? null)) out.push({ field: k, label, was: saved[k] ?? null, now: now[k] ?? null });
  }
  const rev = (list) => new Map((list || []).map((p) => [p.pidName, p.rev]));
  const was = rev(saved.pids), cur = rev(now.pids);
  for (const name of new Set([...was.keys(), ...cur.keys()])) {
    if (was.get(name) !== cur.get(name)) {
      out.push({ field: 'pid', label: `P&ID ${name}`, was: was.has(name) ? `Rev ${was.get(name) ?? '— (not in folder)'}` : '—', now: cur.has(name) ? `Rev ${cur.get(name) ?? '— (not in folder)'}` : '—' });
    }
  }
  const llRev = (b) => (b && b.lineList ? b.lineList.revNo : null);
  if (llRev(saved) !== llRev(now)) out.push({ field: 'lineList', label: 'Line list', was: llRev(saved) == null ? '—' : `Rev ${llRev(saved)}`, now: llRev(now) == null ? '—' : `Rev ${llRev(now)}` });
  return out;
}

module.exports = {
  getServices, getLsrNos, getSublines, getLineKeys, getLineData, getLineDataBulk,
  getBasis, getBasisBulk, compareBasis, BASIS_FIELDS,
};
