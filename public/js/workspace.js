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

  const jobUnitLabel = user.jobNo
    ? `${user.jobName ? user.jobName + ' · ' : ''}${user.jobNo}${user.unitNo ? ' · Unit ' + user.unitNo : ''}`
    : 'No job assigned';
  document.getElementById('projectPillEl').innerHTML = `<i class="ti ti-briefcase"></i>${jobUnitLabel}`;
  document.getElementById('jobUnitStatEl').textContent = jobUnitLabel;
  document.getElementById('li_unitDisplay').value = user.unitNo || '—';
  document.getElementById('dc_li_unitDisplay').value = user.unitNo || '—';

  bindGlobalEvents();
  initPidLibrary();

  inputCtrl = createMtoController({
    key: 'input',
    onlyLabel: 'Manual Only',
    drivesShared: true,
    api: {
      getItems: DataStore.getMTOItems, addItem: DataStore.addMTOItem,
      updateQty: DataStore.updateMTOItemQty, deleteItem: DataStore.deleteMTOItem,
    },
    ids: {
      service: 'li_service', seq: 'li_seq', zone: 'li_zone',
      ldLineNo: 'ld_lineNo', ldPipingSpec: 'ld_pipingSpec', ldSize: 'ld_size',
      ldSource: 'ld_source', ldCreatedBy: 'ld_createdBy', ldCreatedAt: 'ld_createdAt',
      ldOpPressure: 'ld_opPressure', ldOpTemp: 'ld_opTemp',
      ldDesignPressure: 'ld_designPressure', ldDesignTemp: 'ld_designTemp',
      ldInsulationType: 'ld_insulationType', ldInsulationThickness: 'ld_insulationThickness',
      lsMatched: 'lsMatched', lsMismatch: 'lsMismatch', lsOnly: 'lsManualOnly', lsExtractedOnly: 'lsExtractedOnly',
      paneTitle: 'mtoTitle', itemCountBadge: 'itemCountBadge',
      emptyState: 'emptyState', tableWrap: 'mtoTableWrap', tbody: 'mtoTbody',
      summaryBar: 'mtoSummary', sumItems: 'sumItems', sumPipe: 'sumPipe', sumFit: 'sumFit', sumValves: 'sumValves',
      unsavedBadge: 'unsavedBadge', savedBadge: 'savedBadge',
      extractedCountBadge: 'extractedCountBadge', extractedEmptyState: 'extractedEmptyState',
      extractedTableWrap: 'extractedTableWrap', extractedTbody: 'extractedTbody',
      addItemBtn: 'addItemBtn', uploadBtn: 'uploadBtn', openPidBtn: 'openPidBtn',
      exportBtn: 'exportBtn', saveBtn: 'saveBtn',
    },
  });

  dumpCtrl = createMtoController({
    key: 'dumpcheck',
    onlyLabel: 'Dump Only',
    drivesShared: false,
    api: {
      getItems: DataStore.getDumpItems, addItem: DataStore.addDumpItem,
      updateQty: DataStore.updateDumpItemQty, deleteItem: DataStore.deleteDumpItem,
    },
    ids: {
      service: 'dc_li_service', seq: 'dc_li_seq', zone: 'dc_li_zone',
      ldLineNo: 'dc_ld_lineNo', ldPipingSpec: 'dc_ld_pipingSpec', ldSize: 'dc_ld_size',
      ldSource: 'dc_ld_source', ldCreatedBy: 'dc_ld_createdBy', ldCreatedAt: 'dc_ld_createdAt',
      ldOpPressure: 'dc_ld_opPressure', ldOpTemp: 'dc_ld_opTemp',
      ldDesignPressure: 'dc_ld_designPressure', ldDesignTemp: 'dc_ld_designTemp',
      ldInsulationType: 'dc_ld_insulationType', ldInsulationThickness: 'dc_ld_insulationThickness',
      lsMatched: 'dc_lsMatched', lsMismatch: 'dc_lsMismatch', lsOnly: 'dc_lsManualOnly', lsExtractedOnly: 'dc_lsExtractedOnly',
      paneTitle: 'dc_mtoTitle', itemCountBadge: 'dc_itemCountBadge',
      emptyState: 'dc_emptyState', tableWrap: 'dc_mtoTableWrap', tbody: 'dc_mtoTbody',
      summaryBar: 'dc_mtoSummary', sumItems: 'dc_sumItems', sumPipe: 'dc_sumPipe', sumFit: 'dc_sumFit', sumValves: 'dc_sumValves',
      unsavedBadge: 'dc_unsavedBadge', savedBadge: 'dc_savedBadge',
      extractedCountBadge: 'dc_extractedCountBadge', extractedEmptyState: 'dc_extractedEmptyState',
      extractedTableWrap: 'dc_extractedTableWrap', extractedTbody: 'dc_extractedTbody',
      addItemBtn: 'dc_addItemBtn', uploadBtn: 'dc_uploadBtn', openPidBtn: 'dc_openPidBtn',
      exportBtn: 'dc_exportBtn', saveBtn: 'dc_saveBtn',
    },
  });

  try {
    allLines = await DataStore.getLines();
    await Promise.all([inputCtrl.populateServices(), dumpCtrl.populateServices()]);
  } catch (err) {
    showToast('error', 'Could not load lines', err.message);
  }

  switchSection('summary');
  setInterval(updateClock, 1000);
  updateClock();
});

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
    .map(a => `<option value="${a.jobNo}::${a.unitNo}">${a.jobName || a.jobNo} (${a.jobNo}) · Unit ${a.unitNo}</option>`)
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
   items) tabs — same Line Information / Line Data / Line Summary / entry
   table / SP P&ID comparison behavior, each with its own independent line
   selection and item dataset. */
function createMtoController(cfg) {
  const ids = cfg.ids;
  const state = { activeLineId: null, items: [], extracted: [], line: null };

  function el(key) { return document.getElementById(ids[key]); }

  function fillSelect(id, values, placeholder) {
    const sel = document.getElementById(id);
    sel.innerHTML = `<option value="">${placeholder}</option>` + values.map(v => `<option value="${v}">${v}</option>`).join('');
  }

  async function populateServices() {
    fillSelect(ids.service, await DataStore.getServices(), 'Select…');
  }

  async function onServiceChange() {
    const service = el('service').value;
    fillSelect(ids.seq, service ? await DataStore.getSequences(service) : [], 'Select…');
    el('seq').disabled = !service;
    fillSelect(ids.zone, [], 'Select…'); el('zone').disabled = true;
    clearSelection();
  }

  // Zones aren't in the line list or the P&IDs — they're set here: the zones
  // already used for this line (or "A" for a new one), plus "Add zone…" for
  // when a line is split between engineers.
  const NEW_ZONE = '__new__';
  function fillZones(zones) {
    fillSelect(ids.zone, zones, 'Select…');
    if (zones.length) el('zone').insertAdjacentHTML('beforeend', `<option value="${NEW_ZONE}">+ Add zone…</option>`);
  }

  async function onSeqChange() {
    const service = el('service').value, seq = el('seq').value;
    fillZones(seq ? await DataStore.getZones(service, seq) : []);
    el('zone').disabled = !seq;
    clearSelection();
  }

  async function onZoneChange() {
    const service = el('service').value, seq = el('seq').value;
    let zone = el('zone').value;
    if (zone === NEW_ZONE) {
      const typed = (prompt('New zone for this line (1–3 letters or digits, e.g. B):') || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{1,3}$/.test(typed)) {
        el('zone').value = '';
        if (typed) showToast('error', 'Invalid zone', 'Use 1–3 letters or digits, e.g. B');
        clearSelection();
        return;
      }
      if (![...el('zone').options].some(o => o.value === typed)) {
        el('zone').querySelector(`option[value="${NEW_ZONE}"]`).insertAdjacentHTML('beforebegin', `<option value="${typed}">${typed}</option>`);
      }
      el('zone').value = zone = typed;
    }
    if (!zone) { clearSelection(); return; }
    try {
      const line = await DataStore.resolveLine(service, seq, zone);
      if (line) await loadLine(line);
      else showToast('error', 'Could not open line', 'Not found in the line list or the uploaded P&IDs');
    } catch (err) {
      showToast('error', 'Could not open line', err.message);
    }
  }

  async function syncDropdownsToLine(line) {
    el('service').value = line.service;

    fillSelect(ids.seq, await DataStore.getSequences(line.service), 'Select…');
    el('seq').disabled = false; el('seq').value = line.seqNo;

    fillZones(await DataStore.getZones(line.service, line.seqNo));
    el('zone').disabled = false; el('zone').value = line.zone;
  }

  async function selectLine(id) {
    const line = allLines.find(x => x.id === id);
    try {
      await syncDropdownsToLine(line);
      await loadLine(line);
    } catch (err) {
      showToast('error', 'Could not open line', err.message);
    }
  }

  async function loadLine(line) {
    state.activeLineId = line.id;
    state.line = line;

    el('ldLineNo').textContent = line.lineNo || '—';
    el('ldPipingSpec').textContent = line.pipingSpec || '—';
    el('ldSize').textContent = line.sizeIn || '—';
    // Where the data came from; hover shows the P&ID(s) and any line list ≠ P&ID differences
    const SOURCE_LABELS = { line_list: 'Line list', pid: 'P&ID only', 'line_list+pid': 'Line list + P&ID' };
    el('ldSource').textContent = (SOURCE_LABELS[line.source] || line.source || '—') + (line.dataMismatch ? ' ⚠' : '');
    el('ldSource').title = [line.pidNo && `P&ID: ${line.pidNo}`, line.dataMismatch && `Differs: ${line.dataMismatch}`].filter(Boolean).join('\n');
    el('ldCreatedBy').textContent = line.createdBy || '—';
    el('ldCreatedAt').textContent = line.createdAt ? new Date(line.createdAt).toLocaleDateString() : '—';
    el('ldOpPressure').textContent = line.opPressure || '—';
    el('ldOpTemp').textContent = line.opTemp || '—';
    el('ldDesignPressure').textContent = line.designPressure || '—';
    el('ldDesignTemp').textContent = line.designTemp || '—';
    el('ldInsulationType').textContent = line.insulationType || '—';
    el('ldInsulationThickness').textContent = line.insulationThickness || '—';
    el('paneTitle').textContent = (cfg.key === 'dumpcheck' ? 'MTO from Dump Check — ' : 'Manual MTO — ') + line.lineNo;

    if (cfg.drivesShared) {
      document.getElementById('selectedLineStat').innerHTML =
        `<i class="ti ti-point-filled" style="font-size:8px;color:var(--color-accent-strong)"></i> ${line.lineNo}`;
      renderSummaryTable(document.getElementById('summarySearch').value);
    }

    [state.items, state.extracted] = await Promise.all([
      cfg.api.getItems(line.id),
      DataStore.getExtractedItems(line.id),
    ]);

    markSaved();
    refresh();
  }

  function clearSelection() {
    state.activeLineId = null;
    state.items = [];
    state.extracted = [];
    state.line = null;
    [ids.ldLineNo, ids.ldPipingSpec, ids.ldSize, ids.ldSource, ids.ldCreatedBy, ids.ldCreatedAt,
     ids.ldOpPressure, ids.ldOpTemp, ids.ldDesignPressure, ids.ldDesignTemp, ids.ldInsulationType, ids.ldInsulationThickness]
      .forEach(id => { document.getElementById(id).textContent = '—'; });
    if (cfg.drivesShared) {
      document.getElementById('selectedLineStat').textContent = 'No line selected';
    }
    refresh();
  }

  function itemKey(item) {
    return [item.desc, item.size, item.spec, item.sch, item.unit].join('|').toLowerCase();
  }

  function computeComparison() {
    const extractedByKey = new Map();
    state.extracted.forEach(e => extractedByKey.set(itemKey(e), e));
    const itemsByKey = new Map();
    state.items.forEach(m => itemsByKey.set(itemKey(m), m));

    const itemStatus = new Map();
    const extractedStatus = new Map();
    let matched = 0, mismatch = 0, itemsOnly = 0, extractedOnly = 0;

    state.items.forEach(m => {
      const e = extractedByKey.get(itemKey(m));
      if (!e) { itemStatus.set(m.id, 'only'); itemsOnly++; }
      else if (Number(m.qty) === Number(e.qty)) { itemStatus.set(m.id, 'matched'); matched++; }
      else { itemStatus.set(m.id, 'mismatch'); mismatch++; }
    });

    state.extracted.forEach(e => {
      const m = itemsByKey.get(itemKey(e));
      if (!m) { extractedStatus.set(e.id, 'only'); extractedOnly++; }
      else if (Number(m.qty) === Number(e.qty)) { extractedStatus.set(e.id, 'matched'); }
      else { extractedStatus.set(e.id, 'mismatch'); }
    });

    return { matched, mismatch, itemsOnly, extractedOnly, itemStatus, extractedStatus };
  }

  function renderSummary(cmp) {
    el('lsMatched').textContent = cmp.matched;
    el('lsMismatch').textContent = cmp.mismatch;
    el('lsOnly').textContent = cmp.itemsOnly;
    el('lsExtractedOnly').textContent = cmp.extractedOnly;
  }

  function renderItems(itemStatus) {
    const wrap = el('tableWrap'), empty = el('emptyState'), summaryBar = el('summaryBar');

    if (!state.activeLineId) {
      wrap.style.display = 'none'; empty.style.display = 'flex'; summaryBar.style.display = 'none';
      return;
    }
    wrap.style.display = 'block'; empty.style.display = 'none'; summaryBar.style.display = 'flex';

    const rowClass = { mismatch: 'row-mismatch', only: 'row-manual-only' };
    const tbody = el('tbody');
    tbody.innerHTML = state.items.map((item, i) => `
      <tr class="${rowClass[itemStatus.get(item.id)] || ''}">
        <td style="color:var(--text-faint);font-family:var(--font-mono);font-size:10px">${String(i + 1).padStart(2, '0')}</td>
        <td>
          <div style="font-size:12px;color:var(--text-primary)">${item.desc}</div>
          ${item.rem ? `<div style="font-size:10px;color:var(--text-faint);margin-top:2px">${item.rem}</div>` : ''}
        </td>
        <td class="td-tag">${item.size}</td>
        <td><span class="badge badge-muted">${item.spec}</span></td>
        <td style="color:var(--text-secondary);font-size:11px">${item.sch}</td>
        <td style="color:var(--text-secondary);font-size:11px">${item.unit}</td>
        <td class="td-num">
          <input class="inline-input" type="text" value="${item.qty}" data-item-id="${item.id}" onfocus="this.select()"/>
        </td>
        <td class="td-acts">
          <div class="tool-btn" data-copy-id="${item.id}" title="Duplicate"><i class="ti ti-copy"></i></div>
          <div class="tool-btn" data-delete-id="${item.id}" title="Delete" style="color:var(--color-danger)"><i class="ti ti-trash"></i></div>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.inline-input').forEach(inp => {
      inp.addEventListener('change', () => updateQty(Number(inp.dataset.itemId), inp.value));
    });
    tbody.querySelectorAll('[data-copy-id]').forEach(btn => {
      btn.addEventListener('click', () => copyItem(Number(btn.dataset.copyId)));
    });
    tbody.querySelectorAll('[data-delete-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteItem(Number(btn.dataset.deleteId)));
    });

    const pipes = state.items.filter(x => x.cat === 'Pipe');
    const fittings = state.items.filter(x => ['Elbow', 'Tee', 'Reducer', 'Cap'].includes(x.cat));
    const valves = state.items.filter(x => x.cat === 'Valve');
    const pipeLen = pipes.reduce((s, p) => s + (parseFloat(p.qty) || 0), 0);

    el('sumItems').textContent = state.items.length;
    el('sumPipe').textContent = pipeLen.toFixed(1) + ' m';
    el('sumFit').textContent = fittings.reduce((s, x) => s + (parseInt(x.qty) || 0), 0);
    el('sumValves').textContent = valves.reduce((s, x) => s + (parseInt(x.qty) || 0), 0);
    el('itemCountBadge').textContent = state.items.length + ' items';
  }

  function renderExtracted(extractedStatus) {
    const wrap = el('extractedTableWrap'), empty = el('extractedEmptyState');

    if (!state.activeLineId) {
      wrap.style.display = 'none'; empty.style.display = 'flex';
      empty.querySelector('.empty-msg').textContent = 'No extraction available';
      empty.querySelector('.empty-sub').textContent = 'Select a line to view its Smart P&ID extracted quantities';
      el('extractedCountBadge').textContent = '0 items';
      return;
    }
    if (!state.extracted.length) {
      wrap.style.display = 'none'; empty.style.display = 'flex';
      empty.querySelector('.empty-msg').textContent = 'No extraction available';
      empty.querySelector('.empty-sub').textContent = 'This line has no Smart P&ID extraction yet';
      el('extractedCountBadge').textContent = '0 items';
      return;
    }

    wrap.style.display = 'block'; empty.style.display = 'none';
    const rowClass = { mismatch: 'row-mismatch', only: 'row-extracted-only' };
    const tbody = el('extractedTbody');
    tbody.innerHTML = state.extracted.map((item, i) => `
      <tr class="${rowClass[extractedStatus.get(item.id)] || ''}">
        <td style="color:var(--text-faint);font-family:var(--font-mono);font-size:10px">${String(i + 1).padStart(2, '0')}</td>
        <td style="font-size:12px;color:var(--text-primary)">${item.desc}</td>
        <td class="td-tag">${item.size}</td>
        <td><span class="badge badge-muted">${item.spec}</span></td>
        <td style="color:var(--text-secondary);font-size:11px">${item.sch}</td>
        <td style="color:var(--text-secondary);font-size:11px">${item.unit}</td>
        <td class="td-num">${item.qty}</td>
      </tr>
    `).join('');
    el('extractedCountBadge').textContent = state.extracted.length + ' items';
  }

  function refresh() {
    const cmp = computeComparison();
    renderSummary(cmp);
    renderItems(cmp.itemStatus);
    renderExtracted(cmp.extractedStatus);
  }

  async function updateQty(id, val) {
    const qty = isNaN(parseFloat(val)) ? val : parseFloat(val);
    try {
      const updated = await cfg.api.updateQty(id, qty);
      const item = state.items.find(x => x.id === id);
      if (item) item.qty = updated.qty;
      markUnsaved(); refresh();
    } catch (err) {
      showToast('error', 'Could not update quantity', err.message);
      refresh();
    }
  }

  async function deleteItem(id) {
    try {
      await cfg.api.deleteItem(id);
      state.items = state.items.filter(x => x.id !== id);
      markUnsaved(); refresh();
      showToast('info', 'Item removed', 'List updated');
    } catch (err) {
      showToast('error', 'Could not remove item', err.message);
    }
  }

  async function copyItem(id) {
    const item = state.items.find(x => x.id === id);
    if (!item) return;
    try {
      const copy = await cfg.api.addItem(state.activeLineId, {
        cat: item.cat, desc: item.desc, size: item.size, spec: item.spec,
        sch: item.sch, unit: item.unit, qty: item.qty, rem: item.rem,
      });
      const idx = state.items.findIndex(x => x.id === id);
      state.items.splice(idx + 1, 0, copy);
      markUnsaved(); refresh();
      showToast('success', 'Item duplicated', 'Edit quantity as needed');
    } catch (err) {
      showToast('error', 'Could not duplicate item', err.message);
    }
  }

  async function addNewItem(fields) {
    const item = await cfg.api.addItem(state.activeLineId, fields);
    state.items.push(item);
    markUnsaved(); refresh();
    return item;
  }

  function markUnsaved() {
    el('unsavedBadge').style.display = 'inline-flex';
    el('savedBadge').style.display = 'none';
  }
  function markSaved() {
    el('unsavedBadge').style.display = 'none';
    el('savedBadge').style.display = 'inline-flex';
  }

  async function save() {
    if (!state.activeLineId) { showToast('error', 'No line selected', ''); return; }

    if (!cfg.drivesShared) {
      // No separate "dump status" field on the line yet — just acknowledge locally.
      markSaved();
      showToast('success', 'Saved', 'Dump check items saved');
      return;
    }

    const line = allLines.find(x => x.id === state.activeLineId);
    if (!line) return;
    const items = state.items.length;
    const status = items ? (line.status === 'complete' ? 'complete' : 'inprogress') : 'pending';
    try {
      const updated = await DataStore.setLineStatus(line.id, status, items);
      line.items = updated.items;
      line.status = updated.status;
      markSaved(); renderSummaryTable(document.getElementById('summarySearch').value);
      showToast('success', 'Saved', 'MTO saved successfully');
    } catch (err) {
      showToast('error', 'Could not save', err.message);
    }
  }

  async function openPidViewer() {
    if (!state.activeLineId) { showToast('error', 'No line selected', 'Select a line first'); return; }
    try {
      const doc = await DataStore.getPidDocumentForLine(state.activeLineId);
      window.open(
        `pid-viewer.html?doc=${doc.masterIndexId}&line=${state.activeLineId}`,
        'ipmcs_pid_viewer_' + cfg.key, 'width=1100,height=800'
      );
    } catch (err) {
      showToast('error', 'No P&ID available for this line', err.message);
    }
  }

  function exportItems() {
    if (!state.activeLineId) { showToast('error', 'No line selected', ''); return; }
    showToast('info', 'Export placeholder', 'CSV export will be added later');
  }

  el('service').addEventListener('change', onServiceChange);
  el('seq').addEventListener('change', onSeqChange);
  el('zone').addEventListener('change', onZoneChange);
  el('addItemBtn').addEventListener('click', () => openAddModal(controller));
  el('uploadBtn').addEventListener('click', () => openUploadModal(controller));
  el('openPidBtn').addEventListener('click', openPidViewer);
  el('exportBtn').addEventListener('click', exportItems);
  el('saveBtn').addEventListener('click', save);

  const controller = {
    key: cfg.key,
    onlyLabel: cfg.onlyLabel,
    get activeLineId() { return state.activeLineId; },
    populateServices, selectLine, addNewItem,
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
