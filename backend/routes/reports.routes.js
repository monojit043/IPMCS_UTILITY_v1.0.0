const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const c = require('../controllers/reports.controller');

const router = express.Router();

router.get('/', c.list);
router.get('/:type', asyncHandler(c.download));

module.exports = router;
