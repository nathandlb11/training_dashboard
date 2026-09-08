// Widget iPhone ACWR — à ouvrir/coller dans l'app Scriptable (scriptable.app)
// Installation :
//  1. Renseigne BASE_URL, ATHLETE_ID, TOKEN ci-dessous.
//  2. Colle ce script dans un nouveau script Scriptable, nomme-le "ACWR Widget".
//  3. Écran d'accueil iPhone -> appui long -> "+" -> Scriptable -> taille petite/moyenne
//     -> Modifier le widget -> Script = "ACWR Widget".
//
// Si WIDGET_TOKEN est défini côté serveur (.env), TOKEN doit avoir la même valeur.

const BASE_URL = "https://TON-APP.vercel.app";
const ATHLETE_ID = "0";
const TOKEN = ""; // laisser vide si WIDGET_TOKEN n'est pas configuré côté serveur

async function fetchAcwrChart() {
  const url = `${BASE_URL}/api/dashboard-data?athleteId=${encodeURIComponent(ATHLETE_ID)}&forecastWeeks=4${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`;
  const req = new Request(url);
  const data = await req.loadJSON();
  if (data.error) throw new Error(data.error);
  return data.acwrChart;
}

function acwrColor(value) {
  if (value == null) return Color.gray();
  if (value > 1.3) return Color.red();
  if (value < 0.8) return Color.orange();
  return Color.green();
}

function drawSparkline(values, size) {
  const dc = new DrawContext();
  dc.size = size;
  dc.opaque = false;
  dc.respectScreenScale = true;

  const clean = values.map((v) => (v == null ? null : v));
  const finite = clean.filter((v) => v != null);
  if (!finite.length) return dc.getImage();

  const max = Math.max(1.5, ...finite);
  const min = Math.min(0.5, ...finite);
  const toPoint = (v, i) => new Point(
    (i / (clean.length - 1 || 1)) * size.width,
    size.height - ((v - min) / (max - min || 1)) * size.height
  );

  dc.setStrokeColor(new Color("#4da6ff"));
  dc.setLineWidth(3);
  const path = new Path();
  let started = false;
  clean.forEach((v, i) => {
    if (v == null) return;
    const p = toPoint(v, i);
    started ? path.addLine(p) : path.move(p);
    started = true;
  });
  dc.addPath(path);
  dc.strokePath();
  return dc.getImage();
}

async function createWidget() {
  const w = new ListWidget();
  w.backgroundColor = new Color("#1e1e1e");
  w.setPadding(12, 12, 10, 12);

  try {
    const chart = await fetchAcwrChart();
    const values = chart.acwr.concat(chart.forecast.acwr);
    const lastAcwr = [...chart.acwr].reverse().find((v) => v != null) ?? null;

    const title = w.addText("ACWR");
    title.font = Font.mediumSystemFont(13);
    title.textColor = Color.gray();
    w.addSpacer(2);

    const big = w.addText(lastAcwr != null ? lastAcwr.toFixed(2) : "—");
    big.font = Font.boldSystemFont(30);
    big.textColor = acwrColor(lastAcwr);
    w.addSpacer(6);

    const img = w.addImage(drawSparkline(values, new Size(280, 70)));
    img.imageSize = new Size(280, 70);

    w.addSpacer(4);
    const caption = w.addText(`${chart.weeks[chart.weeks.length - 1] ?? ''} → +${chart.forecast.weeks.length}sem`);
    caption.font = Font.systemFont(10);
    caption.textColor = Color.gray();
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
  await widget.presentSmall();
}
Script.complete();
