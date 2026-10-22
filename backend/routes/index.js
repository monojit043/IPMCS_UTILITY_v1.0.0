const express = require('express');
const { requireAuth } = require('../middlewares/auth');

const authRoutes = require('./auth.routes');
const linesRoutes = require('./lines.routes');
const mtoItemsRoutes = require('./mtoItems.routes');
const dumpItemsRoutes = require('./dumpItems.routes');
const pidRoutes = require('./pid.routes');

const router = express.Router();

router.use('/auth', authRoutes);

// Everything below requires a valid login token.
router.use('/lines', requireAuth, linesRoutes);
router.use('/mto-items', requireAuth, mtoItemsRoutes);
router.use('/dump-items', requireAuth, dumpItemsRoutes);
router.use('/pid', requireAuth, pidRoutes);

module.exports = router;
