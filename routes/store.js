const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const products = await db.all(
    'SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC'
  );
  res.render('index', { products });
});

router.get('/producto/:id', async (req, res) => {
  const product = await db.get(
    'SELECT * FROM products WHERE id = ? AND active = 1',
    [req.params.id]
  );
  if (!product) return res.status(404).render('404');
  res.render('product', { product });
});

module.exports = router;
