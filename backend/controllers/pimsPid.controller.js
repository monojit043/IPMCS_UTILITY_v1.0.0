const fs = require('fs');
const path = require('path');
const HttpError = require('../middlewares/HttpError');
const pimsPid = require('../services/pimsPid.service');
const linesService = require('../services/lines.service');

async function listAvailable(req, res) {
  res.json(await pimsPid.listAvailable(req.user.jobNo, req.user.unitNo));
}

async function getOne(req, res) {
  const doc = await pimsPid.getCurrentDocument(req.params.masterIndexId);
  if (!doc) throw new HttpError(404, 'Document not found');
  res.json(doc);
}

async function getForLine(req, res) {
  const line = await linesService.getLineById(req.params.lineId);
  if (!line) throw new HttpError(404, 'Line not found');
  const doc = await pimsPid.findForLine(line.jobNo, line.unitNo, line.service, line.seqNo);
  if (!doc) throw new HttpError(404, 'No P&ID found for this line');
  res.json(doc);
}

async function streamFile(req, res) {
  const doc = await pimsPid.getCurrentDocument(req.params.masterIndexId);
  if (!doc) throw new HttpError(404, 'Document not found');

  const root = process.env.PIMS_PID_FILES_ROOT;
  if (!root) throw new HttpError(500, 'PIMS_PID_FILES_ROOT is not configured');

  const fullPath = path.join(root, doc.filePath);
  if (!fullPath.startsWith(path.resolve(root))) throw new HttpError(400, 'Invalid file path');
  if (!fs.existsSync(fullPath)) throw new HttpError(404, 'P&ID file not found on disk');

  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(fullPath);
}

module.exports = { listAvailable, getOne, getForLine, streamFile };
