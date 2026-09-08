'use strict';

const express = require('express');
const { createOrUpdateCalendarEvents, fetchWorkoutLibrary } = require('../src/intervalsApi');
const { getAthleteOptions } = require('../src/athletes');
const { getChronicLoad, getPlannedCalendar } = require('../src/planningData');
const { SESSION_LIBRARY } = require('../src/sessionLibrary');
const { generateAiWeekPlan } = require('../src/aiPlanner');
const { addDaysIso, todayIso } = require('../src/dateUtils');
const sessionLoadConfig = require('../src/sessionLoad.json');

const router = express.Router();

function getApiKey() {
  return process.env.INTERVALS_API_KEY || '';
}

router.get('/planning', async (req, res) => {
  const apiKey = getApiKey();

  if (!apiKey) {
    return res.render('planning', {
      apiKeyMissing: true,
      athletes: [],
      athleteId: '0',
      sessionLibrary: SESSION_LIBRARY,
      sessionLoadConfig,
      chronicData: null,
      calendar: [],
      calendarStart: todayIso(),
      calendarEnd: addDaysIso(todayIso(), 28),
      historyStart: addDaysIso(todayIso(), -180),
      historyEnd: todayIso(),
      error: null,
    });
  }

  const athleteId = req.query.athleteId || '0';
  const historyStart = req.query.historyStart || addDaysIso(todayIso(), -180);
  const historyEnd = req.query.historyEnd || todayIso();
  const calendarStart = req.query.calendarStart || todayIso();
  const calendarEnd = req.query.calendarEnd || addDaysIso(todayIso(), 28);

  let athletes = [];
  let chronicData = null;
  let calendar = [];
  let error = null;

  try {
    athletes = await getAthleteOptions(apiKey);
    chronicData = await getChronicLoad(apiKey, athleteId, historyStart, historyEnd);
    calendar = await getPlannedCalendar(apiKey, athleteId, calendarStart, calendarEnd);
  } catch (e) {
    error = e.message;
  }

  res.render('planning', {
    apiKeyMissing: false,
    athletes,
    athleteId,
    sessionLibrary: SESSION_LIBRARY,
    sessionLoadConfig,
    chronicData,
    calendar,
    calendarStart,
    calendarEnd,
    historyStart,
    historyEnd,
    error,
  });
});

router.get('/api/planning/calendar', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', start, end } = req.query;
    const calendar = await getPlannedCalendar(apiKey, athleteId, start, end);
    res.json({ calendar });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/planning/chronic', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', historyStart, historyEnd } = req.query;
    const chronicData = await getChronicLoad(apiKey, athleteId, historyStart, historyEnd);
    res.json({ chronicData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/planning/workouts', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0' } = req.query;
    const workouts = await fetchWorkoutLibrary(apiKey, athleteId);
    res.json({ workouts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/planning/send-bulk', express.json(), async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', events } = req.body;
    if (!events || !events.length) return res.status(400).json({ error: 'Aucune séance à envoyer.' });
    const result = await createOrUpdateCalendarEvents(apiKey, events, athleteId);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/planning/send', express.json(), async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', event } = req.body;
    if (!event || !event.confirmed) {
      return res.status(400).json({ error: "Confirmation requise avant l'envoi." });
    }
    const payload = { ...event };
    delete payload.confirmed;

    const result = await createOrUpdateCalendarEvents(apiKey, [payload], athleteId);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/planning/ai-week', express.json(), async (req, res) => {
  try {
    const { week, planningType, nRun, nBike, nStrength, chronicLoad, targetAcwr, constraints, comment, recentWeeks } = req.body;
    if (!week) return res.status(400).json({ error: 'Semaine manquante.' });

    const plan = await generateAiWeekPlan({
      weekStart: week,
      planningType,
      nRun,
      nBike,
      nStrength,
      chronicLoad,
      targetAcwr,
      constraints,
      comment,
      recentWeeks,
    });
    res.json({ plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
