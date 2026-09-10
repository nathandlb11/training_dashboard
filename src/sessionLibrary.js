/**
 * Bibliothèque de séances (format Intervals.icu) et générateur de description.
 * Port fidèle du dashboard Streamlit. Module UMD : utilisable via require()
 * côté serveur, ou en <script> classique côté navigateur (window.SessionLibrary).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./format'));
  } else {
    root.SessionLibrary = factory(root.Format);
  }
})(typeof self !== 'undefined' ? self : this, function (Format) {
  'use strict';

  const fmtIntervalsDuration = Format.fmtIntervalsDuration;

  const SESSION_LIBRARY = {
    Run: {
      'EF / Footing': {
        structure: 'simple',
        label: 'Footing',
        zone_unit: 'LTHR',
        duration: 40,
        low: 75,
        high: 85,
        rpe: 3,
      },
      'Sortie longue': {
        structure: 'simple',
        label: 'Sortie longue',
        zone_unit: 'LTHR',
        duration: 90,
        low: 70,
        high: 80,
        rpe: 4,
      },
      Tempo: {
        structure: 'warmup_reps_cooldown',
        zone_unit: 'LTHR',
        warmup_duration: 15,
        warmup_low: 70,
        warmup_high: 80,
        reps: 1,
        work_duration: 20.0,
        work_low: 88,
        work_high: 92,
        rec_duration: 0.0,
        rec_low: 60,
        rec_high: 70,
        cooldown_duration: 10,
        cooldown_low: 70,
        cooldown_high: 80,
        rpe: 5,
      },
      Seuil: {
        structure: 'warmup_reps_cooldown',
        zone_unit: 'LTHR',
        warmup_duration: 15,
        warmup_low: 70,
        warmup_high: 80,
        reps: 3,
        work_duration: 8.0,
        work_low: 95,
        work_high: 100,
        rec_duration: 2.0,
        rec_low: 65,
        rec_high: 75,
        cooldown_duration: 10,
        cooldown_low: 70,
        cooldown_high: 80,
        rpe: 7,
      },
      VO2max: {
        structure: 'warmup_reps_cooldown',
        zone_unit: 'LTHR',
        warmup_duration: 20,
        warmup_low: 75,
        warmup_high: 84,
        reps: 5,
        work_duration: 2.0,
        work_low: 98,
        work_high: 102,
        rec_duration: 2.0,
        rec_low: 75,
        rec_high: 84,
        cooldown_duration: 13,
        cooldown_low: 75,
        cooldown_high: 84,
        rpe: 8,
      },
      'Sprint / Fractionné court': {
        structure: 'warmup_reps_cooldown',
        zone_unit: 'LTHR',
        warmup_duration: 20,
        warmup_low: 75,
        warmup_high: 84,
        reps: 8,
        work_duration: 0.5,
        work_low: 105,
        work_high: 115,
        rec_duration: 1.5,
        rec_low: 65,
        rec_high: 75,
        cooldown_duration: 10,
        cooldown_low: 70,
        cooldown_high: 80,
        rpe: 8,
      },
    },
    Ride: {
      'EF / Endurance': {
        structure: 'simple',
        label: '',
        zone_unit: 'FTP',
        duration: 60,
        low: 56,
        high: 75,
        rpe: 2,
      },
      'Sortie longue': {
        structure: 'simple',
        label: '',
        zone_unit: 'FTP',
        duration: 150,
        low: 56,
        high: 70,
        rpe: 3,
      },
      Tempo: {
        structure: 'warmup_reps_cooldown',
        zone_unit: 'FTP',
        warmup_duration: 15,
        warmup_low: 50,
        warmup_high: 60,
        reps: 1,
        work_duration: 40.0,
        work_low: 76,
        work_high: 90,
        rec_duration: 0.0,
        rec_low: 50,
        rec_high: 60,
        cooldown_duration: 10,
        cooldown_low: 50,
        cooldown_high: 60,
        rpe: 5,
      },
      'Seuil (SST)': {
        structure: 'warmup_reps_cooldown',
        zone_unit: 'FTP',
        warmup_duration: 15,
        warmup_low: 50,
        warmup_high: 60,
        reps: 3,
        work_duration: 12.0,
        work_low: 91,
        work_high: 100,
        rec_duration: 5.0,
        rec_low: 50,
        rec_high: 60,
        cooldown_duration: 10,
        cooldown_low: 50,
        cooldown_high: 60,
        rpe: 7,
      },
      VO2max: {
        structure: 'warmup_reps_cooldown',
        zone_unit: 'FTP',
        warmup_duration: 15,
        warmup_low: 50,
        warmup_high: 60,
        reps: 5,
        work_duration: 3.0,
        work_low: 106,
        work_high: 120,
        rec_duration: 3.0,
        rec_low: 50,
        rec_high: 60,
        cooldown_duration: 10,
        cooldown_low: 50,
        cooldown_high: 60,
        rpe: 9,
      },
    },
  };

  /**
   * Construit la description Intervals.icu et la durée totale (min)
   * à partir d'un template de séance (structure 'simple' ou
   * 'warmup_reps_cooldown').
   */
  function buildSessionDescription(template) {
    const unit = template.zone_unit;

    if (template.structure === 'simple') {
      const label = String(template.label || '').trim();
      const prefix = label ? `${label} ` : '';
      const line =
        `- ${prefix}${fmtIntervalsDuration(template.duration)} ` +
        `${Math.trunc(template.low)}-${Math.trunc(template.high)}% ${unit}`;
      return { description: line, durationMin: Number(template.duration) };
    }

    // structure "warmup_reps_cooldown"
    const reps = Math.max(1, Math.trunc(template.reps));

    const blocks = [
      [
        `- Echauffement ${fmtIntervalsDuration(template.warmup_duration)} ` +
          `${Math.trunc(template.warmup_low)}-${Math.trunc(template.warmup_high)}% ${unit}`,
      ],
    ];

    const mainBlock = [];
    if (reps > 1) mainBlock.push(`${reps}x`);
    mainBlock.push(
      `- ${fmtIntervalsDuration(template.work_duration)} ` +
        `${Math.trunc(template.work_low)}-${Math.trunc(template.work_high)}% ${unit}`
    );
    if (reps > 1 && template.rec_duration > 0) {
      mainBlock.push(
        `- ${fmtIntervalsDuration(template.rec_duration)} ` +
          `${Math.trunc(template.rec_low)}-${Math.trunc(template.rec_high)}% ${unit}`
      );
    }
    blocks.push(mainBlock);

    blocks.push([
      `- Retour au calme ${fmtIntervalsDuration(template.cooldown_duration)} ` +
        `${Math.trunc(template.cooldown_low)}-${Math.trunc(template.cooldown_high)}% ${unit}`,
    ]);

    const total =
      Number(template.warmup_duration) +
      reps * Number(template.work_duration) +
      (template.rec_duration > 0 ? reps : 0) * Number(template.rec_duration) +
      Number(template.cooldown_duration);

    // Blocs séparés par une ligne vide : une répétition "Nx" ne s'applique qu'aux lignes de SON bloc.
    return { description: blocks.map((b) => b.join('\n')).join('\n\n'), durationMin: total };
  }

  return { SESSION_LIBRARY, buildSessionDescription };
});
