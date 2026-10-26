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
  // every P&ID of the unit's index, each at its revision current NOW
  const { docs, missing } = await folderFiles.gatherAll(req.user.jobNo, req.user.unitNo);
  if (!docs.length) throw new HttpError(400, 'No P&ID of this unit has a PDF in ePULSE yet — nothing to freeze');
  if (!(await foldersService.freeze(folder.id, req.user.empId, docs, missing))) throw new HttpError(409, 'This folder was frozen meanwhile');
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

// Open folder: a preview of what Freeze will take — every P&ID of the
// unit's index at its CURRENT ePULSE revision (missing: true when it has no
// PDF). Frozen folder: its own copies kept in IPMCS (fileId) with newerRev
// when ePULSE has a newer revision since, plus the P&IDs that had no PDF.
async function listDocuments(req, res) {
  const folder = await ownFolder(req);
  if (folder.status === 'frozen') {
    const [files, missing] = await Promise.all([folderFiles.listFiles(folder.id), folderFiles.listMissing(folder.id)]);
    const out = await Promise.all(files.map(async (f) => {
      const d = await pimsPid.getRevision(f.documentId);
      return { ...f, uploadedBy: d && d.uploadedBy, uploadedAt: d && d.uploadedAt, newerRev: await foldersService.newerRevision(f.masterIndexId, f.documentId) };
    }));
    return res.json([...out, ...missing.map((m) => ({ ...m, missing: true }))]);
  }
  const index = await pimsPid.listIndex(req.user.jobNo, req.user.unitNo);
  res.json(index.map((e) => (e.documentId ? e : { ...e, missing: true, reason: 'No PDF uploaded' })));
}



module.exports = { list, create, freeze, listDocuments };
