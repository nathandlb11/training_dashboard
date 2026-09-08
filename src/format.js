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

  return { fmtTime, fmtMinutes, fmtIntervalsDuration };
});
