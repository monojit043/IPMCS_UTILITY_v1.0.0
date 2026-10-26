const { query } = require('../config/db');

// Has the line + zone been highlighted on the folder's drawing? A stroke drawn
// from a line's "Open & Highlight P&ID" records that line
// ({ zone, line: { service, lsrNo, sublineNo }, points }); strokes made before
// that only know their zone and don't count. Checked when MTO is saved (the
// JE is warned, may still save) and flagged in the Lines window, Summary and
// reports. Only meaningful when the drawing is in the folder (drawing.ok).
const keyOf = (service, lsrNo, sublineNo, zone) =>
  [service, lsrNo, sublineNo || '', zone].map((v) => String(v ?? '').trim().toUpperCase()).join('|');

// Set of "SERVICE|LSR|SUB|ZONE" highlighted on any copy of the folder
async function highlightedKeys(folderId) {
  const { rows } = await query(
    `SELECT DISTINCT s->'line'->>'service' AS service, s->'line'->>'lsrNo' AS lsr,
            s->'line'->>'sublineNo' AS sub, s->>'zone' AS zone
     FROM pid_user_highlights h
     JOIN mto_folder_files ff ON ff.id = h.folder_file_id
     CROSS JOIN LATERAL jsonb_array_elements(h.strokes) s
     WHERE ff.folder_id = $1 AND jsonb_typeof(s) = 'object' AND s ? 'line'
       AND jsonb_array_length(coalesce(s->'points', '[]'::jsonb)) > 1`,
    [folderId]
  );
  return new Set(rows.map((r) => keyOf(r.service, r.lsr, r.sub, r.zone)));
}

// true / false, or null when the drawing isn't in the folder (nothing to highlight on)
function isHighlighted(keys, drawing, service, lsrNo, sublineNo, zone) {
  if (!drawing || !drawing.ok) return null;
  return keys.has(keyOf(service, lsrNo, sublineNo, zone));
}

module.exports = { highlightedKeys, isHighlighted };
