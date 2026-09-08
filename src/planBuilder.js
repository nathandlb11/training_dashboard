/**
 * Planificateur de semaine — port fidèle de build_training_plan (Streamlit).
 * Module UMD : utilisable via require() côté serveur, ou en <script>
 * classique côté navigateur (window.PlanBuilder).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./sessionLoad.json'));
  } else {
    root.PlanBuilder = factory(root.__PLANNING_BOOTSTRAP__ && root.__PLANNING_BOOTSTRAP__.sessionLoadConfig);
  }
})(typeof self !== 'undefined' ? self : this, function (sessionLoad) {
  'use strict';

  const cfg = (sessionLoad && sessionLoad.planBuilder) || {
    bike: { rpe: 2, durationMin: 75 },
    strength: { rpe: 5, durationMin: 30 },
    run: { ef: 3, quality: 7, longRun: 4, extraEf: 2 },
  };

  /**
   * Construit une semaine théorique.
   *
   * RPE utilisés : voir src/sessionLoad.json (clé "planBuilder").
   *
   * Foster = RPE × durée en minutes
   */
  function buildTrainingPlan({ chronicLoad, planningType, nRun, nBike, nStrength }) {
    const targetAcwr = planningType === 'Charge' ? 1.15 : 0.7;
    const targetLoad = chronicLoad * targetAcwr;

    const bikeRpe = cfg.bike.rpe;
    const bikeDuration = cfg.bike.durationMin;
    const strengthRpe = cfg.strength.rpe;
    const strengthDuration = cfg.strength.durationMin;

    const bikeLoad = nBike * bikeDuration * bikeRpe;
    const strengthLoad = nStrength * strengthDuration * strengthRpe;
    const fixedLoad = bikeLoad + strengthLoad;

    const runLoadTarget = Math.max(0, targetLoad - fixedLoad);

    const sessions = [];

    if (nRun > 0) {
      let runTypes;
      const { ef, quality, longRun, extraEf } = cfg.run;

      if (nRun === 1) {
        runTypes = [['CAP — sortie longue', 1.0, longRun]];
      } else if (nRun === 2) {
        runTypes = [
          ['CAP — EF', 0.4, ef],
          ['CAP — sortie longue', 0.6, longRun],
        ];
      } else if (nRun === 3) {
        runTypes = [
          ['CAP — EF', 0.2, ef],
          ['CAP — qualité', 0.4, quality],
          ['CAP — sortie longue', 0.4, longRun],
        ];
      } else if (nRun === 4) {
        runTypes = [
          ['CAP — EF', 0.15, ef],
          ['CAP — EF', 0.15, ef],
          ['CAP — qualité', 0.3, quality],
          ['CAP — sortie longue', 0.4, longRun],
        ];
      } else {
        runTypes = [
          ['CAP — EF', 0.1, ef],
          ['CAP — EF', 0.1, ef],
          ['CAP — qualité', 0.3, quality],
          ['CAP — EF', 0.1, ef],
          ['CAP — sortie longue', 0.4, longRun],
        ];

        // Pour >5 CAP, on ajoute des EF (avant la dernière séance = sortie longue)
        while (runTypes.length < nRun) {
          runTypes.splice(runTypes.length - 1, 0, ['CAP — EF', 0.1, extraEf]);
        }

        const totalWeight = runTypes.reduce((s, r) => s + r[1], 0);
        runTypes = runTypes.map(([name, weight, rpe]) => [name, weight / totalWeight, rpe]);
      }

      for (const [name, weight, rpe] of runTypes) {
        const sessionLoad = runLoadTarget * weight;
        const duration = rpe > 0 ? sessionLoad / rpe : 0;
        sessions.push({
          sport: 'CAP',
          seance: name,
          dureeMin: duration,
          rpe,
          chargeFoster: sessionLoad,
        });
      }
    }

    for (let i = 0; i < nBike; i++) {
      sessions.push({
        sport: 'Vélo',
        seance: `Vélo — endurance ${i + 1}`,
        dureeMin: bikeDuration,
        rpe: bikeRpe,
        chargeFoster: bikeDuration * bikeRpe,
      });
    }

    for (let i = 0; i < nStrength; i++) {
      sessions.push({
        sport: 'Muscu',
        seance: `Musculation ${i + 1}`,
        dureeMin: strengthDuration,
        rpe: strengthRpe,
        chargeFoster: strengthDuration * strengthRpe,
      });
    }

    for (const s of sessions) {
      s.dureeMin = Math.round(s.dureeMin);
      s.chargeFoster = Math.round(s.chargeFoster);
    }

    return { sessions, targetLoad };
  }

  return { buildTrainingPlan };
});
