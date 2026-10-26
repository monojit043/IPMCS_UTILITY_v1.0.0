const HttpError = require('../middlewares/HttpError');
const foldersService = require('../services/pidFolders.service');
const pimsPid = require('../services/pimsPid.service');
const folderFiles = require('../services/folderFiles.service');

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
  // each P&ID at its revision current NOW, with its PDF read from ePULSE
  const sel = await foldersService.getSelections(folder.id);
  const docs = await Promise.all(sel.map(async (s) => {
    const doc = await pimsPid.getCurrentDocument(s.masterIndexId);
    return { s, doc, pdf: doc ? folderFiles.readRevisionPdf(doc) : null };
  }));
  const bad = docs.filter((d) => !d.doc || !d.pdf);
  if (bad.length) {
    throw new HttpError(409, `Can't freeze — no current PDF in ePULSE for: ${bad.map((d) => (d.doc ? d.doc.pidName : `P&ID #${d.s.masterIndexId}`)).join(', ')}`);
  }
  if (!(await foldersService.freeze(folder.id, req.user.empId, docs))) throw new HttpError(409, 'This folder was frozen meanwhile');
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

// Open folder: each selected P&ID at its CURRENT ePULSE revision (what Freeze
// will copy). Frozen folder: its own copies kept in IPMCS (fileId), with
// newerRev set when ePULSE has a newer revision since (for the next folder).
async function listDocuments(req, res) {
  const folder = await ownFolder(req);
  if (folder.status === 'frozen') {
    const files = await folderFiles.listFiles(folder.id);
    const out = await Promise.all(files.map(async (f) => {
      const d = await pimsPid.getRevision(f.documentId);
      return { ...f, uploadedBy: d && d.uploadedBy, uploadedAt: d && d.uploadedAt, newerRev: await foldersService.newerRevision(f.masterIndexId, f.documentId) };
    }));
    return res.json(out);
  }
  const sel = await foldersService.getSelections(folder.id);
  const docs = await Promise.all(sel.map((s) => pimsPid.getCurrentDocument(s.masterIndexId)));
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
