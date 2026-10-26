const { query, queryEpulse } = require('../config/db');
const lineData = require('./lineData.service');
const { drawingStatus } = require('./drawingStatus');
const { highlightedKeys, isHighlighted } = require('./highlightCheck');
const summary = require('./summary.service');
const { namesFor } = require('./auth.service');

// Downloadable reports for one job + unit, as CSV (opens in Excel).
// Line data is read live (never stored); MTO data comes from IPMCS.

const REPORTS = {
  'mto-bom': { title: 'Bill of Material (MTO)', file: 'BoM_MTO' },
  'model-dump': { title: 'Model Dump Data', file: 'Model_Dump_Data' },
  'zone-status': { title: 'Line Zone Status', file: 'Line_Zone_Status' },
  progress: { title: 'Progress — zone plan vs IPMCS', file: 'MTO_Progress' },
  pending: { title: 'Pending — planned, no MTO yet', file: 'Pending_Line_Zones' },
  revisions: { title: 'Revision History', file: 'Revision_History' },
};

// Dates in the server's local time (IST), e.g. 2026-10-25 13:36:05
const pad = (n) => String(n).padStart(2, '0');
const localTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const STATUS = { pending: 'Pending', inprogress: 'In Progress', complete: 'Complete' };
const PICKED_FROM = { line_list: 'Line list', pid: 'P&ID', 'line_list+pid': 'Line list (also on P&ID)', 'pid+parent_line': 'P&ID sub-line (P&T from parent)' };
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? localTime(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) => '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const pidsText = (pids) => (pids || []).map((p) => `${p.pidName} Rev ${p.rev ?? '—'}`).join('; ');
const lineKey = (z) => [z.contrCode, z.service, z.unitNo, z.lsrNo, z.sublineNo, z.drgIndicator, z.drgAreaNo].map((v) => v || '').join('');

// Saved line zones of the unit with live line data + latest revision
const HL_TEXT = (h) => (h === null ? 'n/a (no drawing)' : h ? 'Yes' : 'NO — not highlighted');

async function zonesWithLines(jobNo, unitNo, folder) {
  const { rows: zones } = await query(
    `SELECT z.id, z.job_no AS "jobNo", z.unit_no AS "unitNo", z.service, z.lsr_no AS "lsrNo", z.subline_no AS "sublineNo", z.zone,
            z.contr_code AS "contrCode", z.drg_indicator AS "drgIndicator", z.drg_area_no AS "drgAreaNo", z.drg_rev_no AS "drgRevNo",
            z.cleaning_code AS "cleaningCode", z.ins_extent AS "insExtent", z.ins_third_party AS "insThirdParty",
            z.paint_third_party AS "paintThirdParty", z.batch_no AS "batchNo", z.batch_rev_no AS "batchRevNo",
            z.bolt_tensioning AS "boltTensioning", z.status, z.items_count AS items,
            z.created_by AS "createdBy", z.created_at AS "createdAt", z.updated_by AS "updatedBy", z.updated_at AS "updatedAt",
            (SELECT count(*)::int FROM model_dump_data d WHERE d.line_zone_id = z.id) AS "dumpRows",
            r.rev_no AS "revNo", r.saved_by AS "revBy", r.saved_at AS "revAt", r.basis
     FROM mto_line_zones z
     LEFT JOIN LATERAL (SELECT rev_no, saved_by, saved_at, basis FROM mto_line_zone_revisions
                        WHERE line_zone_id = z.id ORDER BY rev_no DESC LIMIT 1) r ON true
     WHERE z.job_no = $1 AND z.unit_no = $2 AND z.folder_id = $3
     ORDER BY z.service, z.lsr_no, z.subline_no, z.zone`,
    [jobNo, unitNo, folder.id]
  );
  const keys = zones.map((z) => ({ service: z.service, lsrNo: z.lsrNo, sublineNo: z.sublineNo }));
  const data = await lineData.getLineDataBulk(jobNo, unitNo, folder.scope, keys);
  const lines = zones.map((z) => data.get(`${z.service}|${z.lsrNo}|${z.sublineNo || ''}`) || null);
  const bases = await lineData.getBasisBulk(jobNo, lines, folder.scope);
  const hl = await highlightedKeys(folder.id);
  return zones.map((z, i) => {
    const drawing = drawingStatus(lines[i], folder);
    return { ...z, line: lines[i], liveBasis: bases[i], drawing, highlighted: isHighlighted(hl, drawing, z.service, z.lsrNo, z.sublineNo, z.zone) };
  });
}

async function bomRows(jobNo, unitNo, folder, table) {
  const zones = await zonesWithLines(jobNo, unitNo, folder);
  const byId = new Map(zones.map((z) => [z.id, z]));
  const { rows } = await query(
    `SELECT i.line_zone_id AS zid, i.piping_class, i.input_code, i.item_code, i.dia1, i.dia2, i.qty
     FROM ${table} i JOIN mto_line_zones z ON z.id = i.line_zone_id
     WHERE z.job_no = $1 AND z.unit_no = $2 AND z.folder_id = $3 ORDER BY z.service, z.lsr_no, z.subline_no, z.zone, i.id`,
    [jobNo, unitNo, folder.id]
  );
  const header = ['Job', 'Unit', 'MTO folder', 'Drawing in folder', 'Highlighted on drawing', 'Line Key (COSMAS)', 'Line No', 'Service', 'LSR NO', 'Subline No', 'Zone',
    'Contr.Code', 'DRG Indicator', 'DRG Area No', 'DRG Rev No', 'Batch No', 'Batch Rev No',
    'Piping Class', 'Input Code', 'Item Code', 'Dia1', 'Dia2', 'Qty', 'Rev', 'Saved by', 'Saved at'];
  const out = rows.map((r) => {
    const z = byId.get(r.zid);
    return [z.jobNo, z.unitNo, folder.name, z.drawing.label, HL_TEXT(z.highlighted), lineKey(z), z.line ? z.line.lineNo : '', z.service, z.lsrNo, z.sublineNo, z.zone,
      z.contrCode, z.drgIndicator, z.drgAreaNo, z.drgRevNo, z.batchNo, z.batchRevNo,
      r.piping_class, r.input_code, r.item_code, r.dia1, r.dia2, r.qty, z.revNo, z.updatedBy, z.updatedAt];
  });
  return { header, rows: out };
}

async function zoneStatus(jobNo, unitNo, folder) {
  const zones = await zonesWithLines(jobNo, unitNo, folder);
  const { rows: plan } = await queryEpulse(`SELECT service, seq_no, upper(zone) AS zone FROM piping_line_list WHERE job_no = $1 AND unit_no = $2`, [jobNo, unitNo]);
  const planned = new Set(plan.map((p) => `${p.service}|${p.seq_no}|${p.zone}`));
  const names = await namesFor(zones.map((z) => z.updatedBy));
  const header = ['Line No', 'Service', 'LSR NO', 'Subline No', 'Zone', 'Drawing in folder', 'Highlighted on drawing', 'In zone plan', 'Status', 'MTO rows', 'Model dump rows',
    'Line Key (COSMAS)', 'Size', 'Piping Class', 'INS Type', 'Des Press', 'Des Temp', 'P&ID (latest rev)', 'Picked from',
    'Last rev', 'Last saved by', 'Last saved at', 'Line data changed since last save'];
  const rows = zones.map((z) => {
    const seq = z.sublineNo ? `${z.lsrNo}-${z.sublineNo}` : z.lsrNo;
    const changes = !z.basis ? 'no revision yet'
      : !z.line ? 'line no longer in line list / P&IDs'
      : lineData.compareBasis(z.basis, z.liveBasis).map((c) => `${c.label}: ${c.was ?? '—'} → ${c.now ?? '—'}`).join('; ');
    return [z.line ? z.line.lineNo : '', z.service, z.lsrNo, z.sublineNo, z.zone, z.drawing.label, HL_TEXT(z.highlighted),
      plan.length ? (planned.has(`${z.service}|${seq}|${z.zone}`) ? 'Yes' : 'No') : 'no plan',
      STATUS[z.status] || z.status, z.items, z.dumpRows, lineKey(z),
      z.line?.sizeIn, z.line?.pipingSpec, z.line?.insulationType, z.line?.designPressure, z.line?.designTemp,
      pidsText(z.liveBasis?.pids), PICKED_FROM[z.line?.source] || z.line?.source, z.revNo,
      names.get(String(z.updatedBy || '').toUpperCase()) || z.updatedBy, z.updatedAt, changes || 'no change'];
  });
  return { header, rows };
}

// Every line + zone of the unit as objects (the Lines window: search / delete / print)
async function overview(jobNo, unitNo, folder) {
  const zones = await zonesWithLines(jobNo, unitNo, folder);
  const { rows: plan } = await queryEpulse(`SELECT service, seq_no, upper(zone) AS zone FROM piping_line_list WHERE job_no = $1 AND unit_no = $2`, [jobNo, unitNo]);
  const planned = new Set(plan.map((p) => `${p.service}|${p.seq_no}|${p.zone}`));
  const names = await namesFor(zones.map((z) => z.updatedBy));
  return zones.map((z) => {
    const seq = z.sublineNo ? `${z.lsrNo}-${z.sublineNo}` : z.lsrNo;
    const changes = !z.basis ? []
      : !z.line ? [{ label: 'Line', was: z.basis.lineNo, now: 'no longer in the line list / latest P&IDs' }]
      : lineData.compareBasis(z.basis, z.liveBasis);
    return {
      id: z.id, lineNo: z.line ? z.line.lineNo : null, service: z.service, lsrNo: z.lsrNo, sublineNo: z.sublineNo, zone: z.zone,
      lineKey: lineKey(z), status: z.status, items: z.items, dumpRows: z.dumpRows,
      sizeIn: z.line?.sizeIn || null, pipingSpec: z.line?.pipingSpec || null,
      pids: pidsText(z.liveBasis?.pids), drawing: z.drawing, highlighted: z.highlighted, inPlan: plan.length ? planned.has(`${z.service}|${seq}|${z.zone}`) : null,
      revNo: z.revNo, savedBy: z.updatedBy, savedByName: names.get(String(z.updatedBy || '').toUpperCase()) || z.updatedBy,
      savedAt: z.updatedAt, createdBy: z.createdBy, changes,
    };
  });
}

async function progress(jobNo, unitNo, folder) {
  const s = await summary.getSummary(jobNo, unitNo, folder);
  const header = ['Zone', 'Planned (ePULSE)', 'MTO taken (IPMCS)', 'Left', 'Not in plan'];
  const rows = s.zones.map((z) => [z.zone, z.planned, z.taken, z.left, z.notInPlan]);
  rows.push(['Total', s.lineZones.planned, s.lineZones.taken, s.lineZones.left, s.lineZones.notInPlan]);
  rows.push([]);
  rows.push(['Lines', 'In zone plan', 'MTO taken', 'All zones done', 'Left', 'Lines in line list + latest P&IDs']);
  rows.push(['', s.lines.planned, s.lines.started, s.lines.complete, s.lines.left, s.lines.inSources]);
  if (!s.hasPlan) rows.push(['No zone plan for this unit in ePULSE yet (Create Piping Line List → zone allocation)']);
  return { header, rows };
}

async function pending(jobNo, unitNo, folder) {
  const [{ rows: unitPlan }, { rows: done }, folderLines] = await Promise.all([
    queryEpulse(`SELECT service, seq_no, line_no, upper(zone) AS zone, size_in, piping_spec FROM piping_line_list
                 WHERE job_no = $1 AND unit_no = $2 ORDER BY service, seq_no, zone`, [jobNo, unitNo]),
    query(`SELECT service, lsr_no, subline_no, zone, items_count FROM mto_line_zones WHERE job_no = $1 AND unit_no = $2 AND folder_id = $3`, [jobNo, unitNo, folder.id]),
    lineData.getLineKeys(jobNo, unitNo, folder.scope),
  ]);
  const plan = unitPlan.filter((p) => folderLines.has(`${p.service}|${p.seq_no}`));
  const taken = new Map(done.map((z) => [`${z.service}|${z.subline_no ? `${z.lsr_no}-${z.subline_no}` : z.lsr_no}|${z.zone}`, z.items_count]));
  const header = ['Line No (plan)', 'Service', 'LSR NO', 'Zone', 'Size', 'Piping Class', 'IPMCS'];
  const rows = plan.filter((p) => !(taken.get(`${p.service}|${p.seq_no}|${p.zone}`) > 0)).map((p) => [
    p.line_no, p.service, p.seq_no, p.zone, p.size_in, p.piping_spec,
    taken.has(`${p.service}|${p.seq_no}|${p.zone}`) ? 'saved, no MTO rows' : 'not started']);
  if (!unitPlan.length) rows.push(['No zone plan for this unit in ePULSE yet (Create Piping Line List → zone allocation)']);
  return { header, rows };
}

async function revisions(jobNo, unitNo, folder) {
  const { rows } = await query(
    `SELECT z.service, z.lsr_no, z.subline_no, z.zone, r.rev_no, r.kind, r.saved_by, r.saved_at, r.row_count, r.basis, r.header, r.note
     FROM mto_line_zone_revisions r JOIN mto_line_zones z ON z.id = r.line_zone_id
     WHERE z.job_no = $1 AND z.unit_no = $2 AND z.folder_id = $3 ORDER BY z.service, z.lsr_no, z.subline_no, z.zone, r.rev_no`,
    [jobNo, unitNo, folder.id]
  );
  const names = await namesFor(rows.map((r) => r.saved_by));
  const header = ['Service', 'LSR NO', 'Subline No', 'Zone', 'Rev', 'Tab', 'Saved by', 'Saved at', 'Rows',
    'Line No (at save)', 'Size', 'Piping Class', 'INS Type', 'Des Press', 'Des Temp', 'P&ID (rev at save)', 'Line list rev',
    'Header typed', 'Note'];
  const out = rows.map((r) => {
    const b = r.basis || {};
    return [r.service, r.lsr_no, r.subline_no, r.zone, r.rev_no, r.kind === 'dump' ? 'Model Dump' : 'MTO Input',
      names.get(String(r.saved_by || '').toUpperCase()) || r.saved_by, r.saved_at, r.row_count,
      b.lineNo, b.sizeIn, b.pipingSpec, b.insulationType, b.designPressure, b.designTemp, pidsText(b.pids),
      b.lineList ? b.lineList.revNo : '',
      Object.entries(r.header || {}).map(([k, v]) => `${k}=${v}`).join('; '), r.note];
  });
  return { header, rows: out };
}

async function build(type, jobNo, unitNo, folder) {
  const def = REPORTS[type];
  if (!def) return null;
  const t = type === 'mto-bom' ? await bomRows(jobNo, unitNo, folder, 'manual_mto_data')
    : type === 'model-dump' ? await bomRows(jobNo, unitNo, folder, 'model_dump_data')
    : type === 'zone-status' ? await zoneStatus(jobNo, unitNo, folder)
    : type === 'progress' ? await progress(jobNo, unitNo, folder)
    : type === 'pending' ? await pending(jobNo, unitNo, folder)
    : await revisions(jobNo, unitNo, folder);
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = String(folder.name).replace(/[^\w.-]+/g, '_');
  return { filename: `${jobNo}_${unitNo}_${safe}_${def.file}_${stamp}.csv`, csv: toCsv(t.header, t.rows), rows: t.rows.length };
}

module.exports = { REPORTS, build, overview };
