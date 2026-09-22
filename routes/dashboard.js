'use strict';

const express = require('express');
const { buildDashboardData } = require('../src/dashboardData');
const { getAthleteOptions } = require('../src/athletes');
const { addDaysIso, todayIso } = require('../src/dateUtils');
const { fetchIntervalsEvents } = require('../src/intervalsApi');
const { prepareActivities, collectZoneIds, normalizeZoneTimes } = require('../src/calculations');
const { rowsToCsv } = require('../src/csvExport');

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

function zoneMinutes(activity, field, id) {
  const z = normalizeZoneTimes(activity[field]).find((zz) => zz.id === id);
  return z ? Math.round(z.secs / 60) : '';
}

function zoneColumns(activities, field, label) {
  return collectZoneIds(activities, field).map((id) => ({
    header: `Temps zone ${label} ${id} (min)`,
    value: (a) => zoneMinutes(a, field, id),
  }));
}

// icu_hr_zones/pace/... exposent une vitesse en m/s sous le nom "pace" (et "gap" pour l'allure
// ajustée au dénivelé) : converties ici en minutes/km, plus lisibles pour une analyse.
function paceMinPerKm(speedMs) {
  const s = Number(speedMs);
  if (!(s > 0)) return '';
  return (1000 / (s * 60)).toFixed(2);
}

router.get('/api/dashboard/export-csv', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const athleteId = req.query.athleteId || '0';
    const historyStart = req.query.historyStart || addDaysIso(todayIso(), -180);
    const historyEnd = todayIso();

    const raw = await fetchIntervalsEvents(apiKey, historyStart, historyEnd, athleteId);
    const activities = prepareActivities(raw);

    const baseColumns = [
      { header: 'Date', key: 'date' },
      { header: 'Nom', key: 'name' },
      { header: 'Type', key: 'type' },
      { header: 'Durée (min)', value: (a) => Math.round((a.moving_time || 0) / 60) },
      { header: 'Durée totale (min)', value: (a) => Math.round((a.elapsed_time || 0) / 60) },
      { header: 'Temps arrêté (min)', value: (a) => Math.round(((a.elapsed_time || 0) - (a.moving_time || 0)) / 60) },
      { header: 'Distance (km)', value: (a) => (a.distance ? (a.distance / 1000).toFixed(2) : '') },
      { header: 'Dénivelé + (m)', key: 'total_elevation_gain' },
      { header: 'Dénivelé - (m)', value: (a) => Math.round(a.total_elevation_loss || 0) },
      { header: 'Vitesse moyenne (km/h)', value: (a) => (a.average_speed ? (a.average_speed * 3.6).toFixed(2) : '') },
      { header: 'Allure moyenne (min/km)', value: (a) => paceMinPerKm(a.average_speed) },
      { header: 'Allure GAP (min/km)', value: (a) => paceMinPerKm(a.gap) },
      { header: 'Cadence moyenne', value: (a) => (a.average_cadence ? Math.round(a.average_cadence) : '') },
      { header: 'RPE', key: 'icu_rpe' },
      { header: 'Ressenti (feel)', key: 'feel' },
      { header: 'Charge Foster', value: (a) => Math.round(a.foster_load || 0) },
      { header: 'Charge Intervals.icu', key: 'icu_training_load' },
      { header: 'Charge FC', key: 'hr_load' },
      { header: 'Charge Allure', key: 'pace_load' },
      { header: 'Charge Puissance', key: 'power_load' },
      { header: 'CTL (forme)', value: (a) => (a.icu_ctl != null ? a.icu_ctl.toFixed(1) : '') },
      { header: 'ATL (fatigue)', value: (a) => (a.icu_atl != null ? a.icu_atl.toFixed(1) : '') },
      { header: 'FC moyenne', key: 'average_heartrate' },
      { header: 'FC max', key: 'max_heartrate' },
      { header: 'FC repos', key: 'icu_resting_hr' },
      { header: 'FC seuil (LTHR)', key: 'lthr' },
      { header: 'Puissance moyenne (W)', key: 'icu_average_watts' },
      { header: 'Puissance normalisée (W)', key: 'icu_weighted_avg_watts' },
      { header: 'Intensité (%)', key: 'icu_intensity' },
      { header: "Facteur d'efficacité", value: (a) => (a.icu_efficiency_factor != null ? a.icu_efficiency_factor.toFixed(2) : '') },
      { header: 'Indice de variabilité', value: (a) => (a.icu_variability_index != null ? a.icu_variability_index.toFixed(2) : '') },
      { header: 'Découplage (%)', value: (a) => (a.decoupling != null ? a.decoupling.toFixed(1) : '') },
      { header: 'Calories', key: 'calories' },
      { header: 'Résumé intervalles', value: (a) => (Array.isArray(a.interval_summary) ? a.interval_summary.join(' ; ') : '') },
    ];

    const columns = [
      ...baseColumns,
      ...zoneColumns(activities, 'icu_hr_zone_times', 'FC'),
      ...zoneColumns(activities, 'icu_zone_times', 'Puissance'),
      ...zoneColumns(activities, 'pace_zone_times', 'Allure'),
    ];

    const csv = rowsToCsv(columns, activities);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="activites_${historyStart}_${historyEnd}.csv"`);
    res.send(`\uFEFF${csv}`);
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
