/**
 * Utilitaires de formatage de durées. Module UMD : utilisable via require()
 * côté serveur, ou en <script> classique côté navigateur (window.Format).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Format = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Formate une durée en secondes -> "1h 05min" ou "45min". */
  function fmtTime(seconds) {
    seconds = Math.round(seconds || 0);
    const h = Math.floor(seconds / 3600);
    const rem = seconds % 3600;
    const m = Math.floor(rem / 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}min` : `${m}min`;
  }

  /** Formate une durée en minutes -> "1h 05min" ou "45min". */
  function fmtMinutes(minutes) {
    minutes = Math.round(minutes || 0);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}min` : `${m}min`;
  }

  /** Formate une durée en minutes au format Intervals.icu (ex: 1h, 20m, 30s). */
  function fmtIntervalsDuration(minutes) {
    minutes = Number(minutes || 0);
    const totalSeconds = Math.round(minutes * 60);

    const h = Math.floor(totalSeconds / 3600);
    const rem = totalSeconds % 3600;
    const m = Math.floor(rem / 60);
    const s = rem % 60;

    const parts = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (s && !h) parts.push(`${s}s`);
    if (!parts.length) parts.push('0m');

    return parts.join('');
  }

  // Reconnaît un jeton de durée du type "1h20m", "15m", "20min", "30s" (utilisé par une étape de
  // description Intervals.icu) — h/min/s peuvent être combinés, avec ou sans espace.
  const DURATION_TOKEN_RE =
    /(\d+)\s*h(?:e(?:ure)?s?)?(?:\s*(\d+)\s*m(?:in(?:ute)?s?)?)?(?:\s*(\d+)\s*s(?:ec(?:onde)?s?)?)?|(\d+)\s*m(?:in(?:ute)?s?)?(?:\s*(\d+)\s*s(?:ec(?:onde)?s?)?)?|(\d+)\s*s(?:ec(?:onde)?s?)?/i;

  /** Extrait la durée (en minutes) du premier jeton temporel trouvé dans une ligne, ou null si aucun. */
  function parseStepDurationMinutes(line) {
    const m = DURATION_TOKEN_RE.exec(line);
    if (!m) return null;
    if (m[1] != null) return parseInt(m[1], 10) * 60 + parseInt(m[2] || '0', 10) + parseInt(m[3] || '0', 10) / 60;
    if (m[4] != null) return parseInt(m[4], 10) + parseInt(m[5] || '0', 10) / 60;
    if (m[6] != null) return parseInt(m[6], 10) / 60;
    return null;
  }

  /**
   * Calcule la durée totale (en minutes) d'une description au format Intervals.icu strict utilisé
   * par cette appli : des lignes "- <libellé> <durée> <bas>-<haut>% <ZONE>", regroupées en blocs
   * séparés par une ligne vide. Un bloc peut commencer par une ligne de répétition (ex. "4x" ou
   * "Seuil 4x") : toutes les lignes "- " de CE bloc sont alors comptées N fois. Une ligne vide
   * referme le bloc de répétition.
   */
  function parseDescriptionDurationMinutes(description) {
    const lines = String(description || '').split('\n');
    let total = 0;
    let repeatCount = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        repeatCount = null;
        continue;
      }
      const repeatMatch = !line.startsWith('-') && line.match(/(\d+)\s*x$/i);
      if (repeatMatch) {
        repeatCount = Math.max(1, parseInt(repeatMatch[1], 10));
        continue;
      }
      if (!line.startsWith('-')) continue;
      const stepMin = parseStepDurationMinutes(line);
      if (stepMin == null) continue;
      total += stepMin * (repeatCount || 1);
    }
    return Math.round(total);
  }

  return { fmtTime, fmtMinutes, fmtIntervalsDuration, parseDescriptionDurationMinutes };
});
