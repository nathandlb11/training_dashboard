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

  /** Formate une durée en secondes -> "1h 05min", "45min" ou "45s" si < 1 minute. */
  function fmtTime(seconds) {
    seconds = Math.round(seconds || 0);
    if (seconds < 60) return `${seconds}s`;
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

  /** Vrai si la ligne est une ligne de répétition de bloc qualité (ex: "4x" ou "Seuil 4x"). */
  function isRepeatLine(line) {
    return !!line && !line.startsWith('-') && /(\d+)\s*x$/i.test(line);
  }

  /** Vrai si la description contient un bloc d'intervalles (séance de qualité), par opposition à une
   * séance simple (EF, sortie longue...) sans répétition. */
  function hasRepeatBlock(description) {
    return String(description || '')
      .split('\n')
      .some((raw) => isRepeatLine(raw.trim()));
  }

  /** Remplace le nombre de répétitions dans la ligne de répétition d'une description Intervals.icu
   * (ex: "Seuil 4x" -> "Seuil 6x"), le reste de la description est inchangé. */
  function setDescriptionReps(description, reps) {
    const n = Math.max(1, Math.round(Number(reps) || 1));
    return String(description || '')
      .split('\n')
      .map((raw) => (isRepeatLine(raw.trim()) ? raw.replace(/(\d+)(\s*x)$/i, `${n}$2`) : raw))
      .join('\n');
  }

  /** Ajuste proportionnellement toutes les durées d'étape d'une description Intervals.icu pour que sa
   * durée totale (voir parseDescriptionDurationMinutes) se rapproche de `targetMinutes`. */
  function scaleDescriptionDuration(description, targetMinutes) {
    const current = parseDescriptionDurationMinutes(description);
    if (!(current > 0) || !(targetMinutes > 0)) return String(description || '');
    const factor = targetMinutes / current;
    return String(description || '')
      .split('\n')
      .map((raw) => {
        if (!raw.trim().startsWith('-')) return raw;
        const minutes = parseStepDurationMinutes(raw);
        const token = DURATION_TOKEN_RE.exec(raw);
        if (minutes == null || !token) return raw;
        return raw.slice(0, token.index) + fmtIntervalsDuration(minutes * factor) + raw.slice(token.index + token[0].length);
      })
      .join('\n');
  }

  /**
   * Décompose une description Intervals.icu (même grammaire que parseDescriptionDurationMinutes)
   * en une liste PLATE d'étapes ({label, durationMin, lowPct, highPct, zone}), un bloc de répétition
   * étant déplié en autant de copies successives de ses lignes "- " (ordre chronologique réel de la
   * séance) — sert au petit schéma d'intensité affiché à l'édition d'une séance planifiée.
   * lowPct/highPct sont `null` quand la ligne n'a pas de "<bas>-<haut>%" (ex: repos).
   */
  function parseDescriptionSteps(description) {
    const lines = String(description || '').split('\n');
    const steps = [];
    let repeatCount = null;
    // Les étapes d'un bloc sont accumulées puis, à la fermeture du bloc, la SÉQUENCE ENTIÈRE est
    // rejouée N fois (et non chaque ligne individuellement N fois) — sinon un bloc "2x travail/récup"
    // ressort comme travail,travail,récup,récup au lieu de travail,récup,travail,récup.
    let blockSteps = [];
    const flushBlock = () => {
      const times = repeatCount || 1;
      for (let i = 0; i < times; i++) {
        for (const s of blockSteps) steps.push({ ...s });
      }
      blockSteps = [];
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        flushBlock();
        repeatCount = null;
        continue;
      }
      if (isRepeatLine(line)) {
        flushBlock();
        repeatCount = Math.max(1, parseInt(line.match(/(\d+)\s*x$/i)[1], 10));
        continue;
      }
      if (!line.startsWith('-')) continue;
      const body = line.replace(/^-\s*/, '');
      const token = DURATION_TOKEN_RE.exec(body);
      const durationMin = parseStepDurationMinutes(body);
      if (!token || durationMin == null) continue;
      const label = body.slice(0, token.index).trim();
      const rest = body.slice(token.index + token[0].length).trim();
      const pctMatch = rest.match(/^(\d+)\s*-\s*(\d+)\s*%\s*(.*)$/);
      const step = pctMatch
        ? { label, durationMin, lowPct: parseInt(pctMatch[1], 10), highPct: parseInt(pctMatch[2], 10), zone: pctMatch[3].trim() }
        : { label, durationMin, lowPct: null, highPct: null, zone: rest };
      blockSteps.push(step);
    }
    flushBlock();
    return steps;
  }

  return {
    fmtTime,
    fmtMinutes,
    fmtIntervalsDuration,
    parseDescriptionDurationMinutes,
    parseDescriptionSteps,
    hasRepeatBlock,
    setDescriptionReps,
    scaleDescriptionDuration,
  };
});
