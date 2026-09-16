'use strict';

const { prepareActivities, dailyLoad, dailyLoadBySport, calculateLoadMetrics, calculatePlanningTargets, calculateForecastAcwr, rpeForPlanned } = require('./src/calculations');
const { fmtTime, fmtMinutes, fmtIntervalsDuration } = require('./src/format');
const { weekStartMonday, todayIso, addDaysIso } = require('./src/dateUtils');

// -------------------- Données synthétiques --------------------
const raw = [];
const start = addDaysIso(todayIso(), -120);
for (let i = 0; i < 120; i++) {
  const date = addDaysIso(start, i);
  const isRun = i % 3 !== 0;
  raw.push({
    id: `a${i}`,
    start_date_local: `${date}T07:00:00`,
    type: isRun ? 'Run' : 'Ride',
    name: isRun ? 'Footing' : 'Sortie vélo',
    moving_time: isRun ? 3000 : 5400,
    icu_rpe: isRun ? 3 : 2,
    distance: isRun ? 8000 : 30000,
    total_elevation_gain: isRun ? 120 : 300,
    category: 'WORKOUT_DONE',
  });
}

const df = prepareActivities(raw);
console.log('activités préparées:', df.length);
console.assert(df.length === 120, 'toutes les activités doivent être conservées');
console.assert(df[0].foster_load === 2 * 5400 / 60, 'foster_load mal calculé'); // i=0 -> Ride (i%3===0)

const daily = dailyLoad(df);
console.log('jours couverts (daily_load):', daily.length);
console.assert(daily.length >= 120, 'daily_load doit couvrir toute la plage');
console.assert(daily.every((d) => 'load_7d' in d), 'load_7d manquant');

const bySport = dailyLoadBySport(df);
console.log('lignes daily_load_by_sport:', bySport.length);

const metrics = calculateLoadMetrics(df);
console.log('semaines (load metrics):', metrics.length);
console.log('dernière semaine:', JSON.stringify(metrics[metrics.length - 1]));

const planningTargets = calculatePlanningTargets(df);
console.log('planning targets:', JSON.stringify(planningTargets, null, 2).slice(0, 500));
console.assert(planningTargets && planningTargets.chronic > 0, 'chronic load doit être positive');

// Forecast : quelques séances planifiées la semaine prochaine
const futureDaily = [];
for (let i = 1; i <= 10; i++) {
  futureDaily.push({ date: addDaysIso(todayIso(), i), foster_load: 100 + i * 5 });
}
const forecast = calculateForecastAcwr(df, futureDaily);
console.log('semaines forecast:', forecast.length);
console.assert(forecast.some((w) => w.is_forecast), 'au moins une semaine forecast attendue');

console.log('rpeForPlanned Run "EF":', rpeForPlanned('Run', 'CAP — EF'));
console.log('rpeForPlanned Ride:', rpeForPlanned('Ride', 'Sortie'));

// -------------------- Format --------------------
console.log(fmtTime(3725), fmtMinutes(95), fmtIntervalsDuration(20.5));

console.log('\nOK — tous les tests manuels sont passés.');
