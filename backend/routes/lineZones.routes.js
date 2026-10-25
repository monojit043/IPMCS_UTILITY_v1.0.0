const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const c = require('../controllers/lines.controller');

const router = express.Router();

// What engineers save: one line + zone with its COSMAS header and BoM rows
router.get('/', asyncHandler(c.listZones));
router.put('/', asyncHandler(c.saveZone));
router.get('/:id', asyncHandler(c.getZone));
router.get('/:id/revisions', asyncHandler(c.listRevisions));
router.get('/:id/revisions/:rev', asyncHandler(c.getRevision));

module.exports = router;
