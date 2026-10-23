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
function pidColorForUser(userId) {
  return PID_USER_COLORS[userId % PID_USER_COLORS.length];
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
    return { Authorization: 'Bearer ' + token, ...(unit ? { 'X-Unit-No': unit } : {}) };
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

  function clearSession() {
    sessionStorage.removeItem('ipmcs_token');
    sessionStorage.removeItem('ipmcs_user');
    sessionStorage.removeItem('ipmcs_unit');
    clearPendingAssignment();
  }

  /* ── Lines ── */
  function getLines() {
    return apiFetch('/lines');
  }

  function getLine(id) {
    return apiFetch(`/lines/${id}`);
  }

  function setLineStatus(lineId, status, itemCount) {
    return apiFetch(`/lines/${lineId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, items: itemCount }),
    });
  }

  /* Cascading line-identity lookups: Service -> Sequence No -> Zone. Queried
     live against ePULSE (line list + lines read off current P&IDs) on the
     backend; zones are IPMCS's own. Unit No is fixed
     by the logged-in session's PIMS assignment, not picked here — see
     currentUser.unitNo in workspace.js. resolveLine is the moment the line
     actually gets pulled in and saved into our own lines table. */
  function getServices() {
    return apiFetch('/lines/meta/services');
  }
  function getSequences(service) {
    return apiFetch('/lines/meta/sequences' + qs({ service }));
  }
  // COSMAS Subline No. for an LSR NO: P&ID sub-lines, '' = the line itself
  function getSublines(service, seqNo) {
    return apiFetch('/lines/meta/sublines' + qs({ service, seq: seqNo }));
  }
  // COSMAS line header (what the engineer entered / overrode)
  function saveLineCosmas(lineId, fields) {
    return apiFetch(`/lines/${lineId}/cosmas`, { method: 'PUT', body: JSON.stringify(fields) });
  }
  function getZones(service, seqNo) {
    return apiFetch('/lines/meta/zones' + qs({ service, seq: seqNo }));
  }
  async function resolveLine(service, seqNo, zone) {
    try {
      return await apiFetch('/lines/lookup' + qs({ service, seq: seqNo, zone }));
    } catch (err) {
      return null;
    }
  }

  /* ── Manual MTO items ── */
  function getMTOItems(lineId) {
    return apiFetch(`/lines/${lineId}/mto-items`);
  }
  function addMTOItem(lineId, item) {
    return apiFetch(`/lines/${lineId}/mto-items`, { method: 'POST', body: JSON.stringify(item) });
  }
  // Partial update of a BoM row: pipingClass, inputCode, itemCode, dia1, dia2, qty
  function updateMTOItem(itemId, fields) {
    return apiFetch(`/mto-items/${itemId}`, { method: 'PATCH', body: JSON.stringify(fields) });
  }
  function deleteMTOItem(itemId) {
    return apiFetch(`/mto-items/${itemId}`, { method: 'DELETE' });
  }

  /* ── Model dump items (MTO from Dump Check) ── */
  function getDumpItems(lineId) {
    return apiFetch(`/lines/${lineId}/dump-items`);
  }
  function addDumpItem(lineId, item) {
    return apiFetch(`/lines/${lineId}/dump-items`, { method: 'POST', body: JSON.stringify(item) });
  }
  function updateDumpItem(itemId, fields) {
    return apiFetch(`/dump-items/${itemId}`, { method: 'PATCH', body: JSON.stringify(fields) });
  }
  function deleteDumpItem(itemId) {
    return apiFetch(`/dump-items/${itemId}`, { method: 'DELETE' });
  }

  /* ── SP P&ID extracted items (read-only) ── */
  function getExtractedItems(lineId) {
    return apiFetch(`/lines/${lineId}/extracted-items`);
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
  // Live PIMS P&ID sheets for the current job/unit, for ADMIN to tick into a folder.
  function getAvailablePimsDocuments() {
    return apiFetch('/pid/pims/available');
  }
  function addPidFolderSelection(folderId, masterIndexId) {
    return apiFetch(`/pid/folders/${folderId}/selections`, {
      method: 'POST',
      body: JSON.stringify({ masterIndexId }),
    });
  }
  function removePidFolderSelection(folderId, masterIndexId) {
    return apiFetch(`/pid/folders/${folderId}/selections/${masterIndexId}`, { method: 'DELETE' });
  }
  function getPidDocument(masterIndexId) {
    return apiFetch(`/pid/documents/${masterIndexId}`);
  }
  // Resolves the P&ID sheet a given line is actually drawn on.
  function getPidDocumentForLine(lineId) {
    return apiFetch(`/pid/line/${lineId}/document`);
  }
  function pidFileUrl(masterIndexId) {
    return `${API_BASE}/pid/pims-file/${masterIndexId}`;
  }

  /* ── P&ID highlighter annotations, per document (PIMS master index id) +
     page + user ── */
  function getDocumentHighlights(docId, page) {
    return apiFetch(`/pid/documents/${docId}/highlights` + qs({ page }));
  }
  async function getMyPidHighlights(docId, page) {
    const { strokes } = await apiFetch(`/pid/documents/${docId}/highlights/mine` + qs({ page }));
    return strokes;
  }
  async function setMyPidHighlights(docId, page, strokes) {
    const res = await apiFetch(`/pid/documents/${docId}/highlights/mine` + qs({ page }), {
      method: 'PUT',
      body: JSON.stringify({ strokes }),
    });
    return res.strokes;
  }
  // Auto-detected junctions where two different users' highlights touch.
  function getPidZoneBreaks(docId, page) {
    return apiFetch(`/pid/documents/${docId}/zone-breaks` + qs({ page }));
  }

  return {
    login, ssoLogin, logout, selectAssignment, getSession, clearSession, getUnits, getUnit, setUnit, getPendingAssignment, clearPendingAssignment,
    getLines, getLine, setLineStatus,
    getServices, getSequences, getSublines, getZones, resolveLine, saveLineCosmas,
    getMTOItems, addMTOItem, updateMTOItem, deleteMTOItem,
    getDumpItems, addDumpItem, updateDumpItem, deleteDumpItem,
    getExtractedItems,
    getPidFolders, createPidFolder, getPidDocuments,
    getAvailablePimsDocuments, addPidFolderSelection, removePidFolderSelection,
    getPidDocument, getPidDocumentForLine, pidFileUrl, authHeaders,
    getDocumentHighlights, getMyPidHighlights, setMyPidHighlights, getPidZoneBreaks,
  };
})();
