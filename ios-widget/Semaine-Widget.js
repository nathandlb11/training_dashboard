// Widget iPhone Semaine — à ouvrir/coller dans l'app Scriptable (scriptable.app)
// Installation :
//  1. Renseigne BASE_URL, ATHLETE_ID, TOKEN ci-dessous (mêmes valeurs que ACWR-Widget.js / CAP-Widget.js).
//  2. Colle ce script dans un nouveau script Scriptable, nomme-le "Semaine Widget".
//  3. Écran d'accueil iPhone -> appui long -> "+" -> Scriptable -> taille petite/moyenne/grande
//     -> Modifier le widget -> Script = "Semaine Widget".
//
// Si WIDGET_TOKEN est défini côté serveur (.env), TOKEN doit avoir la même valeur.

const BASE_URL = "https://training-dashboard-intervals-icu-ten.vercel.app/";
const ATHLETE_ID = "i661521";
const TOKEN = "azhTgjfP0gT"; // laisser vide si WIDGET_TOKEN n'est pas configuré côté serveur

async function fetchDashboardData() {
  const base = BASE_URL.replace(/\/+$/, '');
  const url = `${base}/api/dashboard-data?athleteId=${encodeURIComponent(ATHLETE_ID)}&forecastWeeks=1${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`;
  const req = new Request(url);
  const data = await req.loadJSON();
  if (data.error) throw new Error(data.error);
  return data;
}

const DAY_ABBR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

function dayAbbrFr(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const idx = (date.getUTCDay() + 6) % 7; // 0 = lundi
  return DAY_ABBR[idx];
}

function formatDayFr(iso) {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

// Emoji par sport (mêmes conventions que public/js/planning.js SPORT_ICONS/TYPE_MAP), pour
// différencier les séances d'une même colonne/couleur de statut.
const SPORT_TYPE_MAP = { WeightTraining: 'Strength', TrailRun: 'Run', VirtualRide: 'Ride', GravelRide: 'Ride', MountainBikeRide: 'Ride', OpenWaterSwim: 'Swim' };
const SPORT_ICONS = { Run: "\uD83C\uDFC3", Ride: "\uD83D\uDEB4", Swim: "\uD83C\uDFCA", Strength: "\uD83C\uDFCB\uFE0F", Hike: "\uD83E\uDD7E", Walk: "\uD83D\uDEB6" };
function sportIcon(type) {
  const t = SPORT_TYPE_MAP[type] || type;
  return SPORT_ICONS[t] || "\uD83C\uDFBD";
}

// Icône + couleur selon l'état de la séance (réalisée / manquée / aujourd'hui / à venir / hors plan).
function statusStyle(status) {
  switch (status) {
    case 'done':
      return { icon: "✓", color: new Color("#35c46f") };
    case 'extra':
      return { icon: "+", color: new Color("#4a90d9") };
    case 'missed':
      return { icon: "✕", color: new Color("#ef5757") };
    case 'today':
      return { icon: "●", color: new Color("#f5a623") };
    default:
      return { icon: "○", color: new Color("#5a6480") };
  }
}

// Couleur du badge par jour/séance : vert réalisée, rouge manquée, orange aujourd'hui
// (non réalisée), gris pour les prochains jours. Le sport, lui, est différencié par l'emoji.
function statusColorHex(status) {
  switch (status) {
    case 'done':
    case 'extra':
      return "#35c46f";
    case 'missed':
      return "#ef5757";
    case 'today':
      return "#f5a623";
    default:
      return "#5a6480";
  }
}

// "1h 05min" -> "1h05'", "45min" -> "45'" : compact pour tenir dans une colonne étroite.
function shortDuration(t) {
  if (!t) return '';
  return t.replace(' ', '').replace('min', "'");
}

function addWeekColumns(w, days, today, width) {
  const gap = 3;
  const colWidth = (width - gap * 6) / 7;
  const row = w.addStack();
  row.layoutHorizontally();
  row.spacing = gap;

  days.forEach(([date, sessions]) => {
    const col = row.addStack();
    col.layoutVertically();
    col.size = new Size(colWidth, 0);
    col.centerAlignContent();

    const dayLabel = col.addText(dayAbbrFr(date));
    dayLabel.font = Font.mediumSystemFont(8);
    dayLabel.textColor = date === today ? new Color("#f5a623") : new Color("#9aa7c2");
    dayLabel.centerAlignText();
    col.addSpacer(2);

    if (!sessions.length) {
      const rest = col.addText("–");
      rest.font = Font.systemFont(10);
      rest.textColor = new Color("#4a5068");
      rest.centerAlignText();
    } else {
      sessions.forEach((s, i) => {
        if (i > 0) col.addSpacer(6);
        const badge = col.addStack();
        badge.size = new Size(15, 15);
        badge.backgroundColor = new Color(statusColorHex(s.status));
        badge.cornerRadius = 7.5;
        badge.centerAlignContent();
        const icon = badge.addText(sportIcon(s.type));
        icon.font = Font.systemFont(8);
        icon.centerAlignText();

        col.addSpacer(2);

        // Durée + charge sur une seule ligne compacte, sinon 2-3 séances dans une colonne
        // dépassent la hauteur du widget medium.
        const time = s.done ? s.realTime : s.plannedTime;
        const load = s.done ? s.realLoad : s.plannedLoad;
        const infoText = col.addText([shortDuration(time), load != null ? `${load}` : null].filter(Boolean).join(' · '));
        infoText.font = Font.systemFont(7);
        infoText.textColor = new Color("#8b96b3");
        infoText.centerAlignText();
      });
    }
  });
}

function groupByDay(sessions, weekStart) {
  const byDate = new Map();
  for (let i = 0; i < 7; i++) {
    const date = new Date(Date.UTC(...weekStart.split('-').map(Number)));
    date.setUTCDate(date.getUTCDate() + i);
    const iso = date.toISOString().slice(0, 10);
    byDate.set(iso, []);
  }
  for (const s of sessions) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function addProgressBar(w, ratio, width, height, color) {
  const stack = w.addStack();
  stack.size = new Size(width, height);
  stack.backgroundColor = new Color("#2a3142");
  stack.cornerRadius = height / 2;
  const fillWidth = Math.max(0, Math.min(width, width * ratio));
  if (fillWidth > 0) {
    const fill = stack.addStack();
    fill.size = new Size(fillWidth, height);
    fill.backgroundColor = color;
    fill.cornerRadius = height / 2;
  }
  return stack;
}

function addSessionRow(w, session, showName) {
  const row = w.addStack();
  row.centerAlignContent();
  row.spacing = 6;

  const style = statusStyle(session.status);
  const dayText = row.addText(dayAbbrFr(session.date));
  dayText.font = Font.mediumSystemFont(11);
  dayText.textColor = new Color("#9aa7c2");
  dayText.leftAlignText();

  const icon = row.addText(style.icon);
  icon.font = Font.boldSystemFont(11);
  icon.textColor = style.color;

  if (showName) {
    const name = row.addText(session.name || session.type || 'Séance');
    name.font = Font.systemFont(11);
    name.textColor = Color.white();
    name.lineLimit = 1;
    row.addSpacer();
  } else {
    row.addSpacer();
  }

  const load = session.done ? session.realLoad : session.plannedLoad;
  const loadText = row.addText(load != null ? `${load}` : "—");
  loadText.font = Font.systemFont(11);
  loadText.textColor = new Color("#6b7690");
}

async function createWidget() {
  const w = new ListWidget();
  w.backgroundColor = new Color("#151a24");
  w.setPadding(10, 12, 10, 12);

  try {
    const data = await fetchDashboardData();
    const cw = data.currentWeekSessions;
    const family = config.widgetFamily || 'medium';

    if (!cw || !cw.sessions) {
      const empty = w.addText("Aucune séance cette semaine.");
      empty.font = Font.systemFont(13);
      empty.textColor = Color.gray();
      return w;
    }

    const { totals } = cw;
    const ratio = totals.plannedLoad > 0 ? totals.realLoad / totals.plannedLoad : 0;

    const header = w.addStack();
    header.centerAlignContent();
    const title = header.addText("Semaine");
    title.font = Font.semiboldSystemFont(13);
    title.textColor = new Color("#9aa7c2");
    header.addSpacer();
    const count = header.addText(`${totals.doneCount}/${totals.plannedCount}`);
    count.font = Font.boldSystemFont(family === 'small' ? 16 : 20);
    count.textColor = ratio >= 1 ? new Color("#35c46f") : new Color("#f5a623");

    w.addSpacer(3);
    addProgressBar(w, ratio, family === 'small' ? 126 : family === 'large' ? 276 : 276, 6, new Color("#35c46f"));
    w.addSpacer(2);
    const loadCaption = w.addText(`Charge : ${totals.realLoad} / ${totals.plannedLoad}`);
    loadCaption.font = Font.systemFont(9);
    loadCaption.textColor = new Color("#6b7690");

    w.addSpacer(family === 'medium' ? 5 : 8);

    if (family === 'small') {
      // Espace restreint : uniquement les séances du jour même.
      const todaySessions = cw.sessions.filter((s) => s.date === cw.today);
      if (!todaySessions.length) {
        const rest = w.addText("Repos aujourd'hui");
        rest.font = Font.systemFont(11);
        rest.textColor = new Color("#6b7690");
      } else {
        todaySessions.forEach((s) => addSessionRow(w, s, true));
      }
    } else if (family === 'medium') {
      // Une colonne par jour (lundi -> dimanche), une pastille par séance du jour (2-3 possibles).
      const days = groupByDay(cw.sessions, cw.weekStart);
      addWeekColumns(w, days, cw.today, 276);
    } else {
      const days = groupByDay(cw.sessions, cw.weekStart);

      days.forEach(([date, sessions]) => {
        if (!sessions.length) {
          const row = w.addStack();
          row.centerAlignContent();
          const dayText = row.addText(`${dayAbbrFr(date)} ${formatDayFr(date)}`);
          dayText.font = Font.mediumSystemFont(11);
          dayText.textColor = new Color("#4a5068");
          row.addSpacer();
          const rest = row.addText("repos");
          rest.font = Font.systemFont(10);
          rest.textColor = new Color("#4a5068");
        } else {
          sessions.forEach((s) => addSessionRow(w, s, true));
        }
      });
    }
  } catch (e) {
    const err = w.addText(`Erreur: ${e.message}`);
    err.font = Font.systemFont(12);
    err.textColor = Color.red();
  }

  return w;
}

const widget = await createWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
