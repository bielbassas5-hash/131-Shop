// Administracion: un router por responsabilidad, todos bajo /admin.
const express = require('express');
const { adminHeaders } = require('../../middleware/auth');

const router = express.Router();
router.use('/admin', adminHeaders); // nunca en cache ni indexado

router.use(require('./auth'));
router.use(require('./dashboard'));
router.use(require('./products'));
router.use(require('./themes'));
router.use(require('./orders'));

module.exports = router;
