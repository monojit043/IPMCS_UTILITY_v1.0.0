const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const { applyUnit } = require('../middlewares/unit');

const authRoutes = require('./auth.routes');
const linesRoutes = require('./lines.routes');
const lineZonesRoutes = require('./lineZones.routes');
const pidRoutes = require('./pid.routes');

const router = express.Router();

router.use('/auth', authRoutes);

// Everything below requires a valid login token; X-Unit-No (checked
// against the user's PC-2 units) selects which unit is being worked in.
router.use('/lines', requireAuth, applyUnit, linesRoutes);
router.use('/line-zones', requireAuth, applyUnit, lineZonesRoutes);
router.use('/pid', requireAuth, applyUnit, pidRoutes);

module.exports = router;
