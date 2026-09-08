'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

const dashboardRoutes = require('./routes/dashboard');
const planningRoutes = require('./routes/planning');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
// Expose les modules de calcul partagés (UMD) au navigateur (session builder, plan builder…)
app.use('/vendor', express.static(path.join(__dirname, 'src')));

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

app.get('/', (req, res) => res.redirect('/dashboard'));

app.use(dashboardRoutes);
app.use(planningRoutes);

app.use((req, res) => {
  res.status(404).send('Page introuvable.');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`Erreur serveur : ${err.message}`);
});

// Sur Vercel, le serveur est appelé comme handler serverless (api/index.js) :
// pas de app.listen() dans ce cas, il faut juste exporter `app`.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Training Load Dashboard — http://localhost:${PORT}`);
  });
}

module.exports = app;
