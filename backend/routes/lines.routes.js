const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const linesController = require('../controllers/lines.controller');
const mtoItemsController = require('../controllers/mtoItems.controller');
const dumpItemsController = require('../controllers/dumpItems.controller');
const extractedItemsController = require('../controllers/extractedItems.controller');

const router = express.Router();

// Cascading line-identity lookups — must come before "/:id" so "meta"/"lookup"
// aren't swallowed as an :id param.
router.get('/meta/services', asyncHandler(linesController.services));
router.get('/meta/sequences', asyncHandler(linesController.sequences));
router.get('/meta/sublines', asyncHandler(linesController.sublines));
router.get('/meta/zones', asyncHandler(linesController.zones));
router.get('/lookup', asyncHandler(linesController.lookup));

router.get('/', asyncHandler(linesController.list));
router.get('/:id', asyncHandler(linesController.getOne));
router.patch('/:id', asyncHandler(linesController.update));
router.put('/:id/cosmas', asyncHandler(linesController.updateCosmas));

router.get('/:lineId/mto-items', asyncHandler(mtoItemsController.listForLine));
router.post('/:lineId/mto-items', asyncHandler(mtoItemsController.create));

router.get('/:lineId/dump-items', asyncHandler(dumpItemsController.listForLine));
router.post('/:lineId/dump-items', asyncHandler(dumpItemsController.create));

router.get('/:lineId/extracted-items', asyncHandler(extractedItemsController.listForLine));

module.exports = router;
