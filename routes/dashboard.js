'use strict';

const express = require('express');
const { buildDashboardData } = require('../src/dashboardData');
const { getAthleteOptions } = require('../src/athletes');
const { addDaysIso, todayIso } = require('../src/dateUtils');

const router = express.Router();

function getApiKey(req) {
  return process.env.INTERVALS_API_KEY || '';
}

// Protège les endpoints JSON publics (ex. widget iOS) via ?token=... si WIDGET_TOKEN est défini.
// Si la variable d'env n'est pas définie, aucun changement de comportement (pas d'auth, comme avant).
function requireWidgetToken(req, res, next) {
  const expected = process.env.WIDGET_TOKEN;
  if (!expected) return next();
  if (req.query.token === expected) return next();
  return res.status(401).json({ error: 'Token invalide ou manquant.' });
}

function parseQuery(req) {
  const today = todayIso();
  return {
    athleteId: req.query.athleteId || '0',
    historyStart: req.query.historyStart || addDaysIso(today, -180),
    // Toujours jusqu'à aujourd'hui / la dernière activité : non paramétrable par l'utilisateur.
    historyEnd: today,
    types: req.query.types ? String(req.query.types).split(',').filter(Boolean) : undefined,
    // Pas de paramètre utilisateur : fenêtre large pour couvrir automatiquement toutes les
    // semaines déjà planifiées sur Intervals.icu (le calcul en aval s'arrête de toute façon à la
    // dernière semaine réellement planifiée, voir calculateForecastAcwr).
    forecastWeeks: req.query.forecastWeeks ? Number(req.query.forecastWeeks) : 52,
  };
}

router.get('/dashboard', async (req, res) => {
  const apiKey = getApiKey(req);

  if (!apiKey) {
    return res.render('dashboard', {
      apiKeyMissing: true,
      athletes: [],
      params: parseQuery(req),
      bootstrapData: null,
      error: null,
    });
  }

  const params = parseQuery(req);

  let athletes = [];
  let data = null;
  let error = null;

  try {
    athletes = await getAthleteOptions(apiKey);
    data = await buildDashboardData({ apiKey, ...params });
  } catch (e) {
    error = e.message;
  }

  res.render('dashboard', {
    apiKeyMissing: false,
    athletes,
    params,
    bootstrapData: data,
    error,
    widgetToken: process.env.WIDGET_TOKEN || '',
  });
});

router.get('/api/dashboard-data', requireWidgetToken, async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const params = parseQuery(req);
    const data = await buildDashboardData({ apiKey, ...params });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/athletes', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const athletes = await getAthleteOptions(apiKey);
    res.json({ athletes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
