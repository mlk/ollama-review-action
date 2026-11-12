const express = require('express');
const app = express();

const db = require('../db');

app.get('/items', async (req, res) => {
  const rows = await db.query('SELECT * FROM items WHERE owner = ?', [req.query.owner]);
  res.json(rows);
});

module.exports = app;
