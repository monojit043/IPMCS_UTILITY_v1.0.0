pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let docId = null;
let doc = null;
let line = null;
let myUserId = null;
let pdfUrl = null;
let pdfDoc = null;
let pageNum = 1;
let scale = 1.25;

let pdfCanvas, pdfCtx, annoCanvas, annoCtx;
let highlightMode = false;
let strokes = [];        // my own strokes — editable
let othersByUser = [];   // everyone else's strokes — read-only reference
let zoneBreaks = [];
let drawingStroke = null;
let renderTask = null;

window.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(location.search);
  docId = params.get('doc');
  // Opened from a line's "Open & Highlight P&ID": its zone colours the strokes
  const lineZone = params.get('zone');
  if (lineZone) line = { zone: lineZone, lineNo: params.get('lineNo') || '' };

  const session = DataStore.getSession();
  myUserId = session ? session.empId : null;   // highlights are stored per employee ID

  pdfCanvas = document.getElementById('pdfCanvas');
  pdfCtx = pdfCanvas.getContext('2d');
  annoCanvas = document.getElementById('annotationCanvas');
  annoCtx = annoCanvas.getContext('2d');

  document.getElementById('closeBtn').addEventListener('click', () => window.close());
  document.getElementById('zoomInBtn').addEventListener('click', () => changeZoom(1.15));
  document.getElementById('zoomOutBtn').addEventListener('click', () => changeZoom(0.87));
  document.getElementById('zoomResetBtn').addEventListener('click', () => { scale = 1.25; renderPage(); });
  document.getElementById('prevPageBtn').addEventListener('click', () => changePage(-1));
  document.getElementById('nextPageBtn').addEventListener('click', () => changePage(1));
  document.getElementById('highlightToggleBtn').addEventListener('click', toggleHighlightMode);
  document.getElementById('undoBtn').addEventListener('click', undoStroke);
  document.getElementById('clearBtn').addEventListener('click', clearStrokes);

  annoCanvas.addEventListener('mousedown', (e) => {
    if (!highlightMode) return;
    drawingStroke = [toPdfSpace(e.clientX, e.clientY)];
  });
  window.addEventListener('mousemove', (e) => {
    if (!highlightMode || !drawingStroke) return;
    drawingStroke.push(toPdfSpace(e.clientX, e.clientY));
    drawAnnotations();
  });
  window.addEventListener('mouseup', async () => {
    if (!highlightMode || !drawingStroke) return;
    if (drawingStroke.length > 1) {
      strokes.push({ zone: line ? line.zone : null, points: drawingStroke });
      drawingStroke = null;
      drawAnnotations();
      try {
        await DataStore.setMyPidHighlights(docId, pageNum, strokes);
        [othersByUser, zoneBreaks] = await Promise.all([
          DataStore.getDocumentHighlights(docId, pageNum),
          DataStore.getPidZoneBreaks(docId, pageNum),
        ]);
        drawAnnotations();
      } catch (err) {
        showToast('error', 'Could not save highlight', err.message);
      }
      return;
    }
    drawingStroke = null;
    drawAnnotations();
  });

  if (!docId) {
    document.getElementById('pdfLoading').innerHTML =
      `<i class="ti ti-file-alert" style="font-size:26px"></i><span>No P&amp;ID document specified</span>`;
    return;
  }

  try {
    doc = await DataStore.getPidDocument(docId);
    pdfUrl = DataStore.pidFileUrl(docId);

    document.title = (line ? 'P&ID — ' + line.lineNo : doc.pidName) + ' · IPMCS';
    document.getElementById('viewerTitle').textContent = line ? 'P&ID — ' + line.lineNo : doc.pidName;
    // the MTO folder's own copy of the drawing (kept in IPMCS)
    document.getElementById('sheetBadge').textContent = 'Rev ' + (doc.revLabel || '—') + ' · ' + doc.folderName + ' copy' +
      (doc.newerRev ? ` · newer Rev ${doc.newerRev} in ePULSE` : '');

    pdfDoc = await pdfjsLib.getDocument({ url: pdfUrl, httpHeaders: DataStore.authHeaders() }).promise;
    document.getElementById('pdfLoading').classList.add('hidden');
    await renderPage();
  } catch (err) {
    document.getElementById('pdfLoading').innerHTML =
      `<i class="ti ti-file-alert" style="font-size:26px"></i><span>Could not load PDF: ${err.message}</span>`;
  }
});

async function renderPage() {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;
  annoCanvas.width = viewport.width;
  annoCanvas.height = viewport.height;

  if (renderTask) renderTask.cancel();
  renderTask = page.render({ canvasContext: pdfCtx, viewport });
  try {
    await renderTask.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    throw err;
  }

  try {
    [strokes, othersByUser, zoneBreaks] = await Promise.all([
      DataStore.getMyPidHighlights(docId, pageNum),
      DataStore.getDocumentHighlights(docId, pageNum),
      DataStore.getPidZoneBreaks(docId, pageNum),
    ]);
  } catch (err) {
    strokes = []; othersByUser = []; zoneBreaks = [];
  }
  drawAnnotations();
  renderLegend();

  document.getElementById('zoomLabel').textContent = Math.round(scale * 100) + '%';
  document.getElementById('pageLabel').textContent = `Page ${pageNum} / ${pdfDoc.numPages}`;
  document.getElementById('prevPageBtn').style.opacity = pageNum <= 1 ? 0.4 : 1;
  document.getElementById('nextPageBtn').style.opacity = pageNum >= pdfDoc.numPages ? 0.4 : 1;
}

// Colored per-stroke (zone if known, else the drawing user's color) rather
// than per-user — a user's own strokes can span more than one zone.
function strokeStyleFor(list, fallbackUserId) {
  list.forEach(rawStroke => {
    const { points } = normalizePidStroke(rawStroke);
    if (points.length < 2) return;
    annoCtx.strokeStyle = pidStrokeColor(rawStroke, fallbackUserId);
    annoCtx.beginPath();
    annoCtx.moveTo(points[0][0] * scale, points[0][1] * scale);
    for (let i = 1; i < points.length; i++) annoCtx.lineTo(points[i][0] * scale, points[i][1] * scale);
    annoCtx.stroke();
  });
}

function drawAnnotations() {
  annoCtx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);

  annoCtx.save();
  annoCtx.globalAlpha = 0.45;
  annoCtx.lineWidth = 14;
  annoCtx.lineCap = 'round';
  annoCtx.lineJoin = 'round';

  // Everyone else's highlights, read-only reference.
  othersByUser
    .filter(u => u.userId !== myUserId)
    .forEach(u => strokeStyleFor(u.strokes || [], u.userId));

  // My own highlights (including the in-progress stroke).
  const mine = drawingStroke ? strokes.concat([{ zone: line ? line.zone : null, points: drawingStroke }]) : strokes;
  strokeStyleFor(mine, myUserId);

  annoCtx.restore();

  drawZoneBreakMarkers();
}

// One row per zone actually present, each showing its color plus which
// employee(s) contributed — a log, not a person-to-color mapping. Strokes
// with no zone (highlighted outside any specific line) are grouped by
// whoever drew them instead, since there's no zone to key off.
function renderLegend() {
  const legend = document.getElementById('viewerLegend');
  const session = DataStore.getSession();
  const myEmpId = session ? session.empId : 'you';
  const allUsers = othersByUser.concat([{ userId: myUserId, empId: myEmpId, strokes }]);

  const byZone = new Map();   // zone -> Set of employee numbers
  const noZoneByUser = new Map(); // userId -> empId

  allUsers.forEach(u => {
    (u.strokes || []).forEach(raw => {
      const { zone } = normalizePidStroke(raw);
      if (zone) {
        if (!byZone.has(zone)) byZone.set(zone, new Set());
        byZone.get(zone).add(u.empId);
      } else if (!noZoneByUser.has(u.userId)) {
        noZoneByUser.set(u.userId, u.empId);
      }
    });
  });

  const zoneChips = [...byZone.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([zone, empIds]) => `
    <span class="viewer-legend-item"><span class="viewer-legend-dot" style="background:${pidColorForZone(zone)}"></span>Zone ${zone} — ${[...empIds].join(', ')}</span>
  `).join('');
  const userChips = [...noZoneByUser.entries()].map(([userId, empId]) => `
    <span class="viewer-legend-item"><span class="viewer-legend-dot" style="background:${pidColorForUser(userId)}"></span>${empId}</span>
  `).join('');

  legend.innerHTML = zoneChips + userChips || `<span class="viewer-legend-item">No highlights yet</span>`;
}

// Filtered by zone as well as user — a single user can be responsible for
// more than one zone on the same sheet, so their own strokes need to be
// split by zone too, not just averaged together as "this user's direction".
function userZoneStrokes(userId, zone) {
  const source = userId === myUserId ? strokes : ((othersByUser.find(u => u.userId === userId) || {}).strokes || []);
  return source.filter(raw => normalizePidStroke(raw).zone === zone);
}

function drawZoneBreakMarkers() {
  annoCtx.save();
  zoneBreaks.forEach(zb => {
    const x = zb.x * scale, y = zb.y * scale;
    annoCtx.beginPath();
    annoCtx.arc(x, y, 7, 0, Math.PI * 2);
    annoCtx.fillStyle = '#ffffff';
    annoCtx.fill();
    annoCtx.lineWidth = 2.5;
    annoCtx.strokeStyle = '#e8a33d';
    annoCtx.stroke();
    annoCtx.beginPath();
    annoCtx.arc(x, y, 2.5, 0, Math.PI * 2);
    annoCtx.fillStyle = '#e8a33d';
    annoCtx.fill();

    if (zb.zoneA || zb.zoneB) {
      // Each label sits on the same side as that user's actual stroke,
      // not an arbitrary fixed side.
      const dirA = pidZoneLabelDirection(userZoneStrokes(zb.userAId, zb.zoneA), zb.x, zb.y);
      const dirB = pidZoneLabelDirection(userZoneStrokes(zb.userBId, zb.zoneB), zb.x, zb.y);
      drawZoneLabel(x + dirA[0] * 20, y + dirA[1] * 20, zb.zoneA, zb.userAEmpId, pidColorForZone(zb.zoneA) || pidColorForUser(zb.userAId));
      drawZoneLabel(x + dirB[0] * 20, y + dirB[1] * 20, zb.zoneB, zb.userBEmpId, pidColorForZone(zb.zoneB) || pidColorForUser(zb.userBId));
    }
  });
  annoCtx.restore();
}

// A small pill showing which zone each side of a break belongs to (and
// which employee highlighted it) in that zone's color, positioned toward
// the actual highlighted segment.
function drawZoneLabel(x, y, zone, empId, color) {
  if (!zone) return;
  annoCtx.save();
  const zoneFont = '700 12px ui-monospace, Menlo, Consolas, monospace';
  const idFont = '600 9px ui-monospace, Menlo, Consolas, monospace';

  annoCtx.font = zoneFont;
  const zoneW = annoCtx.measureText(zone).width;
  annoCtx.font = idFont;
  const idW = empId ? annoCtx.measureText(empId).width : 0;
  const w = Math.max(zoneW, idW) + 14;
  const h = empId ? 32 : 22;

  annoCtx.fillStyle = color;
  annoCtx.beginPath();
  annoCtx.roundRect(x - w / 2, y - h / 2, w, h, 6);
  annoCtx.fill();

  annoCtx.fillStyle = '#ffffff';
  annoCtx.textAlign = 'center';
  if (empId) {
    annoCtx.font = zoneFont;
    annoCtx.textBaseline = 'alphabetic';
    annoCtx.fillText(zone, x, y - 2);
    annoCtx.font = idFont;
    annoCtx.fillText(empId, x, y + 11);
  } else {
    annoCtx.font = zoneFont;
    annoCtx.textBaseline = 'middle';
    annoCtx.fillText(zone, x, y + 1);
  }
  annoCtx.restore();
}

function toPdfSpace(clientX, clientY) {
  const rect = annoCanvas.getBoundingClientRect();
  return [(clientX - rect.left) / scale, (clientY - rect.top) / scale];
}

function changeZoom(factor) {
  scale = Math.max(0.4, Math.min(4, scale * factor));
  renderPage();
}

function changePage(delta) {
  if (!pdfDoc) return;
  const next = pageNum + delta;
  if (next < 1 || next > pdfDoc.numPages) return;
  pageNum = next;
  renderPage();
}

function toggleHighlightMode() {
  highlightMode = !highlightMode;
  document.getElementById('highlightToggleBtn').classList.toggle('active', highlightMode);
  document.getElementById('highlightBadge').style.display = highlightMode ? 'inline-flex' : 'none';
  annoCanvas.classList.toggle('highlighting', highlightMode);
  if (highlightMode) showToast('info', 'Highlight mode on', 'Draw over the portion you have completed MTO for');
}

async function undoStroke() {
  if (!strokes.length) return;
  strokes.pop();
  drawAnnotations();
  try {
    await DataStore.setMyPidHighlights(docId, pageNum, strokes);
  } catch (err) {
    showToast('error', 'Could not undo', err.message);
  }
}

async function clearStrokes() {
  strokes = [];
  drawAnnotations();
  showToast('info', 'Highlights cleared', '');
  try {
    await DataStore.setMyPidHighlights(docId, pageNum, strokes);
  } catch (err) {
    showToast('error', 'Could not clear highlights', err.message);
  }
}

let toastTimer;
function showToast(type, title, sub) {
  const icons = { success: 'ti-check-circle', error: 'ti-alert-circle', info: 'ti-info-circle' };
  const colors = { success: 'var(--color-success)', error: 'var(--color-danger)', info: 'var(--color-accent-strong)' };
  document.getElementById('toastTitle').textContent = title;
  document.getElementById('toastSub').textContent = sub || '';
  document.getElementById('toastIcon').innerHTML = `<i class="ti ${icons[type]}" style="color:${colors[type]}"></i>`;
  const el = document.getElementById('toast');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
