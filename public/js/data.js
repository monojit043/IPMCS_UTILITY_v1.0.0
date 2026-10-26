/*
 * Real API client — talks to the Express/Postgres backend in backend/.
 * The frontend and API are served from the same origin (see backend/server.js),
 * so paths here are all relative to "/api".
 */

// Shared across the P&ID library view (workspace.js) and the per-line
// highlight popup (pid-viewer.js), keyed off zone rather than who drew it —
// two different people highlighting the same zone should look the same
// color, and the same person highlighting two zones should look different.
// Falls back to a per-user color only when a stroke has no zone at all
// (highlighted from the general P&ID library, with no line context).
const PID_USER_COLORS = ['#2f7dfa', '#22c58e', '#e8a33d', '#ef5b5b', '#a855f7', '#06b6d4', '#f472b6', '#84cc16'];
// userId is the employee ID (e.g. A725) — a stable colour per person
function pidColorForUser(userId) {
  const s = String(userId || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) % PID_USER_COLORS.length;
  return PID_USER_COLORS[hash];
}
function pidColorForZone(zone) {
  if (!zone) return null;
  let hash = 0;
  for (let i = 0; i < zone.length; i++) hash = (hash * 31 + zone.charCodeAt(i)) % PID_USER_COLORS.length;
  return PID_USER_COLORS[hash];
}
// Strokes are saved as { zone, points } so zone-break markers can be labeled
// with which zone each side belongs to. Older highlights were saved as a
// plain points array with no zone — normalize both shapes when reading.
function normalizePidStroke(stroke) {
  if (Array.isArray(stroke)) return { zone: null, points: stroke };
  return { zone: stroke.zone || null, points: stroke.points || [] };
}
// The color to actually draw a given stroke in: zone-based when known,
// falling back to the drawing user's color when it isn't.
function pidStrokeColor(rawStroke, fallbackUserId) {
  const zone = normalizePidStroke(rawStroke).zone;
  return zone ? pidColorForZone(zone) : pidColorForUser(fallbackUserId);
}

// Which way (unit vector, PDF-space) a user's own highlighting extends away
// from a zone-break point — used to place that user's zone label on the
// same side as their actual stroke, instead of an arbitrary fixed side.
function pidZoneLabelDirection(userStrokes, breakX, breakY) {
  let sx = 0, sy = 0, n = 0;
  (userStrokes || []).forEach(raw => {
    normalizePidStroke(raw).points.forEach(p => { sx += p[0]; sy += p[1]; n++; });
  });
  if (!n) return [1, 0];
  const dx = sx / n - breakX, dy = sy / n - breakY;
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

const DataStore = (() => {
  const API_BASE = '/api';

  function authHeaders() {
    const token = sessionStorage.getItem('ipmcs_token');
    if (!token) return {};
    // The unit being worked in (Unit dropdown) — checked on the server
    // against the user's PC-2 units for the session's job
    const unit = sessionStorage.getItem('ipmcs_unit');
    // ...and the frozen MTO folder MTO is being taken in (MTO folder dropdown)
    const folder = sessionStorage.getItem('ipmcs_folder');
    return {
      Authorization: 'Bearer ' + token,
      ...(unit ? { 'X-Unit-No': unit } : {}),
      ...(folder ? { 'X-Folder-Id': folder } : {}),
    };
  }

  async function apiFetch(path, options = {}) {
    // API responses are dynamic and must never be served stale from the
    // browser's HTTP cache — without this, reopening a page that re-fetches
    // the same URL (e.g. the P&ID highlight popup for a different line on
    // the same document) can silently show cached, outdated data.
    const res = await fetch(API_BASE + path, {
      cache: 'no-store',
      ...options,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || res.statusText);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const qs = (params) =>
    '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  /* ── Auth / session ── */
  function storeSession(token, user) {
    sessionStorage.removeItem('ipmcs_unit');
    sessionStorage.setItem('ipmcs_token', token);
    sessionStorage.setItem('ipmcs_user', JSON.stringify(user));
    return user;
  }

  function getPendingAssignment() {
    const raw = sessionStorage.getItem('ipmcs_pending_assignment');
    return raw ? JSON.parse(raw) : null;
  }
  function clearPendingAssignment() {
    sessionStorage.removeItem('ipmcs_pending_assignment');
  }

  // Step 1: credential check. Always resolves once done — the login page just
  // redirects to workspace.html either way. If the employee has more than one
  // job/unit assignment, the pre-auth token + options are stashed for
  // workspace.html to pick up and prompt for (see getPendingAssignment /
  // selectAssignment) instead of a full session existing yet.
  async function login(empId, password) {
    const result = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ empId, password }),
    });
    return acceptLogin(result);
  }

  // Already signed in to ePULSE / MRCS / SSMS on this host (eil_sso cookie) —
  // no password needed. Resolves false when not signed in anywhere.
  async function ssoLogin() {
    try {
      const result = await apiFetch('/auth/sso', { method: 'POST' });
      acceptLogin(result);
      return true;
    } catch (err) {
      return false;
    }
  }

  // Ends the shared sign-on too, so every app on this host is signed out
  async function logout() {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch (err) { /* still clear locally */ }
    clearSession();
  }

  function acceptLogin(result) {
    if (result.needsSelection) {
      sessionStorage.setItem('ipmcs_pending_assignment', JSON.stringify({
        preAuthToken: result.preAuthToken,
        assignments: result.assignments,
        name: result.name,
      }));
      return { needsSelection: true };
    }
    storeSession(result.token, result.user);
    return { needsSelection: false };
  }

  // Step 2 (only when a pending assignment selection exists).
  async function selectAssignment(preAuthToken, jobNo, unitNo) {
    const { token, user } = await apiFetch('/auth/select-assignment', {
      method: 'POST',
      body: JSON.stringify({ preAuthToken, jobNo, unitNo }),
    });
    clearPendingAssignment();
    return storeSession(token, user);
  }

  function getSession() {
    const raw = sessionStorage.getItem('ipmcs_user');
    return raw ? JSON.parse(raw) : null;
  }

  // Units the user can switch between on this job; the current one
  function getUnits() {
    return apiFetch('/auth/units');
  }
  function getUnit() {
    const s = getSession();
    return sessionStorage.getItem('ipmcs_unit') || (s && s.unitNo) || null;
  }
  function setUnit(unitNo) {
    sessionStorage.setItem('ipmcs_unit', unitNo);
  }
  // The frozen MTO folder being worked in (its id), per browser tab
  function getFolder() {
    return Number(sessionStorage.getItem('ipmcs_folder')) || null;
  }
  function setFolder(folderId) {
    if (folderId) sessionStorage.setItem('ipmcs_folder', String(folderId));
    else sessionStorage.removeItem('ipmcs_folder');
  }

  function clearSession() {
    sessionStorage.removeItem('ipmcs_token');
    sessionStorage.removeItem('ipmcs_user');
    sessionStorage.removeItem('ipmcs_unit');
    sessionStorage.removeItem('ipmcs_folder');
    clearPendingAssignment();
  }

  /* ── Line selection + line data: read live from ePULSE (line list +
     current P&IDs) on the backend; nothing is saved by browsing. A line is
     Service / Unit / LSR NO / Subline No.; the Unit comes from the Unit
     dropdown (X-Unit-No). ── */
  function getServices() {
    return apiFetch('/lines/meta/services');
  }
  function getLsrNos(service) {
    return apiFetch('/lines/meta/lsr' + qs({ service }));
  }
  // P&ID sub-lines of an LSR NO; '' = the line itself
  function getSublines(service, lsr) {
    return apiFetch('/lines/meta/sublines' + qs({ service, lsr }));
  }
  // Line data shown as soon as the line is chosen (null when not found)
  async function getLineData(service, lsr, subline) {
    try {
      return await apiFetch('/lines/data' + qs({ service, lsr, subline: subline || '' }));
    } catch (err) {
      return null;
    }
  }
  // Zones already saved for the line: [{ id, zone, status, items }]
  function getZones(service, lsr, subline) {
    return apiFetch('/lines/meta/zones' + qs({ service, lsr, subline: subline || '' }));
  }

  /* ── Saved line + zones (mto_line_zones): COSMAS header + BoM rows ── */
  // All saved zones of the unit, each with its live line data in .line
  function getLineZones() {
    return apiFetch('/line-zones');
  }
  // { zone, line, mto, dump, extracted }
  function getLineZone(id) {
    return apiFetch(`/line-zones/${id}`);
  }
  // { service, lsrNo, sublineNo, zone, header, kind: 'mto'|'dump', rows } → same shape as getLineZone
  function saveLineZone(payload) {
    return apiFetch('/line-zones', { method: 'PUT', body: JSON.stringify(payload) });
  }
  // Team of the current job + unit (Leads from PC-2, Material Leads, JEs)
  function getTeam() {
    return apiFetch('/team');
  }
  function searchEmployees(q) {
    return apiFetch('/team/employees' + qs({ q }));
  }
  function assignTeamMember(empId, role) {
    return apiFetch('/team', { method: 'PUT', body: JSON.stringify({ empId, role }) });
  }
  function removeTeamMember(empId) {
    return apiFetch(`/team/${encodeURIComponent(empId)}`, { method: 'DELETE' });
  }
  // Search/Delete Lines/Print: every line + zone with MTO taken in the unit
  function searchLineZones() {
    return apiFetch('/line-zones/search');
  }
  // Delete a line + zone (archived on the server first)
  function deleteLineZone(id, reason) {
    return apiFetch(`/line-zones/${id}`, { method: 'DELETE', body: JSON.stringify({ reason: reason || null }) });
  }
  // Is the line + zone highlighted on the MTO folder's drawing? (checked before saving)
  function getHighlightCheck(service, lsr, subline, zone) {
    return apiFetch('/lines/highlight-check' + qs({ service, lsr, subline: subline || '', zone }));
  }
  // MTO Summary: ePULSE zone plan vs IPMCS MTO taken, for the current unit
  function getMtoSummary() {
    return apiFetch('/line-zones/summary');
  }
  // View History: every saved revision (newest first) / one revision in full
  function getZoneRevisions(id) {
    return apiFetch(`/line-zones/${id}/revisions`);
  }
  function getZoneRevision(id, revNo) {
    return apiFetch(`/line-zones/${id}/revisions/${revNo}`);
  }

  /* ── P&ID library: ADMIN-curated folders referencing PIMS's own P&ID
     library (pid_master_index/pid_documents) — PIMS is the source of
     truth, IPMCS only records which sheets are selected into a folder. ── */
  function getPidFolders() {
    return apiFetch('/pid/folders');
  }
  function createPidFolder(name) {
    return apiFetch('/pid/folders', { method: 'POST', body: JSON.stringify({ name }) });
  }
  function getPidDocuments(folderId) {
    return apiFetch(`/pid/folders/${folderId}/documents`);
  }
  // Freeze: copies EVERY P&ID of the unit (current revision) into the folder
  function freezePidFolder(folderId) {
    return apiFetch(`/pid/folders/${folderId}/freeze`, { method: 'POST' });
  }
  // A frozen MTO folder's COPY of a drawing, kept in IPMCS (fileId)
  function getPidDocument(fileId) {
    return apiFetch(`/pid/folder-files/${fileId}`);
  }
  // The current MTO folder's copy of the drawing a line is on
  function getPidDocumentForLine(service, lsr, subline) {
    return apiFetch('/pid/line-document' + qs({ service, lsr, subline: subline || '' }));
  }
  // kind: 'fresh' (as issued) | 'highlighted' (everyone's highlights drawn in)
  function pidFileUrl(fileId, kind = 'fresh') {
    return `${API_BASE}/pid/folder-files/${fileId}/pdf?kind=${kind}`;
  }
  // An OPEN folder's P&ID, previewed live from ePULSE (pid_documents.id)
  function pidRevisionFileUrl(revId) {
    return `${API_BASE}/pid/revisions/${revId}/file`;
  }
  // Saves a folder copy (fresh / highlighted PDF) as a file
  async function downloadPidCopy(fileId, kind) {
    const res = await fetch(pidFileUrl(fileId, kind) + '&download=1', { cache: 'no-store', headers: authHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || res.statusText);
    }
    const name = ((res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || `${kind}.pdf`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ── P&ID highlighter annotations, per folder copy (fileId) + page + user ── */
  function getDocumentHighlights(docId, page) {
    return apiFetch(`/pid/folder-files/${docId}/highlights` + qs({ page }));
  }
  async function getMyPidHighlights(docId, page) {
    const { strokes } = await apiFetch(`/pid/folder-files/${docId}/highlights/mine` + qs({ page }));
    return strokes;
  }
  async function setMyPidHighlights(docId, page, strokes) {
    const res = await apiFetch(`/pid/folder-files/${docId}/highlights/mine` + qs({ page }), {
      method: 'PUT',
      body: JSON.stringify({ strokes }),
    });
    return res.strokes;
  }
  // Auto-detected junctions where two different users' highlights touch.
  function getPidZoneBreaks(docId, page) {
    return apiFetch(`/pid/folder-files/${docId}/zone-breaks` + qs({ page }));
  }

  return {
    login, ssoLogin, logout, selectAssignment, getSession, clearSession, getUnits, getUnit, setUnit, getFolder, setFolder, getPendingAssignment, clearPendingAssignment,
    getServices, getLsrNos, getSublines, getLineData, getZones,
    getLineZones, getLineZone, saveLineZone, getMtoSummary, getHighlightCheck, searchLineZones, deleteLineZone, getTeam, searchEmployees, assignTeamMember, removeTeamMember, getZoneRevisions, getZoneRevision,
    getPidFolders, createPidFolder, getPidDocuments,
    freezePidFolder,
    getPidDocument, getPidDocumentForLine, pidFileUrl, pidRevisionFileUrl, downloadPidCopy, authHeaders,
    getDocumentHighlights, getMyPidHighlights, setMyPidHighlights, getPidZoneBreaks,
  };
})();
