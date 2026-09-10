// Widget iPhone CAP (km / D+ / heures) — à ouvrir/coller dans l'app Scriptable (scriptable.app)
// Installation :
//  1. Renseigne BASE_URL, ATHLETE_ID, TOKEN ci-dessous (mêmes valeurs que ACWR-Widget.js).
//  2. Colle ce script dans un nouveau script Scriptable, nomme-le "CAP Widget".
//  3. Écran d'accueil iPhone -> appui long -> "+" -> Scriptable -> taille petite/moyenne/grande
//     -> Modifier le widget -> Script = "CAP Widget".
//
// Si WIDGET_TOKEN est défini côté serveur (.env), TOKEN doit avoir la même valeur.

const BASE_URL = "https://training-dashboard-intervals-icu-ten.vercel.app/";
const ATHLETE_ID = "i661521";
const TOKEN = "azhTgjfP0gT"; // laisser vide si WIDGET_TOKEN n'est pas configuré côté serveur

async function fetchDashboardData() {
  const base = BASE_URL.replace(/\/+$/, '');
  const url = `${base}/api/dashboard-data?athleteId=${encodeURIComponent(ATHLETE_ID)}&forecastWeeks=4${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`;
  const req = new Request(url);
  const data = await req.loadJSON();
  if (data.error) throw new Error(data.error);
  return data;
}

function formatWeekFr(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}`;
}

// ------------------------------------------------------------
// Helpers de dessin (mêmes couleurs/logique que public/js/dashboard.js renderCapChart)
// ------------------------------------------------------------
function makeXScale(weeks, x0, x1) {
  const n = weeks.length;
  return (week) => {
    const idx = weeks.indexOf(week);
    if (idx === -1) return null;
    if (n <= 1) return (x0 + x1) / 2;
    return x0 + (idx / (n - 1)) * (x1 - x0);
  };
}

function makeYScale(min, max, yTop, yBottom) {
  const span = max - min || 1;
  return (v) => yBottom - ((v - min) / span) * (yBottom - yTop);
}

function strokePolyline(dc, pts, color, width) {
  if (pts.length < 2) return;
  dc.setStrokeColor(color);
  dc.setLineWidth(width);
  const path = new Path();
  path.move(pts[0]);
  for (let i = 1; i < pts.length; i++) path.addLine(pts[i]);
  dc.addPath(path);
  dc.strokePath();
}

function strokeDashedPolyline(dc, pts, color, width, dash = 6, gap = 4) {
  if (pts.length < 2) return;
  dc.setStrokeColor(color);
  dc.setLineWidth(width);
  const path = new Path();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const ux = dx / len;
    const uy = dy / len;
    let d = 0;
    let drawing = true;
    while (d < len) {
      const segLen = Math.min(drawing ? dash : gap, len - d);
      if (drawing) {
        path.move(new Point(a.x + ux * d, a.y + uy * d));
        path.addLine(new Point(a.x + ux * (d + segLen), a.y + uy * (d + segLen)));
      }
      d += segLen;
      drawing = !drawing;
    }
  }
  dc.addPath(path);
  dc.strokePath();
}

function fillCircle(dc, p, r, color) {
  dc.setFillColor(color);
  dc.fillEllipse(new Rect(p.x - r, p.y - r, r * 2, r * 2));
}

function strokeCircle(dc, p, r, color, width) {
  dc.setStrokeColor(color);
  dc.setLineWidth(width);
  dc.strokeEllipse(new Rect(p.x - r, p.y - r, r * 2, r * 2));
}

function drawLegend(dc, x0, y, items) {
  let lx = x0;
  items.forEach(([color, label]) => {
    dc.setFillColor(new Color(color));
    dc.fillRect(new Rect(lx, y, 7, 7));
    dc.setFont(Font.systemFont(9));
    dc.setTextColor(new Color("#9aa7c2"));
    dc.drawText(label, new Point(lx + 10, y - 2));
    lx += 10 + label.length * 5.2 + 10;
  });
}

// ------------------------------------------------------------
// Dessin du graphique CAP (barres Km + D+ empilées + ligne Heures + Heures planifiées)
// ------------------------------------------------------------
function drawCapChartImage(c, size, showLegend) {
  const dc = new DrawContext();
  dc.size = size;
  dc.opaque = false;
  dc.respectScreenScale = true;

  const padL = 26;
  const padR = 6;
  const padT = 8;
  const padB = showLegend ? 26 : 14;
  const x0 = padL;
  const x1 = size.width - padR;
  const yTop = padT;
  const yBottom = size.height - padB;

  const historyWeeks = c.weeks.slice(-6);
  const allWeeks = [...new Set([...historyWeeks, ...(c.plannedWeeks || [])])].sort();
  const xScale = makeXScale(allWeeks, x0, x1);
  const barWidth = Math.max(4, ((x1 - x0) / Math.max(1, allWeeks.length)) * 0.5);

  // Échelle Km / D+ (barres empilées)
  const maxKmDplus = historyWeeks.length
    ? Math.max(...historyWeeks.map((w) => { const i = c.weeks.indexOf(w); return (c.km[i] || 0) + (c.dplusScaled[i] || 0); }))
    : 0;
  const kmYScale = makeYScale(0, maxKmDplus > 0 ? maxKmDplus * 1.15 : 1, yTop, yBottom);

  historyWeeks.forEach((w) => {
    const i = c.weeks.indexOf(w);
    const x = xScale(w);
    const km = c.km[i] || 0;
    const dplus = c.dplusScaled[i] || 0;
    const yKm = kmYScale(km);
    const yTot = kmYScale(km + dplus);
    dc.setFillColor(new Color("#FF6B35", 0.85));
    dc.fillRect(new Rect(x - barWidth / 2, yKm, barWidth, yBottom - yKm));
    dc.setFillColor(new Color("#8B4513", 0.85));
    dc.fillRect(new Rect(x - barWidth / 2, yTot, barWidth, yKm - yTot));
  });

  // Échelle Heures (ligne réelle + planifiée)
  const heuresReal = historyWeeks.map((w) => c.heures[c.weeks.indexOf(w)] || 0);
  const heuresPlan = c.plannedHeures || [];
  const maxHeures = Math.max(0.1, ...heuresReal, ...heuresPlan);
  const heuresYScale = makeYScale(0, maxHeures * 1.15, yTop, yBottom);

  const histPts = historyWeeks.map((w) => {
    const v = c.heures[c.weeks.indexOf(w)];
    return v == null ? null : new Point(xScale(w), heuresYScale(v));
  }).filter(Boolean);
  strokePolyline(dc, histPts, new Color("#1F77B4"), 3);
  histPts.forEach((p) => fillCircle(dc, p, 2.5, new Color("#1F77B4")));

  const planPts = (c.plannedWeeks || []).map((w, i) => {
    const v = heuresPlan[i];
    return v == null ? null : new Point(xScale(w), heuresYScale(v));
  }).filter(Boolean);
  if (planPts.length) {
    strokeDashedPolyline(dc, planPts, new Color("#1F77B4"), 2);
    (c.plannedWeeks || []).forEach((w, i) => {
      const v = heuresPlan[i];
      if (v == null) return;
      const p = new Point(xScale(w), heuresYScale(v));
      strokeCircle(dc, p, 3.5, new Color("#1F77B4"), 2);
      // Marque les semaines de course (icône simplifiée : point rouge)
      if ((c.plannedRaces || [])[i]) fillCircle(dc, p, 2, new Color("#ef5757"));
    });
  }

  if (showLegend) {
    drawLegend(dc, x0, size.height - 14, [
      ["#FF6B35", "Km"],
      ["#8B4513", "D+"],
      ["#1F77B4", "Heures"],
    ]);
  }

  return dc.getImage();
}

async function createWidget() {
  const w = new ListWidget();
  w.backgroundColor = new Color("#151a24");
  w.setPadding(10, 12, 8, 12);

  try {
    const data = await fetchDashboardData();
    const c = data.capChart;
    const family = config.widgetFamily || 'medium';

    if (!c.weeks.length) {
      const empty = w.addText("Aucune activité CAP.");
      empty.font = Font.systemFont(13);
      empty.textColor = Color.gray();
      return w;
    }

    const lastIdx = c.weeks.length - 1;
    const lastKm = c.km[lastIdx] || 0;
    const lastDplus = c.dplus[lastIdx] || 0;

    const header = w.addStack();
    header.centerAlignContent();
    const title = header.addText("CAP");
    title.font = Font.semiboldSystemFont(13);
    title.textColor = new Color("#9aa7c2");
    header.addSpacer();
    const numStack = header.addStack();
    numStack.layoutVertically();
    const big = numStack.addText(`${lastKm.toFixed(0)} km`);
    big.font = Font.boldSystemFont(family === 'small' ? 20 : 24);
    big.textColor = new Color("#FF6B35");
    big.rightAlignText();
    const dplusText = numStack.addText(`D+ ${Math.round(lastDplus)} m`);
    dplusText.font = Font.systemFont(family === 'small' ? 9 : 11);
    dplusText.textColor = new Color("#c98a5a");
    dplusText.rightAlignText();

    w.addSpacer(4);

    const showLegend = family !== 'small';
    const size = family === 'large' ? new Size(300, 210) : family === 'small' ? new Size(150, 95) : new Size(300, 95);
    const img = drawCapChartImage(c, size, showLegend);
    const imgWidget = w.addImage(img);
    imgWidget.imageSize = size;

    w.addSpacer(2);
    const caption = w.addText(`Semaine du ${formatWeekFr(c.weeks[lastIdx])}`);
    caption.font = Font.systemFont(9);
    caption.textColor = new Color("#6b7690");
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
