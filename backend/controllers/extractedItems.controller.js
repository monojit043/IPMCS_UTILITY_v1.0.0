const extractedItemsService = require('../services/extractedItems.service');

async function listForLine(req, res) {
  res.json(await extractedItemsService.getItemsByLine(req.params.lineId));
}

module.exports = { listForLine };
