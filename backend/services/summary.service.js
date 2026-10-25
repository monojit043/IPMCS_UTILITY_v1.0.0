const { query, queryEpulse } = require('../config/db');
const lineData = require('./lineData.service');

// MTO progress of one MTO folder: ePULSE's zone PLAN (piping_line_list, made
// in ePULSE → Create Piping Line List → zone allocation) for the lines on the
// folder's pinned P&IDs, side by side with what IPMCS has DONE in that folder
// (line + zones saved with at least one MTO row).
// A line is matched on service + LSR NO (+ "-" sub-line), zones on their letter.

const keyOf = (service, seq) => `${String(service || '').trim()}|${String(seq || '').trim()}`;

async function getSummary(jobNo, unitNo, folder) {
  const [{ rows: unitPlan }, { rows: done }, folderLines] = await Promise.all([
    queryEpulse(
      `SELECT service, seq_no, line_no, zone FROM piping_line_list WHERE job_no = $1 AND unit_no = $2`,
      [jobNo, unitNo]
    ),
    query(
      `SELECT service, lsr_no, subline_no, zone, items_count, status FROM mto_line_zones
       WHERE job_no = $1 AND unit_no = $2 AND folder_id = $3`,
      [jobNo, unitNo, folder.id]
    ),
    lineData.getLineKeys(jobNo, unitNo, folder.scope),   // every line on the folder's P&IDs
  ]);
  const plan = unitPlan.filter((p) => folderLines.has(keyOf(p.service, p.seq_no)));
  const src = { n: folderLines.size };

  // Plan: line → set of zones
  const planned = new Map();
  plan.forEach((p) => {
    const k = keyOf(p.service, p.seq_no);
    if (!planned.has(k)) planned.set(k, new Set());
    planned.get(k).add(String(p.zone).toUpperCase());
  });
  // Done: line → set of zones with MTO rows saved
  const taken = new Map();
  done.filter((z) => z.items_count > 0).forEach((z) => {
    const k = keyOf(z.service, z.subline_no ? `${z.lsr_no}-${z.subline_no}` : z.lsr_no);
    if (!taken.has(k)) taken.set(k, new Set());
    taken.get(k).add(z.zone);
  });

  let started = 0, complete = 0;
  for (const [k, zones] of planned) {
    const t = taken.get(k);
    if (!t) continue;
    const hit = [...zones].filter((z) => t.has(z)).length;
    if (hit) started++;
    if (hit === zones.size) complete++;
  }

  // Zone-wise
  const zones = new Map();
  const zoneRow = (z) => {
    if (!zones.has(z)) zones.set(z, { zone: z, planned: 0, taken: 0, left: 0, notInPlan: 0 });
    return zones.get(z);
  };
  for (const [k, zs] of planned) {
    for (const z of zs) {
      const r = zoneRow(z);
      r.planned++;
      if (taken.get(k)?.has(z)) r.taken++; else r.left++;
    }
  }
  let notInPlanZones = 0;
  for (const [k, zs] of taken) {
    for (const z of zs) {
      if (planned.get(k)?.has(z)) continue;
      zoneRow(z).notInPlan++;
      notInPlanZones++;
    }
  }

  return {
    hasPlan: unitPlan.length > 0,
    folder: { id: folder.id, name: folder.name, pids: folder.scope.pidNames.length },
    lines: {
      inSources: src.n,                 // lines on the folder's P&IDs (+ their line-list lines)
      planned: planned.size,            // lines with at least one zone in the plan
      started,                          // MTO taken in at least one planned zone
      complete,                         // MTO taken in all planned zones
      left: planned.size - started,     // no MTO taken yet
    },
    lineZones: {
      planned: plan.length,
      taken: [...zones.values()].reduce((s, r) => s + r.taken, 0),
      left: [...zones.values()].reduce((s, r) => s + r.left, 0),
      notInPlan: notInPlanZones,
      savedWithoutRows: done.filter((z) => !z.items_count).length,
    },
    zones: [...zones.values()].sort((a, b) => a.zone.localeCompare(b.zone)),
  };
}

module.exports = { getSummary };
