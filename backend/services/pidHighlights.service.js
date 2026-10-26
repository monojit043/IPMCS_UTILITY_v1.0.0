const { query } = require('../config/db');
const { namesFor } = require('./auth.service');

// People are identified by employee ID (userId below IS the employee ID, e.g.
// A725); names are read live from PC-2.

// PDF-space pixels (scale=1, same units strokes are stored in).
const ZONE_BREAK_THRESHOLD = 20;

// Strokes are stored as { zone, points } so a zone-break can be labeled with
// which zone each side belongs to (see pid-viewer.js). Older highlights
// were saved as a plain points array with no zone — normalize both shapes.
function normalizeStroke(stroke) {
  if (Array.isArray(stroke)) return { zone: null, points: stroke };
  return { zone: stroke.zone || null, points: stroke.points || [] };
}

// Highlights are made on one MTO folder's COPY of a drawing (rev.fileId =
// mto_folder_files.id); revision_doc_id / document_id also record which
// ePULSE revision / drawing that copy is.
async function getAllForDocument(rev, pageNum) {
  const { rows } = await query(
    `SELECT emp_id AS "userId", emp_id AS "empId", strokes
     FROM pid_user_highlights WHERE folder_file_id = $1 AND page_num = $2 ORDER BY emp_id`,
    [rev.fileId, pageNum]
  );
  const withStrokes = rows.filter((r) => r.strokes && r.strokes.length);
  const names = await namesFor(withStrokes.map((r) => r.empId));
  return withStrokes.map((r) => ({ ...r, userName: names.get(r.empId.toUpperCase()) || r.empId }));
}

async function getMine(rev, pageNum, userId) {
  const { rows } = await query(
    `SELECT strokes FROM pid_user_highlights WHERE folder_file_id = $1 AND page_num = $2 AND emp_id = $3`,
    [rev.fileId, pageNum, userId]
  );
  return rows[0] ? rows[0].strokes : [];
}

async function upsertMine(rev, pageNum, userId, strokes) {
  const previous = await getMine(rev, pageNum, userId);

  await query(
    `INSERT INTO pid_user_highlights (folder_file_id, revision_doc_id, document_id, page_num, emp_id, strokes, updated_at)
     VALUES ($1,$6,$5,$2,$3,$4,now())
     ON CONFLICT (folder_file_id, page_num, emp_id) DO UPDATE SET strokes = $4, updated_at = now()`,
    [rev.fileId, pageNum, userId, JSON.stringify(strokes), rev.masterIndexId, rev.revDocId]
  );

  // A stroke was appended (not undone/cleared) — check whether it touches
  // another zone's highlighting, which marks a hand-off point.
  if (strokes.length > previous.length) {
    const newStroke = normalizeStroke(strokes[strokes.length - 1]);
    const myOtherStrokes = strokes.slice(0, -1);
    await detectZoneBreak(rev, pageNum, userId, newStroke, myOtherStrokes);
  }

  return strokes;
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// A break is marked wherever two touching strokes belong to different
// zones — whoever drew them. When either side's zone isn't known (drawn
// from the general P&ID library, not a specific line), this falls back to
// "different user" so unrelated people's highlights still get flagged,
// while the same person's own strokes with no zone info never do.
async function detectZoneBreak(rev, pageNum, userId, newStroke, myOtherStrokes) {
  if (!newStroke.points || newStroke.points.length < 2) return;
  const endpoints = [newStroke.points[0], newStroke.points[newStroke.points.length - 1]];

  const { rows: others } = await query(
    `SELECT emp_id AS "userId", strokes FROM pid_user_highlights
     WHERE folder_file_id = $1 AND page_num = $2 AND emp_id != $3`,
    [rev.fileId, pageNum, userId]
  );

  const candidates = [];
  others.forEach((o) => (o.strokes || []).forEach((s) => candidates.push({ userId: o.userId, stroke: normalizeStroke(s) })));
  (myOtherStrokes || []).forEach((s) => candidates.push({ userId, stroke: normalizeStroke(s) }));

  for (const c of candidates) {
    for (const otherPoint of c.stroke.points) {
      for (const endpoint of endpoints) {
        if (distance(endpoint, otherPoint) > ZONE_BREAK_THRESHOLD) continue;

        const sameUser = c.userId === userId;
        const zonesKnown = newStroke.zone && c.stroke.zone;
        const isBreak = zonesKnown ? newStroke.zone !== c.stroke.zone : !sameUser;
        if (!isBreak) continue;

        await recordZoneBreak(rev, pageNum, endpoint, userId, newStroke.zone, c.userId, c.stroke.zone);
        return;
      }
    }
  }
}

async function recordZoneBreak(rev, pageNum, point, userIdA, zoneA, userIdB, zoneB) {
  if (userIdB < userIdA) {
    [userIdA, userIdB] = [userIdB, userIdA];
    [zoneA, zoneB] = [zoneB, zoneA];
  }

  const { rows: existing } = await query(
    `SELECT id, x, y FROM pid_zone_breaks
     WHERE folder_file_id = $1 AND page_num = $2 AND emp_a = $3 AND emp_b = $4`,
    [rev.fileId, pageNum, userIdA, userIdB]
  );
  const nearby = existing.find((e) => distance([e.x, e.y], point) <= ZONE_BREAK_THRESHOLD * 2);
  if (nearby) {
    // Refresh the zone labels in case a stroke was redrawn since — cheap
    // and keeps the marker accurate without spawning a duplicate.
    if (zoneA || zoneB) {
      await query(`UPDATE pid_zone_breaks SET zone_a = $2, zone_b = $3 WHERE id = $1`, [nearby.id, zoneA, zoneB]);
    }
    return;
  }

  await query(
    `INSERT INTO pid_zone_breaks (folder_file_id, revision_doc_id, document_id, page_num, x, y, emp_a, emp_b, zone_a, zone_b)
     VALUES ($1,$10,$9,$2,$3,$4,$5,$6,$7,$8)`,
    [rev.fileId, pageNum, point[0], point[1], userIdA, userIdB, zoneA, zoneB, rev.masterIndexId, rev.revDocId]
  );
}

async function getZoneBreaks(rev, pageNum) {
  const { rows } = await query(
    `SELECT id, x, y, emp_a AS "userAId", emp_b AS "userBId", emp_a AS "userAEmpId", emp_b AS "userBEmpId",
            zone_a AS "zoneA", zone_b AS "zoneB"
     FROM pid_zone_breaks WHERE folder_file_id = $1 AND page_num = $2 ORDER BY id`,
    [rev.fileId, pageNum]
  );
  const names = await namesFor(rows.flatMap((r) => [r.userAEmpId, r.userBEmpId]));
  return rows.map((r) => ({
    ...r,
    userAName: names.get(r.userAEmpId.toUpperCase()) || r.userAEmpId,
    userBName: names.get(r.userBEmpId.toUpperCase()) || r.userBEmpId,
  }));
}

module.exports = { getAllForDocument, getMine, upsertMine, getZoneBreaks };
