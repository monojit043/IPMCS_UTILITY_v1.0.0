const { query } = require('../config/db');

// PDF-space pixels (scale=1, same units strokes are stored in).
const ZONE_BREAK_THRESHOLD = 20;

// Strokes are stored as { zone, points } so a zone-break can be labeled with
// which zone each side belongs to (see pid-viewer.js). Older highlights
// were saved as a plain points array with no zone — normalize both shapes.
function normalizeStroke(stroke) {
  if (Array.isArray(stroke)) return { zone: null, points: stroke };
  return { zone: stroke.zone || null, points: stroke.points || [] };
}

async function getAllForDocument(documentId, pageNum) {
  const { rows } = await query(
    `SELECT h.user_id AS "userId", u.name AS "userName", u.emp_id AS "empId", h.strokes
     FROM pid_user_highlights h JOIN users u ON u.id = h.user_id
     WHERE h.document_id = $1 AND h.page_num = $2
     ORDER BY u.name`,
    [documentId, pageNum]
  );
  return rows.filter((r) => r.strokes && r.strokes.length);
}

async function getMine(documentId, pageNum, userId) {
  const { rows } = await query(
    `SELECT strokes FROM pid_user_highlights WHERE document_id = $1 AND page_num = $2 AND user_id = $3`,
    [documentId, pageNum, userId]
  );
  return rows[0] ? rows[0].strokes : [];
}

async function upsertMine(documentId, pageNum, userId, strokes) {
  const previous = await getMine(documentId, pageNum, userId);

  await query(
    `INSERT INTO pid_user_highlights (document_id, page_num, user_id, strokes, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (document_id, page_num, user_id) DO UPDATE SET strokes = $4, updated_at = now()`,
    [documentId, pageNum, userId, JSON.stringify(strokes)]
  );

  // A stroke was appended (not undone/cleared) — check whether it touches
  // another zone's highlighting, which marks a hand-off point.
  if (strokes.length > previous.length) {
    const newStroke = normalizeStroke(strokes[strokes.length - 1]);
    const myOtherStrokes = strokes.slice(0, -1);
    await detectZoneBreak(documentId, pageNum, userId, newStroke, myOtherStrokes);
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
async function detectZoneBreak(documentId, pageNum, userId, newStroke, myOtherStrokes) {
  if (!newStroke.points || newStroke.points.length < 2) return;
  const endpoints = [newStroke.points[0], newStroke.points[newStroke.points.length - 1]];

  const { rows: others } = await query(
    `SELECT user_id AS "userId", strokes FROM pid_user_highlights
     WHERE document_id = $1 AND page_num = $2 AND user_id != $3`,
    [documentId, pageNum, userId]
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

        await recordZoneBreak(documentId, pageNum, endpoint, userId, newStroke.zone, c.userId, c.stroke.zone);
        return;
      }
    }
  }
}

async function recordZoneBreak(documentId, pageNum, point, userIdA, zoneA, userIdB, zoneB) {
  if (userIdB < userIdA) {
    [userIdA, userIdB] = [userIdB, userIdA];
    [zoneA, zoneB] = [zoneB, zoneA];
  }

  const { rows: existing } = await query(
    `SELECT id, x, y FROM pid_zone_breaks
     WHERE document_id = $1 AND page_num = $2 AND user_a_id = $3 AND user_b_id = $4`,
    [documentId, pageNum, userIdA, userIdB]
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
    `INSERT INTO pid_zone_breaks (document_id, page_num, x, y, user_a_id, user_b_id, zone_a, zone_b)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [documentId, pageNum, point[0], point[1], userIdA, userIdB, zoneA, zoneB]
  );
}

async function getZoneBreaks(documentId, pageNum) {
  const { rows } = await query(
    `SELECT zb.id, zb.x, zb.y, zb.user_a_id AS "userAId", zb.user_b_id AS "userBId",
            zb.zone_a AS "zoneA", zb.zone_b AS "zoneB",
            ua.name AS "userAName", ub.name AS "userBName",
            ua.emp_id AS "userAEmpId", ub.emp_id AS "userBEmpId"
     FROM pid_zone_breaks zb
     JOIN users ua ON ua.id = zb.user_a_id
     JOIN users ub ON ub.id = zb.user_b_id
     WHERE zb.document_id = $1 AND zb.page_num = $2
     ORDER BY zb.id`,
    [documentId, pageNum]
  );
  return rows;
}

module.exports = { getAllForDocument, getMine, upsertMine, getZoneBreaks };
