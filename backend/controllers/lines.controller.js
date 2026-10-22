const HttpError = require('../middlewares/HttpError');
const linesService = require('../services/lines.service');

async function list(req, res) {
  res.json(await linesService.getAllLines(req.user.jobNo, req.user.unitNo));
}

async function getOne(req, res) {
  const line = await linesService.getLineById(req.params.id);
  if (!line) throw new HttpError(404, 'Line not found');
  res.json(line);
}

async function update(req, res) {
  const { status, items } = req.body;
  const line = await linesService.updateLineStatus(req.params.id, status, items);
  if (!line) throw new HttpError(404, 'Line not found');
  res.json(line);
}

async function services(req, res) {
  res.json(await linesService.getServices(req.user.jobNo, req.user.unitNo));
}

async function sequences(req, res) {
  const { service } = req.query;
  if (!service) throw new HttpError(400, 'service is required');
  res.json(await linesService.getSequences(req.user.jobNo, req.user.unitNo, service));
}

async function zones(req, res) {
  const { service, seq } = req.query;
  if (!service || !seq) throw new HttpError(400, 'service and seq are required');
  res.json(await linesService.getZones(req.user.jobNo, req.user.unitNo, service, seq));
}

async function lookup(req, res) {
  const { service, seq, zone } = req.query;
  if (!service || !seq || !zone) {
    throw new HttpError(400, 'service, seq and zone are required');
  }
  const line = await linesService.resolveLine(req.user.jobNo, req.user.unitNo, service, seq, zone);
  if (!line) throw new HttpError(404, 'No line matches that Service / Sequence / Zone combination');
  res.json(line);
}

module.exports = { list, getOne, update, services, sequences, zones, lookup };
