// Is the drawing a line is on part of the MTO folder? MTO may be taken on
// any line (line list + latest P&IDs), but a line without its drawing in
// the folder has no frozen copy to highlight on — it is flagged everywhere.
//   in_folder     — one of its P&IDs is a copy in the folder
//   pdf_missing   — its P&ID is in the index but had no PDF when frozen
//   not_in_folder — its P&ID isn't in the folder (e.g. added to ePULSE after Freeze)
//   no_pid        — no P&ID no. known for the line
const LABEL = {
  in_folder: 'In folder',
  pdf_missing: 'PDF missing at freeze',
  not_in_folder: 'Not in folder',
  no_pid: 'No P&ID no.',
};

const match = (n, list) => list.find((p) => p === n || p.includes(n) || n.includes(p));

function drawingStatus(line, folder) {
  if (!line) return { status: 'no_pid', label: LABEL.no_pid, ok: false, pids: [] };
  const names = String(line.pidNo || '').split(',').map((s) => s.trim()).filter(Boolean);
  const inFolder = [...new Set(names.map((n) => match(n, folder.drawings.pidNames)).filter(Boolean))];
  const make = (status, pids) => ({ status, label: LABEL[status], ok: status === 'in_folder', pids });
  if (inFolder.length) return make('in_folder', inFolder);
  const missing = names.filter((n) => match(n, folder.missingPidNames || []));
  if (missing.length) return make('pdf_missing', missing);
  return names.length ? make('not_in_folder', names) : make('no_pid', []);
}

module.exports = { drawingStatus };
