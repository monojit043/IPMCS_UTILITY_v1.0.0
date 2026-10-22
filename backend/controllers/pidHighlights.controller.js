const HttpError = require('../middlewares/HttpError');
const highlightsService = require('../services/pidHighlights.service');

function pageOf(req) {
  return Number(req.query.page) || 1;
}

async function getAll(req, res) {
  res.json(await highlightsService.getAllForDocument(req.params.id, pageOf(req)));
}

async function getMine(req, res) {
  res.json({ strokes: await highlightsService.getMine(req.params.id, pageOf(req), req.user.id) });
}

async function putMine(req, res) {
  const { strokes } = req.body;
  if (!Array.isArray(strokes)) throw new HttpError(400, 'strokes must be an array');
  const result = await highlightsService.upsertMine(req.params.id, pageOf(req), req.user.id, strokes);
  res.json({ strokes: result });
}

async function getZoneBreaks(req, res) {
  res.json(await highlightsService.getZoneBreaks(req.params.id, pageOf(req)));
}

module.exports = { getAll, getMine, putMine, getZoneBreaks };
