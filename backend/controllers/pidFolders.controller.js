const HttpError = require('../middlewares/HttpError');
const foldersService = require('../services/pidFolders.service');
const pimsPid = require('../services/pimsPid.service');

// Folders belong to one job + unit — the one being worked in (req.user.jobNo
// / unitNo, checked against the unit's team by middlewares/unit.js).
async function ownFolder(req) {
  const folder = await foldersService.getFolder(req.params.folderId);
  if (!folder || folder.jobNo !== req.user.jobNo || folder.unitNo !== req.user.unitNo) {
    throw new HttpError(404, 'Folder not found in this job / unit');
  }
  return folder;
}

// Job engineers work only in frozen folders — they don't see open ones
async function list(req, res) {
  const all = await foldersService.getAll(req.user.jobNo, req.user.unitNo);
  res.json(req.user.role === 'JE' ? all.filter((f) => f.status === 'frozen') : all);
}

function assertOpen(folder) {
  if (folder.status === 'frozen') {
    throw new HttpError(409, `MTO folder "${folder.name}" is frozen — its P&IDs can't change. Make a new folder for newer revisions.`);
  }
}

async function freeze(req, res) {
  const folder = await ownFolder(req);
  assertOpen(folder);
  if (!folder.documentCount) throw new HttpError(400, 'Add at least one P&ID before freezing the folder');
  await foldersService.freeze(folder.id, req.user.empId);
  const [out] = await foldersService.getAll(req.user.jobNo, req.user.unitNo).then((all) => all.filter((f) => f.id === folder.id));
  res.json(out);
}

async function create(req, res) {
  const name = (req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Folder name is required');
  if (name.length > 100) throw new HttpError(400, 'Folder name is too long (max 100)');
  const folder = await foldersService.create(req.user.jobNo, req.user.unitNo, name, req.user.empId);
  if (!folder) throw new HttpError(409, `This unit already has a folder named "${name}"`);
  res.status(201).json(folder);
}

// Each P&ID of the folder at its PINNED revision; newerRev is set when
// ePULSE has a newer revision since (it belongs in the next MTO folder).
async function listDocuments(req, res) {
  const folder = await ownFolder(req);
  const sel = await foldersService.getSelections(folder.id);
  const docs = await Promise.all(sel.map(async (s) => {
    const d = s.documentId ? await pimsPid.getRevision(s.documentId) : null;
    if (!d) return null;
    return { ...d, addedAt: s.addedAt, newerRev: d.isCurrent ? null : d.currentRevLabel };
  }));
  res.json(docs.filter(Boolean));
}

async function addSelection(req, res) {
  assertOpen(await ownFolder(req));
  const masterIndexId = Number(req.body.masterIndexId);
  if (!masterIndexId) throw new HttpError(400, 'masterIndexId is required');
  const doc = await pimsPid.getCurrentDocument(masterIndexId);
  if (!doc) throw new HttpError(404, 'No current document for that P&ID');
  if (doc.jobNo !== req.user.jobNo || doc.unitNo !== req.user.unitNo) {
    throw new HttpError(400, `${doc.pidName} belongs to ${doc.jobNo} / ${doc.unitNo}, not this unit`);
  }
  // pinned at today's current revision
  await foldersService.addSelection(req.params.folderId, masterIndexId, doc.documentId, doc.revLabel, req.user.empId);
  res.status(201).json(doc);
}

async function removeSelection(req, res) {
  assertOpen(await ownFolder(req));
  await foldersService.removeSelection(req.params.folderId, req.params.masterIndexId);
  res.status(204).end();
}

module.exports = { list, create, freeze, listDocuments, addSelection, removeSelection };
