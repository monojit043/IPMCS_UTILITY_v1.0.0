const STATUS_BADGE = {
  pending:    '<span class="badge badge-muted">Pending</span>',
  inprogress: '<span class="badge badge-accent">In Progress</span>',
  complete:   '<span class="badge badge-success">Complete</span>',
};

let allLines = [];
let activeSection = 'summary';
let activeTab = 'input';
let selectedCat = 'Pipe';
let activeController = null; // which controller's "Add Item" modal is currently open
let currentUser = null;

let inputCtrl, dumpCtrl;

/* ══════════════ INIT ══════════════ */
window.addEventListener('DOMContentLoaded', async () => {
  const user = DataStore.getSession();
  if (!user) {
    const pending = DataStore.getPendingAssignment();
    if (pending) { initPendingAssignment(pending); return; }
    window.location.href = 'index.html';
    return;
  }
  currentUser = user;

  const initials = user.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  document.getElementById('avatarEl').textContent = initials;
  document.getElementById('userNameEl').textContent = user.name;
  document.getElementById('roleStatEl').textContent = 'Role: ' + user.role;

  showJobUnitLabel();

  bindGlobalEvents();
  initPidLibrary();

  inputCtrl = createMtoController({
    key: 'input',
    prefix: '',
    onlyLabel: 'Manual Only',
    drivesShared: true,
    api: {
      getItems: DataStore.getMTOItems, addItem: DataStore.addMTOItem,
      updateItem: DataStore.updateMTOItem, deleteItem: DataStore.deleteMTOItem,
    },
    lsIds: { matched: 'lsMatched', mismatch: 'lsMismatch', only: 'lsManualOnly', extractedOnly: 'lsExtractedOnly' },
  });

  dumpCtrl = createMtoController({
    key: 'dumpcheck',
    prefix: 'dc_',
    onlyLabel: 'Dump Only',
    drivesShared: false,
    api: {
      getItems: DataStore.getDumpItems, addItem: DataStore.addDumpItem,
      updateItem: DataStore.updateDumpItem, deleteItem: DataStore.deleteDumpItem,
    },
    lsIds: { matched: 'lsMatched', mismatch: 'lsMismatch', only: 'lsManualOnly', extractedOnly: 'lsExtractedOnly' },
  });

  // Leaving with unsaved BoM edits asks first
  window.addEventListener('beforeunload', (ev) => {
    if (inputCtrl.hasUnsavedChanges || dumpCtrl.hasUnsavedChanges) { ev.preventDefault(); ev.returnValue = ''; }
  });

  try {
    await populateUnits();
    allLines = await DataStore.getLines();
    await Promise.all([inputCtrl.populateServices(), dumpCtrl.populateServices()]);
  } catch (err) {
    showToast('error', 'Could not load lines', err.message);
  }

  switchSection('summary');
  setInterval(updateClock, 1000);
  updateClock();
});

/* ══════════════ UNIT (switchable, your PC-2 units on this job) ══════════════ */
const UNIT_SELECTS = ['li_unitDisplay', 'dc_li_unitDisplay'];

function showJobUnitLabel() {
  const user = currentUser, unit = DataStore.getUnit();
  const label = user.jobNo
    ? `${user.jobName ? user.jobName + ' · ' : ''}${user.jobNo}${unit ? ' · Unit ' + unit : ''}`
    : 'No job assigned';
  document.getElementById('projectPillEl').innerHTML = `<i class="ti ti-briefcase"></i>${label}`;
  document.getElementById('jobUnitStatEl').textContent = label;
}

async function populateUnits() {
  let units = [];
  try { units = await DataStore.getUnits(); } catch (err) { /* fall back to the session unit */ }
  let current = DataStore.getUnit();
  if (units.length && !units.includes(current)) {   // assignment removed on PC-2 since login
    current = units[0];
    DataStore.setUnit(current);
    showJobUnitLabel();
  }
  const list = units.length ? units : [current].filter(Boolean);
  UNIT_SELECTS.forEach(id => {
    const sel = document.getElementById(id);
    sel.innerHTML = list.map(u => `<option value="${escAttr(u)}">${escAttr(u)}</option>`).join('') || '<option value="">—</option>';
    sel.value = current || '';
    sel.disabled = list.length < 2;
    if (!sel.dataset.bound) {
      sel.addEventListener('change', (e) => switchUnit(e.target.value));
      sel.dataset.bound = '1';
    }
  });
}

async function switchUnit(unitNo) {
  if ((inputCtrl.hasUnsavedChanges || dumpCtrl.hasUnsavedChanges) &&
      !confirm('You have unsaved changes. Switch unit and discard them?')) {
    UNIT_SELECTS.forEach(id => { document.getElementById(id).value = DataStore.getUnit(); });
    return;
  }
  DataStore.setUnit(unitNo);
  UNIT_SELECTS.forEach(id => { document.getElementById(id).value = unitNo; });
  showJobUnitLabel();
  try {
    allLines = await DataStore.getLines();
    await Promise.all([inputCtrl.resetForUnit(), dumpCtrl.resetForUnit()]);
    renderSummaryTable(document.getElementById('summarySearch').value);
    showToast('success', `Unit ${unitNo}`, 'Lines and pick lists now show this unit');
  } catch (err) {
    showToast('error', 'Could not switch unit', err.message);
  }
}


function updateClock() {
  document.getElementById('timeStat').textContent =
    new Date().toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

/* Reached when credentials were valid but the employee has more than one
 * job/unit assignment in PIMS — the rest of the workspace hasn't been
 * initialized yet, so this modal is the only thing usable on the page until
 * a choice is made. */
function initPendingAssignment(pending) {
  document.getElementById('assignmentWelcome').textContent = `Welcome, ${pending.name}.`;
  document.getElementById('assignmentSelect').innerHTML = pending.assignments
    .map(a => `<option value="${a.jobNo}::${a.unitNo}">${a.jobName || a.jobNo} (${a.jobNo}) · ${a.unitCount || 1} unit${(a.unitCount || 1) > 1 ? 's' : ''}</option>`)
    .join('');

  const modal = document.getElementById('assignmentModal');
  modal.classList.add('open');

  function cancelToLogin() {
    DataStore.clearPendingAssignment();
    window.location.href = 'index.html';
  }
  document.getElementById('assignmentBack').addEventListener('click', cancelToLogin);
  modal.addEventListener('click', (e) => { if (e.target === modal) cancelToLogin(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelToLogin(); });

  document.getElementById('assignmentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const [jobNo, unitNo] = document.getElementById('assignmentSelect').value.split('::');
    document.getElementById('assignSpinner').style.display = 'block';
    document.getElementById('assignBtnIcon').style.display = 'none';
    document.getElementById('assignBtnText').textContent = 'Entering…';
    document.getElementById('assignmentSubmitBtn').disabled = true;
    try {
      await DataStore.selectAssignment(pending.preAuthToken, jobNo, unitNo);
      window.location.reload();
    } catch (err) {
      document.getElementById('assignSpinner').style.display = 'none';
      document.getElementById('assignBtnIcon').style.display = 'block';
      document.getElementById('assignBtnText').textContent = 'Enter Workspace';
      document.getElementById('assignmentSubmitBtn').disabled = false;
      showToast('error', 'Could not continue', err.message);
    }
  });
}

function bindGlobalEvents() {
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await DataStore.logout();   // also signs out of ePULSE / MRCS / SSMS (shared sign-on)
    window.location.href = 'index.html';
  });

  document.querySelectorAll('.section-item').forEach(item => {
    item.addEventListener('click', () => switchSection(item.dataset.section));
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('summarySearch').addEventListener('input', (e) => renderSummaryTable(e.target.value));
  let activeFilter = 'all';
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      window.summaryFilter = activeFilter;
      renderSummaryTable(document.getElementById('summarySearch').value);
    });
  });
  window.summaryFilter = 'all';

  document.getElementById('closeAddModal').addEventListener('click', closeAddModal);
  document.getElementById('cancelAddModal').addEventListener('click', closeAddModal);
  document.getElementById('saveItemBtn').addEventListener('click', saveItem);
  document.getElementById('catGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-btn');
    if (btn) selectCategory(btn);
  });

  document.getElementById('closeUploadModal').addEventListener('click', closeUploadModal);
  document.getElementById('cancelUploadModal').addEventListener('click', closeUploadModal);
  document.getElementById('processUploadBtn').addEventListener('click', processUpload);
  document.getElementById('dropZone').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', handleFile);
  document.getElementById('dropZone').addEventListener('dragover', (e) => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--color-accent)'; });
  document.getElementById('dropZone').addEventListener('dragleave', (e) => { e.currentTarget.style.borderColor = 'var(--color-border-strong)'; });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (activeTab === 'dumpcheck') dumpCtrl.save(); else inputCtrl.save();
    }
  });
}

/* ══════════════ SECTION NAV ══════════════ */
const SECTION_VIEWS = {
  summary: 'summaryView', mto: 'mtoView',
  'upload-ipmcs': 'uploadIpmcsView', 'upload-model': 'uploadModelView',
};

function switchSection(section) {
  activeSection = section;
  document.querySelectorAll('.section-item').forEach(item => {
    item.classList.toggle('active', item.dataset.section === section);
  });
  Object.entries(SECTION_VIEWS).forEach(([key, viewId]) => {
    document.getElementById(viewId).style.display = key === section ? 'flex' : 'none';
  });

  if (section === 'summary') {
    renderSummaryTable(document.getElementById('summarySearch').value);
  } else if (section === 'mto') {
    switchTab('input');
  }
}

/* ══════════════ MTO SECTION TABS ══════════════ */
const TAB_PANELS = {
  input: 'panelInput', dumpcheck: 'panelDumpCheck', pid: 'panelPid',
  guideline: 'panelGuideline', special: 'panelSpecial',
};

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  Object.values(TAB_PANELS).forEach(id => { document.getElementById(id).style.display = 'none'; });
  document.getElementById(TAB_PANELS[tab]).style.display = 'flex';
  if (tab === 'pid') showPidFolders();
}

/* ══════════════ MTO SUMMARY TABLE (line list) ══════════════ */
function renderSummaryTable(query) {
  const q = (query || '').toLowerCase();
  const activeFilter = window.summaryFilter || 'all';
  const filtered = allLines
    .filter(l => l.lineNo.toLowerCase().includes(q))
    .filter(l => activeFilter === 'all' || l.status === activeFilter);

  const tbody = document.getElementById('summaryTbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-faint)">No lines found</td></tr>`;
  } else {
    tbody.innerHTML = filtered.map((l, i) => `
      <tr class="summary-row ${inputCtrl && inputCtrl.activeLineId === l.id ? 'row-active' : ''}" data-line-id="${l.id}">
        <td style="color:var(--text-faint);font-family:var(--font-mono);font-size:10px">${String(i + 1).padStart(2, '0')}</td>
        <td class="td-tag">${l.lineNo}</td>
        <td style="color:var(--text-secondary);font-size:11px">${l.service}</td>
        <td style="color:var(--text-secondary);font-size:11px">${l.zone}</td>
        <td style="color:var(--text-secondary);font-size:11px">${l.pipingSpec || '—'}</td>
        <td style="color:var(--text-secondary);font-size:11px">${l.sizeIn || '—'}</td>
        <td>${STATUS_BADGE[l.status]}</td>
        <td class="td-num">${l.items}</td>
        <td class="td-num"><i class="ti ti-arrow-right summary-open-hint"></i></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('.summary-row').forEach(row => {
      row.addEventListener('click', async () => {
        switchSection('mto');
        await inputCtrl.selectLine(Number(row.dataset.lineId));
      });
    });
  }
  document.getElementById('summaryCountBadge').textContent = allLines.length;
  document.getElementById('summaryTotalBadge').textContent = filtered.length + ' lines';
}

/* ══════════════ MTO CONTROLLER FACTORY ══════════════
   Powers both "MTO Input" (manual items) and "MTO from Dump Check" (dump
   items) tabs with the COSMAS Bill of Material content: Line Information
   (Service / Unit / LSR NO / Subline No. / Zone), the COSMAS line header,
   and the BoM rows (Piping Class | Input Code | Item Code | Dia1 | Dia2 |
   Qty | Err) beside the SP P&ID comparison. Each tab has its own line
   selection and item dataset; `p` is the element-id prefix ('' or 'dc_').
   Row edits, inserts and deletes stay local until Save (Undo works on them). */
const COSMAS_KEYS = [
  'contrCode', 'pipingClass', 'drgIndicator', 'drgAreaNo', 'drgRevNo',
  'insType', 'insExtent', 'oprTemp1', 'oprTemp2', 'desTemp1', 'desTemp2',
  'batchNo', 'batchRevNo', 'cleaningCode', 'insThirdParty', 'paintThirdParty',
];
const ROW_FIELDS = ['pipingClass', 'inputCode', 'itemCode', 'dia1', 'dia2', 'qty'];
const LINE_STATUS_TEXT = { pending: 'Pending', inprogress: 'In Progress', complete: 'Complete' };

function escAttr(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// LSR NO / Subline No. from a stored seq ("05341-01" → 05341 + 01; "05341A" stays whole)
function splitSeqNo(seqNo) {
  const m = String(seqNo || '').match(/^(.+?)-(\d{1,3})$/);
  return m ? { lsr: m[1], subline: m[2] } : { lsr: String(seqNo || ''), subline: '' };
}

function createMtoController(cfg) {
  const p = cfg.prefix;
  const byId = (name) => document.getElementById(p + name);
  const state = {
    activeLineId: null, line: null,
    rows: [],          // working copy of the BoM rows (id < 0 = not saved yet)
    deleted: [],       // saved rows removed since the last save
    extracted: [],
    selectedId: null,
    undo: [],
    dirty: false,
  };
  let tmpId = -1;

  /* ── Line Information: Service → LSR NO → Subline No. → Zone ── */
  function fillSelect(sel, values, placeholder, labels = {}) {
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      values.map(v => `<option value="${escAttr(v)}">${escAttr(labels[v] ?? v)}</option>`).join('');
  }
  const SUBLINE_NONE = '__none__';   // the line itself, no sub-line

  async function populateServices() {
    fillSelect(byId('li_service'), await DataStore.getServices(), 'Select…');
  }

  async function onServiceChange() {
    if (!confirmDiscard()) { byId('li_service').value = state.line?.service || ''; return; }
    const service = byId('li_service').value;
    fillSelect(byId('li_seq'), service ? await DataStore.getSequences(service) : [], 'Select…');
    byId('li_seq').disabled = !service;
    resetBelow('seq');
  }

  async function onSeqChange() {
    if (!confirmDiscard()) { byId('li_seq').value = splitSeqNo(state.line?.seqNo).lsr; return; }
    const service = byId('li_service').value, lsr = byId('li_seq').value;
    resetBelow('seq');
    if (!lsr) return;
    const subs = (await DataStore.getSublines(service, lsr)).map(s => s || SUBLINE_NONE);
    fillSelect(byId('li_subline'), subs, 'Select…', { [SUBLINE_NONE]: '— (none)' });
    byId('li_subline').disabled = false;
    if (subs.length === 1) { byId('li_subline').value = subs[0]; await onSublineChange(); }
  }

  function composedSeq() {
    const lsr = byId('li_seq').value, sub = byId('li_subline').value;
    if (!lsr || !sub) return '';
    return sub === SUBLINE_NONE ? lsr : `${lsr}-${sub}`;
  }

  // Zones aren't in the line list or the P&IDs — they're set here: the zones
  // already used for this line (or "A" for a new one), plus "Add zone…" for
  // when a line is split between engineers.
  const NEW_ZONE = '__new__';
  function fillZones(zones) {
    fillSelect(byId('li_zone'), zones, 'Select…');
    if (zones.length) byId('li_zone').insertAdjacentHTML('beforeend', `<option value="${NEW_ZONE}">+ Add zone…</option>`);
  }

  async function onSublineChange() {
    if (!confirmDiscard()) { byId('li_subline').value = splitSeqNo(state.line?.seqNo).subline || SUBLINE_NONE; return; }
    const seq = composedSeq();
    fillZones(seq ? await DataStore.getZones(byId('li_service').value, seq) : []);
    byId('li_zone').disabled = !seq;
    clearSelection();
  }

  async function onZoneChange() {
    if (!confirmDiscard()) { byId('li_zone').value = state.line?.zone || ''; return; }
    const service = byId('li_service').value, seq = composedSeq();
    let zone = byId('li_zone').value;
    if (zone === NEW_ZONE) {
      const typed = (prompt('New zone for this line (1–3 letters or digits, e.g. B):') || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{1,3}$/.test(typed)) {
        byId('li_zone').value = '';
        if (typed) showToast('error', 'Invalid zone', 'Use 1–3 letters or digits, e.g. B');
        clearSelection();
        return;
      }
      if (![...byId('li_zone').options].some(o => o.value === typed)) {
        byId('li_zone').querySelector(`option[value="${NEW_ZONE}"]`).insertAdjacentHTML('beforebegin', `<option value="${typed}">${typed}</option>`);
      }
      byId('li_zone').value = zone = typed;
    }
    if (!zone) { clearSelection(); return; }
    try {
      const line = await DataStore.resolveLine(service, seq, zone);
      if (!line) { showToast('error', 'Could not open line', 'Not found in the line list or the uploaded P&IDs'); return; }
      const known = allLines.findIndex(x => x.id === line.id);
      if (known >= 0) allLines[known] = { ...allLines[known], ...line }; else allLines.push(line);
      await loadLine(line);
    } catch (err) {
      showToast('error', 'Could not open line', err.message);
    }
  }

  function resetBelow(level) {
    if (level === 'seq') {
      fillSelect(byId('li_subline'), [], 'Select…'); byId('li_subline').disabled = true;
    }
    fillSelect(byId('li_zone'), [], 'Select…'); byId('li_zone').disabled = true;
    clearSelection();
  }

  async function syncDropdownsToLine(line) {
    const { lsr, subline } = splitSeqNo(line.seqNo);
    byId('li_service').value = line.service;
    fillSelect(byId('li_seq'), await DataStore.getSequences(line.service), 'Select…');
    byId('li_seq').disabled = false; byId('li_seq').value = lsr;
    const subs = (await DataStore.getSublines(line.service, lsr)).map(s => s || SUBLINE_NONE);
    fillSelect(byId('li_subline'), subs, 'Select…', { [SUBLINE_NONE]: '— (none)' });
    byId('li_subline').disabled = false; byId('li_subline').value = subline || SUBLINE_NONE;
    fillZones(await DataStore.getZones(line.service, line.seqNo));
    byId('li_zone').disabled = false; byId('li_zone').value = line.zone;
  }

  async function selectLine(id) {
    if (id === state.activeLineId) return;
    if (!confirmDiscard()) return;
    const line = allLines.find(x => x.id === id);
    if (!line) return;
    try {
      await syncDropdownsToLine(line);
      await loadLine(line);
    } catch (err) {
      showToast('error', 'Could not open line', err.message);
    }
  }

  /* ── COSMAS line header ── */
  // Values from the line list / P&ID, shown until the engineer types something else
  function headerDefaults(line) {
    return {
      pipingClass: line.pipingSpec, insType: line.insulationType,
      oprTemp1: line.opTemp, oprTemp2: line.opTemp2, desTemp1: line.designTemp, desTemp2: line.designTemp2,
    };
  }

  function fillHeader(line) {
    const saved = (line && line.cosmas) || {};
    const defaults = line ? headerDefaults(line) : {};
    COSMAS_KEYS.forEach(k => {
      const input = byId('cos_' + k);
      input.value = saved[k] ?? defaults[k] ?? '';
      input.disabled = !line;
      input.classList.toggle('cos-overridden', !!saved[k] && defaults[k] != null && saved[k] !== defaults[k]);
      input.title = defaults[k] ? `From line list / P&ID: ${defaults[k]}` : '';
    });
    const bolt = byId('cos_boltTensioning');
    bolt.checked = !!saved.boltTensioning; bolt.disabled = !line;
    renderHeaderStatus();
  }

  function readHeader() {
    const defaults = headerDefaults(state.line);
    const out = {};
    COSMAS_KEYS.forEach(k => {
      const v = byId('cos_' + k).value.trim();
      if (v && v !== (defaults[k] || '')) out[k] = v;   // store only what differs from the source
    });
    if (byId('cos_boltTensioning').checked) out.boltTensioning = true;
    return out;
  }

  function renderHeaderStatus() {
    const line = state.line;
    const statusEl = byId('ld_status');
    statusEl.textContent = `LINE STATUS : ${line ? LINE_STATUS_TEXT[line.status] || line.status : '—'}`;
    const SOURCE_LABELS = { line_list: 'Line list', pid: 'P&ID only', 'line_list+pid': 'Line list + P&ID', 'pid+parent_line': 'P&ID sub-line (P&T from parent line)' };
    statusEl.title = line ? [
      `Line No: ${line.lineNo}`,
      `Source: ${SOURCE_LABELS[line.source] || line.source}`,
      line.pidNo && `P&ID: ${line.pidNo}`,
      line.dataMismatch && `Differs: ${line.dataMismatch}`,
    ].filter(Boolean).join('\n') : '';
    // Contr_Code + service + unit + lsrno + subline + dwg.indicator + area no
    if (!line) { byId('ld_lineKey').textContent = '—'; return; }
    const { lsr, subline } = splitSeqNo(line.seqNo);
    byId('ld_lineKey').textContent = [
      byId('cos_contrCode').value.trim(), line.service, line.unitNo, lsr, subline,
      byId('cos_drgIndicator').value, byId('cos_drgAreaNo').value.trim(),
    ].join('') || '—';
  }

  /* ── Load / clear a line ── */
  async function loadLine(line) {
    state.activeLineId = line.id;
    state.line = line;
    fillHeader(line);
    byId('mtoTitle').textContent = (cfg.key === 'dumpcheck' ? 'MTO from Dump Check — ' : 'Manual MTO — ') + line.lineNo;

    if (cfg.drivesShared) {
      document.getElementById('selectedLineStat').innerHTML =
        `<i class="ti ti-point-filled" style="font-size:8px;color:var(--color-accent-strong)"></i> ${line.lineNo}`;
      renderSummaryTable(document.getElementById('summarySearch').value);
    }

    const [items, extracted] = await Promise.all([cfg.api.getItems(line.id), DataStore.getExtractedItems(line.id)]);
    state.rows = items.map(r => ({ ...r }));
    state.extracted = extracted;
    state.deleted = []; state.undo = []; state.selectedId = null;
    markSaved();
    refresh();
  }

  function clearSelection() {
    state.activeLineId = null; state.line = null;
    state.rows = []; state.deleted = []; state.extracted = []; state.undo = []; state.selectedId = null;
    state.dirty = false;
    fillHeader(null);
    if (cfg.drivesShared) document.getElementById('selectedLineStat').textContent = 'No line selected';
    refresh();
  }

  function confirmDiscard() {
    return !state.dirty || confirm('This line has unsaved changes. Discard them?');
  }

  /* ── BoM rows ── */
  function rowErrors(r) {
    const errs = [];
    if (!r.pipingClass) errs.push('Piping Class missing');
    if (!r.inputCode && !r.itemCode) errs.push('Input Code or Item Code required');
    if (!r.dia1) errs.push('Dia1 missing');
    if (!(parseFloat(r.qty) > 0)) errs.push('Qty must be more than 0');
    return errs;
  }

  function itemKey(r) {
    return [r.pipingClass, r.inputCode, r.itemCode, r.dia1, r.dia2].map(v => String(v || '').trim()).join('|').toLowerCase();
  }

  function computeComparison() {
    const extractedByKey = new Map(state.extracted.map(e => [itemKey(e), e]));
    const rowsByKey = new Map(state.rows.map(r => [itemKey(r), r]));
    const itemStatus = new Map(), extractedStatus = new Map();
    let matched = 0, mismatch = 0, itemsOnly = 0, extractedOnly = 0;
    state.rows.forEach(r => {
      const e = extractedByKey.get(itemKey(r));
      if (!e) { itemStatus.set(r.id, 'only'); itemsOnly++; }
      else if (Number(r.qty) === Number(e.qty)) { itemStatus.set(r.id, 'matched'); matched++; }
      else { itemStatus.set(r.id, 'mismatch'); mismatch++; }
    });
    state.extracted.forEach(e => {
      const r = rowsByKey.get(itemKey(e));
      if (!r) { extractedStatus.set(e.id, 'only'); extractedOnly++; }
      else extractedStatus.set(e.id, Number(r.qty) === Number(e.qty) ? 'matched' : 'mismatch');
    });
    return { matched, mismatch, itemsOnly, extractedOnly, itemStatus, extractedStatus };
  }

  function renderSummary(cmp) {
    byId(cfg.lsIds.matched).textContent = cmp.matched;
    byId(cfg.lsIds.mismatch).textContent = cmp.mismatch;
    byId(cfg.lsIds.only).textContent = cmp.itemsOnly;
    byId(cfg.lsIds.extractedOnly).textContent = cmp.extractedOnly;
  }

  function renderRows(itemStatus) {
    const wrap = byId('mtoTableWrap'), empty = byId('emptyState'), summaryBar = byId('mtoSummary');
    if (!state.activeLineId) {
      wrap.style.display = 'none'; empty.style.display = 'flex'; summaryBar.style.display = 'none';
      byId('itemCountBadge').textContent = '0 items';
      return;
    }
    wrap.style.display = 'block'; empty.style.display = 'none'; summaryBar.style.display = 'flex';

    const rowClass = { mismatch: 'row-mismatch', only: 'row-manual-only' };
    const cell = (r, f, cls = '') => `<input class="inline-input ${cls}" data-row="${r.id}" data-field="${f}" value="${escAttr(r[f])}"/>`;
    let errorCount = 0;
    byId('mtoTbody').innerHTML = state.rows.map(r => {
      const errs = rowErrors(r);
      if (errs.length) errorCount++;
      const cls = [rowClass[itemStatus.get(r.id)], r.id === state.selectedId && 'row-active', (r.id < 0 || r._dirty) && 'row-dirty'].filter(Boolean).join(' ');
      return `<tr class="${cls}" data-row-id="${r.id}">
        <td class="td-acts" style="justify-content:flex-start">
          <div class="tool-btn" data-edit-id="${r.id}" title="Edit"><i class="ti ti-pencil"></i></div>
          <div class="tool-btn" data-delete-id="${r.id}" title="Delete" style="color:var(--color-danger)"><i class="ti ti-trash"></i></div>
        </td>
        <td>${cell(r, 'pipingClass')}</td>
        <td>${cell(r, 'inputCode')}</td>
        <td>${cell(r, 'itemCode')}</td>
        <td>${cell(r, 'dia1', 'num')}</td>
        <td>${cell(r, 'dia2', 'num')}</td>
        <td>${cell(r, 'qty', 'num')}</td>
        <td class="cos-err" title="${escAttr(errs.join('\n'))}">${errs.length ? '!' : ''}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-faint)">No rows yet — press Insert</td></tr>`;

    byId('sumItems').textContent = state.rows.length;
    byId('sumQty').textContent = +state.rows.reduce((s, r) => s + (parseFloat(r.qty) || 0), 0).toFixed(3);
    byId('sumErrors').textContent = errorCount;
    byId('itemCountBadge').textContent = state.rows.length + ' items';
  }

  function renderExtracted(extractedStatus) {
    const wrap = byId('extractedTableWrap'), empty = byId('extractedEmptyState');
    if (!state.activeLineId || !state.extracted.length) {
      wrap.style.display = 'none'; empty.style.display = 'flex';
      empty.querySelector('.empty-msg').textContent = 'No extraction available';
      empty.querySelector('.empty-sub').textContent = state.activeLineId
        ? 'This line has no Smart P&ID extraction yet'
        : 'Select a line to view its Smart P&ID extracted quantities';
      byId('extractedCountBadge').textContent = '0 items';
      return;
    }
    wrap.style.display = 'block'; empty.style.display = 'none';
    const rowClass = { mismatch: 'row-mismatch', only: 'row-extracted-only' };
    const td = (v, cls = '') => `<td class="${cls}">${escAttr(v ?? '')}</td>`;
    byId('extractedTbody').innerHTML = state.extracted.map((e, i) => `
      <tr class="${rowClass[extractedStatus.get(e.id)] || ''}">
        <td style="color:var(--text-faint);font-family:var(--font-mono);font-size:10px">${String(i + 1).padStart(2, '0')}</td>
        ${td(e.pipingClass)}${td(e.inputCode)}${td(e.itemCode)}${td(e.dia1, 'td-tag')}${td(e.dia2, 'td-tag')}${td(e.qty, 'td-num')}
      </tr>`).join('');
    byId('extractedCountBadge').textContent = state.extracted.length + ' items';
  }

  function refresh() {
    const cmp = computeComparison();
    renderSummary(cmp);
    renderRows(cmp.itemStatus);
    renderExtracted(cmp.extractedStatus);
  }

  /* ── Row editing (local until Save) ── */
  function requireLine() {
    if (state.activeLineId) return true;
    showToast('error', 'No line selected', 'Choose Service, LSR NO, Subline No. and Zone first');
    return false;
  }
  const findRow = (id) => state.rows.find(r => r.id === id);
  const snapshot = (r) => Object.fromEntries(ROW_FIELDS.map(f => [f, r[f]]));
  function pushUndo(entry) { state.undo.push(entry); if (state.undo.length > 50) state.undo.shift(); }

  function insertRow(fields = {}, afterId = null) {
    if (!requireLine()) return;
    const row = {
      id: tmpId--, pipingClass: byId('cos_pipingClass').value.trim() || state.line.pipingSpec || '',
      inputCode: '', itemCode: '', dia1: '', dia2: '', qty: 1, ...fields,
    };
    const idx = afterId == null ? state.rows.length : state.rows.findIndex(r => r.id === afterId) + 1;
    state.rows.splice(idx, 0, row);
    state.selectedId = row.id;
    pushUndo({ type: 'insert', id: row.id });
    markUnsaved(); refresh();
    const first = byId('mtoTbody').querySelector(`input[data-row="${row.id}"][data-field="${fields.inputCode ? 'qty' : 'inputCode'}"]`);
    if (first) first.focus();
  }

  function duplicateRow() {
    if (!requireLine()) return;
    const r = findRow(state.selectedId);
    if (!r) { showToast('error', 'Select a row first', 'Click a row, then Duplicate'); return; }
    insertRow(snapshot(r), r.id);
  }

  function deleteRow(id = state.selectedId) {
    if (!requireLine()) return;
    const idx = state.rows.findIndex(r => r.id === id);
    if (idx < 0) { showToast('error', 'Select a row first', 'Click a row, then Delete Line'); return; }
    const [row] = state.rows.splice(idx, 1);
    if (row.id > 0) state.deleted.push(row.id);
    pushUndo({ type: 'delete', row, idx });
    state.selectedId = null;
    markUnsaved(); refresh();
  }

  function editCell(id, field, value) {
    const r = findRow(id);
    if (!r || String(r[field] ?? '') === value) return;
    pushUndo({ type: 'edit', id, field, before: r[field] });
    r[field] = value;
    if (r.id > 0) r._dirty = true;
    markUnsaved();
    updateRowInPlace(r);
  }

  // After a cell edit: refresh only that row's Err / status and the totals, so
  // focus stays where the user tabbed to (a full re-render would drop it)
  function updateRowInPlace(r) {
    const cmp = computeComparison();
    renderSummary(cmp);
    renderExtracted(cmp.extractedStatus);
    const tr = byId('mtoTbody').querySelector(`tr[data-row-id="${r.id}"]`);
    if (tr) {
      const errs = rowErrors(r);
      const errCell = tr.querySelector('.cos-err');
      errCell.textContent = errs.length ? '!' : '';
      errCell.title = errs.join('\n');
      tr.classList.remove('row-mismatch', 'row-manual-only');
      const st = cmp.itemStatus.get(r.id);
      if (st === 'mismatch') tr.classList.add('row-mismatch');
      if (st === 'only') tr.classList.add('row-manual-only');
      tr.classList.add('row-dirty');
    }
    byId('sumQty').textContent = +state.rows.reduce((s, x) => s + (parseFloat(x.qty) || 0), 0).toFixed(3);
    byId('sumErrors').textContent = state.rows.filter(x => rowErrors(x).length).length;
  }

  function undo() {
    const u = state.undo.pop();
    if (!u) { showToast('info', 'Nothing to undo', ''); return; }
    if (u.type === 'insert') state.rows = state.rows.filter(r => r.id !== u.id);
    if (u.type === 'delete') {
      state.rows.splice(u.idx, 0, u.row);
      state.deleted = state.deleted.filter(id => id !== u.row.id);
    }
    if (u.type === 'edit') { const r = findRow(u.id); if (r) { r[u.field] = u.before; if (r.id > 0) r._dirty = true; } }
    if (u.type === 'header') { byId('cos_' + u.key).value = u.before; renderHeaderStatus(); }
    if (u.type === 'headerCheck') { byId('cos_boltTensioning').checked = u.before; }
    markUnsaved(); refresh();
  }

  /* ── Save: rows, header, line status ── */
  async function save() {
    if (!requireLine()) return;
    const btn = byId('saveBtn'); btn.disabled = true;
    try {
      for (const id of state.deleted) await cfg.api.deleteItem(id);
      for (const r of state.rows) {
        if (r.id < 0) await cfg.api.addItem(state.activeLineId, snapshot(r));
        else if (r._dirty) await cfg.api.updateItem(r.id, snapshot(r));
      }
      const updatedLine = await DataStore.saveLineCosmas(state.activeLineId, readHeader());
      Object.assign(state.line, updatedLine);

      if (cfg.drivesShared) {
        const count = state.rows.length;
        const status = count ? (state.line.status === 'complete' ? 'complete' : 'inprogress') : 'pending';
        Object.assign(state.line, await DataStore.setLineStatus(state.activeLineId, status, count));
      }
      const known = allLines.find(x => x.id === state.activeLineId);
      if (known) Object.assign(known, state.line);
      if (cfg.drivesShared) renderSummaryTable(document.getElementById('summarySearch').value);

      state.rows = (await cfg.api.getItems(state.activeLineId)).map(r => ({ ...r }));
      state.deleted = []; state.undo = []; state.selectedId = null;
      fillHeader(state.line);
      markSaved(); refresh();
      showToast('success', 'Saved', `${state.rows.length} row(s) saved for ${state.line.lineNo}`);
    } catch (err) {
      showToast('error', 'Could not save', err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function markUnsaved() {
    state.dirty = true;
    byId('unsavedBadge').style.display = 'inline-flex';
    byId('savedBadge').style.display = 'none';
  }
  function markSaved() {
    state.dirty = false;
    byId('unsavedBadge').style.display = 'none';
    byId('savedBadge').style.display = 'inline-flex';
  }

  /* ── << < > >> : step through the lines opened for this job/unit ── */
  function orderedLines() {
    return [...allLines].sort((a, b) =>
      String(a.service).localeCompare(String(b.service)) ||
      String(a.seqNo).localeCompare(String(b.seqNo), undefined, { numeric: true }) ||
      String(a.zone).localeCompare(String(b.zone)));
  }
  function navigate(where) {
    const list = orderedLines();
    if (!list.length) { showToast('info', 'No lines yet', 'Open a line with the selectors first'); return; }
    const i = list.findIndex(l => l.id === state.activeLineId);
    const target = { first: 0, last: list.length - 1, prev: i <= 0 ? 0 : i - 1, next: i < 0 ? 0 : Math.min(i + 1, list.length - 1) }[where];
    if (list[target].id !== state.activeLineId) selectLine(list[target].id);
  }

  /* ── Export Line Data to Excel (CSV, opens in Excel) ── */
  function exportLine() {
    if (!requireLine()) return;
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = readHeader(), defaults = headerDefaults(state.line);
    const { lsr, subline } = splitSeqNo(state.line.seqNo);
    const lines = [
      ['Line Key', byId('ld_lineKey').textContent], ['Line No', state.line.lineNo],
      ['Service', state.line.service], ['Unit', state.line.unitNo], ['LSR NO', lsr], ['Subline No.', subline], ['Zone', state.line.zone],
      ...COSMAS_KEYS.map(k => [byId('cos_' + k).closest('.field').querySelector('.field-label').textContent, head[k] ?? defaults[k] ?? '']),
      ['Bolt Tensioning Required', byId('cos_boltTensioning').checked ? 'Yes' : 'No'],
      [],
      ['Piping Class', 'Input Code', 'Item Code', 'Dia1', 'Dia2', 'Qty', 'Err'],
      ...state.rows.map(r => [...ROW_FIELDS.map(f => r[f]), rowErrors(r).join('; ')]),
    ];
    const csv = '﻿' + lines.map(row => row.map(q).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${state.line.lineNo.replace(/[^\w.-]+/g, '_')}_${state.line.zone}_BoM.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function openPidViewer() {
    if (!requireLine()) return;
    try {
      const doc = await DataStore.getPidDocumentForLine(state.activeLineId);
      window.open(`pid-viewer.html?doc=${doc.masterIndexId}&line=${state.activeLineId}`, 'ipmcs_pid_viewer_' + cfg.key, 'width=1100,height=800');
    } catch (err) {
      showToast('error', 'No P&ID available for this line', err.message);
    }
  }

  /* ── Wiring ── */
  byId('li_service').addEventListener('change', onServiceChange);
  byId('li_seq').addEventListener('change', onSeqChange);
  byId('li_subline').addEventListener('change', onSublineChange);
  byId('li_zone').addEventListener('change', onZoneChange);

  COSMAS_KEYS.forEach(k => {
    const input = byId('cos_' + k);
    input.addEventListener('focus', () => { input.dataset.before = input.value; });
    input.addEventListener('change', () => {
      pushUndo({ type: 'header', key: k, before: input.dataset.before ?? '' });
      input.dataset.before = input.value;
      markUnsaved(); renderHeaderStatus();
    });
    input.addEventListener('input', renderHeaderStatus);
  });
  byId('cos_boltTensioning').addEventListener('change', (e) => {
    pushUndo({ type: 'headerCheck', before: !e.target.checked });
    markUnsaved();
  });

  const tbody = byId('mtoTbody');
  tbody.addEventListener('change', (e) => {
    const inp = e.target.closest('input[data-row]');
    if (inp) editCell(Number(inp.dataset.row), inp.dataset.field, inp.value.trim());
  });
  tbody.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete-id]');
    if (del) { deleteRow(Number(del.dataset.deleteId)); return; }
    const tr = e.target.closest('tr[data-row-id]');
    if (!tr) return;
    const id = Number(tr.dataset.rowId);
    if (state.selectedId !== id) {
      state.selectedId = id;
      tbody.querySelectorAll('tr.row-active').forEach(x => x.classList.remove('row-active'));
      tr.classList.add('row-active');
    }
    if (e.target.closest('[data-edit-id]')) tr.querySelector('input[data-field="pipingClass"]').focus();
  });

  byId('addItemBtn').addEventListener('click', () => insertRow());
  byId('dupItemBtn').addEventListener('click', duplicateRow);
  byId('deleteItemBtn').addEventListener('click', () => deleteRow());
  byId('undoBtn').addEventListener('click', undo);
  byId('saveBtn').addEventListener('click', save);
  byId('navFirstBtn').addEventListener('click', () => navigate('first'));
  byId('navPrevBtn').addEventListener('click', () => navigate('prev'));
  byId('navNextBtn').addEventListener('click', () => navigate('next'));
  byId('navLastBtn').addEventListener('click', () => navigate('last'));
  byId('exportBtn').addEventListener('click', exportLine);
  byId('openPidBtn').addEventListener('click', openPidViewer);
  byId('uploadBtn').addEventListener('click', () => openUploadModal(controller));
  byId('mtoTbody').closest('.entry-col').querySelectorAll('.cos-soon').forEach(btn => {
    btn.addEventListener('click', () => showToast('info', btn.dataset.label, 'Coming soon — this COSMAS function is not built yet'));
  });

  fillHeader(null);

  const controller = {
    key: cfg.key,
    onlyLabel: cfg.onlyLabel,
    get activeLineId() { return state.activeLineId; },
    get hasUnsavedChanges() { return state.dirty; },
    populateServices, selectLine,
    // Unit switched: start again from Service for the new unit
    resetForUnit: async () => {
      byId('li_service').value = '';
      fillSelect(byId('li_seq'), [], 'Select…'); byId('li_seq').disabled = true;
      resetBelow('seq');
      await populateServices();
    },
    // Model Dump / other callers adding a row to the open line
    addNewItem: async (fields) => { insertRow(fields); return findRow(state.selectedId); },
  };
  return controller;
}

/* ══════════════ P&ID LIBRARY (folders → documents → multi-user highlight status) ══════════════ */
let pidFolders = [];
let pidActiveFolder = null;
let pidDocs = [];
let pidActiveDoc = null;

let pidStatusCanvas, pidStatusCtx, pidOverlayCanvas, pidOverlayCtx;
let pidStatusPdfDoc = null, pidStatusPageNum = 1, pidStatusScale = 1.25, pidStatusRenderTask = null;

function initPidLibrary() {
  pidStatusCanvas = document.getElementById('pidStatusPdfCanvas');
  pidStatusCtx = pidStatusCanvas.getContext('2d');
  pidOverlayCanvas = document.getElementById('pidStatusOverlayCanvas');
  pidOverlayCtx = pidOverlayCanvas.getContext('2d');

  document.getElementById('pidNewFolderBtn').addEventListener('click', openPidFolderModal);
  document.getElementById('pidSelectBtn').addEventListener('click', openPidSelectModal);
  document.getElementById('pidBackToFoldersBtn').addEventListener('click', showPidFolders);
  document.getElementById('pidBackToDocsBtn').addEventListener('click', () => openPidFolder(pidActiveFolder));
  document.getElementById('pidRefreshBtn').addEventListener('click', () => openPidDocument(pidActiveDoc));

  document.getElementById('pidZoomInBtn').addEventListener('click', () => pidStatusZoom(1.15));
  document.getElementById('pidZoomOutBtn').addEventListener('click', () => pidStatusZoom(0.87));
  document.getElementById('pidZoomResetBtn').addEventListener('click', () => { pidStatusScale = 1.25; renderPidStatusPage(); });
  document.getElementById('pidPrevPageBtn').addEventListener('click', () => changePidStatusPage(-1));
  document.getElementById('pidNextPageBtn').addEventListener('click', () => changePidStatusPage(1));

  document.getElementById('pidFolderForm').addEventListener('submit', submitPidFolder);
  document.getElementById('closePidFolderModal').addEventListener('click', closePidFolderModal);
  document.getElementById('cancelPidFolderModal').addEventListener('click', closePidFolderModal);

  document.getElementById('closePidSelectModal').addEventListener('click', closePidSelectModal);
  document.getElementById('cancelPidSelectModal').addEventListener('click', closePidSelectModal);
}

function pidView(name) {
  ['pidFoldersView', 'pidDocumentsView', 'pidStatusView'].forEach(id => {
    document.getElementById(id).style.display = id === name ? 'flex' : 'none';
  });
}

async function showPidFolders() {
  pidView('pidFoldersView');
  const isAdmin = currentUser && currentUser.role === 'ADMIN';
  document.getElementById('pidNewFolderBtn').style.display = isAdmin ? 'inline-flex' : 'none';

  try {
    pidFolders = await DataStore.getPidFolders();
  } catch (err) {
    showToast('error', 'Could not load P&ID folders', err.message);
    pidFolders = [];
  }

  document.getElementById('pidFolderCountBadge').textContent = pidFolders.length + ' folders';
  const grid = document.getElementById('pidFolderGrid');
  if (!pidFolders.length) {
    grid.innerHTML = `<div class="pid-empty-hint">No folders yet${isAdmin ? ' — create one to get started.' : '.'}</div>`;
    return;
  }
  grid.innerHTML = pidFolders.map(f => `
    <div class="pid-card" data-folder-id="${f.id}">
      <i class="ti ti-folder pid-card-icon"></i>
      <div class="pid-card-title">${f.name}</div>
      <div class="pid-card-sub">${f.documentCount} P&amp;ID${f.documentCount === 1 ? '' : 's'}</div>
    </div>
  `).join('');
  grid.querySelectorAll('.pid-card').forEach(card => {
    card.addEventListener('click', () => {
      const folder = pidFolders.find(f => f.id === Number(card.dataset.folderId));
      openPidFolder(folder);
    });
  });
}

async function openPidFolder(folder) {
  pidActiveFolder = folder;
  pidView('pidDocumentsView');
  const isAdmin = currentUser && currentUser.role === 'ADMIN';
  document.getElementById('pidSelectBtn').style.display = isAdmin ? 'inline-flex' : 'none';
  document.getElementById('pidFolderTitle').textContent = folder.name;

  try {
    pidDocs = await DataStore.getPidDocuments(folder.id);
  } catch (err) {
    showToast('error', 'Could not load P&IDs', err.message);
    pidDocs = [];
  }
  renderPidDocGrid(isAdmin);
}

function renderPidDocGrid(isAdmin) {
  document.getElementById('pidDocCountBadge').textContent = pidDocs.length + ' P&IDs';
  const grid = document.getElementById('pidDocGrid');
  if (!pidDocs.length) {
    grid.innerHTML = `<div class="pid-empty-hint">No P&amp;IDs selected into this folder yet${isAdmin ? ' — select one from PIMS to get started.' : '.'}</div>`;
    return;
  }
  grid.innerHTML = pidDocs.map(d => `
    <div class="pid-card" data-master-index-id="${d.masterIndexId}">
      <i class="ti ti-file-type-pdf pid-card-icon"></i>
      <div class="pid-card-title">${d.pidName}</div>
      <div class="pid-card-sub">Rev ${d.revLabel || '—'} · ${d.uploadedBy || 'Unknown'} · ${new Date(d.uploadedAt).toLocaleDateString('en-IN')}</div>
    </div>
  `).join('');
  grid.querySelectorAll('.pid-card').forEach(card => {
    card.addEventListener('click', () => {
      const doc = pidDocs.find(d => d.masterIndexId === Number(card.dataset.masterIndexId));
      openPidDocument(doc);
    });
  });
}

async function openPidDocument(doc) {
  pidActiveDoc = doc;
  pidStatusPageNum = 1;
  pidStatusScale = 1.25;
  pidView('pidStatusView');
  document.getElementById('pidDocTitle').textContent = doc.pidName;
  document.getElementById('pidStatusLoading').classList.remove('hidden');
  document.getElementById('pidStatusLoading').innerHTML =
    `<i class="ti ti-loader-2 pdf-spin"></i><span>Loading P&ID…</span>`;

  try {
    const url = DataStore.pidFileUrl(doc.masterIndexId);
    pidStatusPdfDoc = await pdfjsLib.getDocument({ url, httpHeaders: DataStore.authHeaders() }).promise;
    document.getElementById('pidStatusLoading').classList.add('hidden');
    await renderPidStatusPage();
  } catch (err) {
    document.getElementById('pidStatusLoading').innerHTML =
      `<i class="ti ti-file-alert" style="font-size:26px"></i><span>Could not load PDF: ${err.message}</span>`;
  }
}

async function renderPidStatusPage() {
  const page = await pidStatusPdfDoc.getPage(pidStatusPageNum);
  const viewport = page.getViewport({ scale: pidStatusScale });

  pidStatusCanvas.width = viewport.width; pidStatusCanvas.height = viewport.height;
  pidOverlayCanvas.width = viewport.width; pidOverlayCanvas.height = viewport.height;

  if (pidStatusRenderTask) pidStatusRenderTask.cancel();
  pidStatusRenderTask = page.render({ canvasContext: pidStatusCtx, viewport });
  try {
    await pidStatusRenderTask.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    throw err;
  }

  let byUser = [];
  let zoneBreaks = [];
  try {
    [byUser, zoneBreaks] = await Promise.all([
      DataStore.getDocumentHighlights(pidActiveDoc.masterIndexId, pidStatusPageNum),
      DataStore.getPidZoneBreaks(pidActiveDoc.masterIndexId, pidStatusPageNum),
    ]);
  } catch (err) {
    showToast('error', 'Could not load highlight status', err.message);
  }
  drawPidStatusOverlay(byUser, zoneBreaks);

  document.getElementById('pidZoomLabel').textContent = Math.round(pidStatusScale * 100) + '%';
  document.getElementById('pidPageLabel').textContent = `Page ${pidStatusPageNum} / ${pidStatusPdfDoc.numPages}`;
  document.getElementById('pidPrevPageBtn').style.opacity = pidStatusPageNum <= 1 ? 0.4 : 1;
  document.getElementById('pidNextPageBtn').style.opacity = pidStatusPageNum >= pidStatusPdfDoc.numPages ? 0.4 : 1;
}

function drawPidStatusOverlay(byUser, zoneBreaks) {
  pidOverlayCtx.clearRect(0, 0, pidOverlayCanvas.width, pidOverlayCanvas.height);

  pidOverlayCtx.save();
  pidOverlayCtx.globalAlpha = 0.45;
  pidOverlayCtx.lineWidth = 14;
  pidOverlayCtx.lineCap = 'round';
  pidOverlayCtx.lineJoin = 'round';
  byUser.forEach(u => {
    (u.strokes || []).forEach(rawStroke => {
      const { points } = normalizePidStroke(rawStroke);
      if (points.length < 2) return;
      pidOverlayCtx.strokeStyle = pidStrokeColor(rawStroke, u.userId);
      pidOverlayCtx.beginPath();
      pidOverlayCtx.moveTo(points[0][0] * pidStatusScale, points[0][1] * pidStatusScale);
      for (let i = 1; i < points.length; i++) pidOverlayCtx.lineTo(points[i][0] * pidStatusScale, points[i][1] * pidStatusScale);
      pidOverlayCtx.stroke();
    });
  });
  pidOverlayCtx.restore();

  drawZoneBreakMarkers(pidOverlayCtx, zoneBreaks || [], pidStatusScale, byUser);

  // One row per zone actually present, showing which employee(s)
  // contributed — a log, not a person-to-color mapping. Strokes with no
  // zone are grouped by whoever drew them instead.
  const legend = document.getElementById('pidUserLegend');
  const byZone = new Map();
  const noZoneByUser = new Map();
  byUser.forEach(u => {
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

  if (!byZone.size && !noZoneByUser.size) {
    legend.innerHTML = `<span class="pid-legend-empty">No one has highlighted this P&ID yet</span>`;
  } else {
    const zoneChips = [...byZone.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([zone, empIds]) => `
      <span class="pid-legend-item"><span class="pid-legend-dot" style="background:${pidColorForZone(zone)}"></span>Zone ${zone} — ${[...empIds].join(', ')}</span>
    `).join('');
    const userChips = [...noZoneByUser.entries()].map(([userId, empId]) => `
      <span class="pid-legend-item"><span class="pid-legend-dot" style="background:${pidColorForUser(userId)}"></span>${empId}</span>
    `).join('');
    legend.innerHTML = zoneChips + userChips;
  }
}

// Small pin at each auto-detected junction where two different users'
// highlights touch — a zone hand-off point on the actual drawing. Labeled
// with each side's zone letter when known (see pid-viewer.js).
function drawZoneBreakMarkers(ctx, zoneBreaks, scale, byUser) {
  // Filtered by zone as well as user — a single user can be responsible
  // for more than one zone on the same sheet.
  const strokesForUserZone = (userId, zone) => {
    const entry = (byUser || []).find(u => u.userId === userId);
    return ((entry && entry.strokes) || []).filter(raw => normalizePidStroke(raw).zone === zone);
  };

  ctx.save();
  zoneBreaks.forEach(zb => {
    const x = zb.x * scale, y = zb.y * scale;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#e8a33d';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#e8a33d';
    ctx.fill();

    if (zb.zoneA || zb.zoneB) {
      // Each label sits on the same side as that user's actual stroke,
      // not an arbitrary fixed side.
      const dirA = pidZoneLabelDirection(strokesForUserZone(zb.userAId, zb.zoneA), zb.x, zb.y);
      const dirB = pidZoneLabelDirection(strokesForUserZone(zb.userBId, zb.zoneB), zb.x, zb.y);
      drawZoneLabel(ctx, x + dirA[0] * scale * 16, y + dirA[1] * scale * 16, zb.zoneA, zb.userAEmpId, pidColorForZone(zb.zoneA) || pidColorForUser(zb.userAId));
      drawZoneLabel(ctx, x + dirB[0] * scale * 16, y + dirB[1] * scale * 16, zb.zoneB, zb.userBEmpId, pidColorForZone(zb.zoneB) || pidColorForUser(zb.userBId));
    }
  });
  ctx.restore();
}

// A small pill showing which zone each side of a break belongs to (and
// which employee highlighted it) in that zone's color.
function drawZoneLabel(ctx, x, y, zone, empId, color) {
  if (!zone) return;
  ctx.save();
  const zoneFont = '700 12px ui-monospace, Menlo, Consolas, monospace';
  const idFont = '600 9px ui-monospace, Menlo, Consolas, monospace';

  ctx.font = zoneFont;
  const zoneW = ctx.measureText(zone).width;
  ctx.font = idFont;
  const idW = empId ? ctx.measureText(empId).width : 0;
  const w = Math.max(zoneW, idW) + 14;
  const h = empId ? 32 : 22;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 6);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  if (empId) {
    ctx.font = zoneFont;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(zone, x, y - 2);
    ctx.font = idFont;
    ctx.fillText(empId, x, y + 11);
  } else {
    ctx.font = zoneFont;
    ctx.textBaseline = 'middle';
    ctx.fillText(zone, x, y + 1);
  }
  ctx.restore();
}

function pidStatusZoom(factor) {
  pidStatusScale = Math.max(0.4, Math.min(4, pidStatusScale * factor));
  renderPidStatusPage();
}

function changePidStatusPage(delta) {
  if (!pidStatusPdfDoc) return;
  const next = pidStatusPageNum + delta;
  if (next < 1 || next > pidStatusPdfDoc.numPages) return;
  pidStatusPageNum = next;
  renderPidStatusPage();
}

/* ── Admin: create folder / upload P&ID ── */
function openPidFolderModal() {
  document.getElementById('pidFolderModal').classList.add('open');
  setTimeout(() => document.getElementById('pidFolderNameInput').focus(), 150);
}
function closePidFolderModal() {
  document.getElementById('pidFolderModal').classList.remove('open');
  document.getElementById('pidFolderNameInput').value = '';
}
async function submitPidFolder(e) {
  e.preventDefault();
  const name = document.getElementById('pidFolderNameInput').value.trim();
  if (!name) return;
  try {
    await DataStore.createPidFolder(name);
    closePidFolderModal();
    showToast('success', 'Folder created', name);
    showPidFolders();
  } catch (err) {
    showToast('error', 'Could not create folder', err.message);
  }
}

// ADMIN ticks which live PIMS P&ID sheets (for the current job/unit) belong
// in the open folder — PIMS stays the source of truth, this only records
// the selection.
async function openPidSelectModal() {
  document.getElementById('pidSelectDocModal').classList.add('open');
  const list = document.getElementById('pidSelectList');
  list.innerHTML = `<div class="pid-empty-hint">Loading…</div>`;
  try {
    const [available, selectedIds] = await Promise.all([
      DataStore.getAvailablePimsDocuments(),
      Promise.resolve(pidDocs.map(d => d.masterIndexId)),
    ]);
    renderPidSelectList(available, selectedIds);
  } catch (err) {
    list.innerHTML = `<div class="pid-empty-hint">Could not load PIMS P&amp;IDs: ${err.message}</div>`;
  }
}
function closePidSelectModal() {
  document.getElementById('pidSelectDocModal').classList.remove('open');
}
function renderPidSelectList(available, selectedIds) {
  const list = document.getElementById('pidSelectList');
  if (!available.length) {
    list.innerHTML = `<div class="pid-empty-hint">No active P&amp;IDs in PIMS for this job/unit yet.</div>`;
    return;
  }
  const selected = new Set(selectedIds);
  list.innerHTML = available.map(d => `
    <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--color-surface-raised);border:1px solid var(--color-border-strong);border-radius:var(--radius-md);cursor:pointer">
      <input type="checkbox" data-master-index-id="${d.masterIndexId}" ${selected.has(d.masterIndexId) ? 'checked' : ''}/>
      <div style="flex:1">
        <div style="font-size:13px;color:var(--text-primary);font-weight:500">${d.pidName}</div>
        <div style="font-size:11px;color:var(--text-secondary)">Rev ${d.revLabel || '—'} · ${d.fileName}</div>
      </div>
    </label>
  `).join('');
  list.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => togglePidSelection(Number(cb.dataset.masterIndexId), cb.checked));
  });
}
async function togglePidSelection(masterIndexId, checked) {
  try {
    if (checked) {
      await DataStore.addPidFolderSelection(pidActiveFolder.id, masterIndexId);
    } else {
      await DataStore.removePidFolderSelection(pidActiveFolder.id, masterIndexId);
    }
    pidDocs = await DataStore.getPidDocuments(pidActiveFolder.id);
    renderPidDocGrid(true);
  } catch (err) {
    showToast('error', 'Could not update selection', err.message);
  }
}

/* ══════════════ ADD ITEM MODAL (shared by both controllers) ══════════════ */
function openAddModal(ctrl) {
  if (!ctrl.activeLineId) { showToast('error', 'No line selected', 'Please select a line first'); return; }
  activeController = ctrl;
  document.getElementById('addModal').classList.add('open');
  setTimeout(() => document.getElementById('mi_desc').focus(), 150);
}
function closeAddModal() { document.getElementById('addModal').classList.remove('open'); }

function selectCategory(el) {
  selectedCat = el.dataset.cat;
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  const presets = {
    Pipe: 'CS ERW Pipe SCH-40', Elbow: 'CS BW Elbow 90° LR', Tee: 'CS BW Tee Equal',
    Reducer: 'CS BW Eccentric Reducer', Flange: 'CS WN Flange RF 300#',
    Valve: 'CS Gate Valve FF', Gasket: 'Spiral Wound Gasket SS+Gr.',
    'Stud Bolt': 'Stud Bolt A193 B7 w/ Nuts', Cap: 'CS BW Cap', Other: '',
  };
  document.getElementById('mi_desc').value = presets[selectedCat] || '';
  document.getElementById('mi_unit').value = selectedCat === 'Pipe' ? 'm' : 'NOS';
}

async function saveItem() {
  const desc = document.getElementById('mi_desc').value.trim();
  if (!desc) { document.getElementById('mi_desc').classList.add('input-invalid'); return; }
  document.getElementById('mi_desc').classList.remove('input-invalid');

  const newItem = {
    cat: selectedCat, desc,
    size: document.getElementById('mi_size').value,
    spec: document.getElementById('mi_spec').value,
    sch: document.getElementById('mi_sch').value,
    unit: document.getElementById('mi_unit').value,
    qty: parseFloat(document.getElementById('mi_qty').value) || 1,
    rem: document.getElementById('mi_rem').value.trim(),
  };

  let item;
  try {
    item = await activeController.addNewItem(newItem);
  } catch (err) {
    showToast('error', 'Could not add item', err.message);
    return;
  }

  closeAddModal();
  showToast('success', 'Item added', `${item.desc} · ${item.qty} ${item.unit}`);

  document.getElementById('mi_desc').value = '';
  document.getElementById('mi_qty').value = '';
  document.getElementById('mi_rem').value = '';
}

/* ══════════════ UPLOAD MODAL (placeholder, shared) ══════════════ */
function openUploadModal(ctrl) {
  if (!ctrl.activeLineId) { showToast('error', 'No line selected', 'Please select a line first'); return; }
  document.getElementById('uploadModal').classList.add('open');
}
function closeUploadModal() { document.getElementById('uploadModal').classList.remove('open'); }

function handleFile() {
  const f = document.getElementById('fileInput').files[0];
  if (!f) return;
  document.getElementById('filePreview').style.display = 'block';
  document.getElementById('fileName').textContent = f.name;
  document.getElementById('fileInfo').textContent =
    (f.size / 1024).toFixed(1) + ' KB · ' + (f.name.endsWith('.csv') ? 'CSV' : 'Excel') + ' format';
}

function processUpload() {
  closeUploadModal();
  showToast('info', 'Upload placeholder', 'Model dump parsing will run once file parsing is wired up');
}

/* ══════════════ TOAST ══════════════ */
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
