const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const c = require('../controllers/lines.controller');

const router = express.Router();

// Line selection + line data — read live from ePULSE, nothing saved
router.get('/meta/services', asyncHandler(c.services));
router.get('/meta/lsr', asyncHandler(c.lsrNos));
router.get('/meta/sublines', asyncHandler(c.sublines));
router.get('/meta/zones', asyncHandler(c.zones));
router.get('/data', asyncHandler(c.data));

module.exports = router;
