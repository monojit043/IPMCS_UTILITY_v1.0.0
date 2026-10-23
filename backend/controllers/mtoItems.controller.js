const HttpError = require('../middlewares/HttpError');
const mtoItemsService = require('../services/mtoItems.service');

async function listForLine(req, res) {
  res.json(await mtoItemsService.getItemsByLine(req.params.lineId));
}

async function create(req, res) {
  const item = await mtoItemsService.addItem(req.params.lineId, req.body);
  res.status(201).json(item);
}

async function update(req, res) {
  const item = await mtoItemsService.updateItem(req.params.id, req.body || {});
  if (!item) throw new HttpError(404, 'Item not found');
  res.json(item);
}

async function remove(req, res) {
  const ok = await mtoItemsService.deleteItem(req.params.id);
  if (!ok) throw new HttpError(404, 'Item not found');
  res.status(204).end();
}

module.exports = { listForLine, create, update, remove };
