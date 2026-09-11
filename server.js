'use strict';

require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const dashboardRoutes = require('./routes/dashboard');
const planningRoutes = require('./routes/planning');

const app = express();

// Nécessaire pour que `req.secure` reflète le HTTPS d'origine derrière le proxy Vercel.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
// Expose les modules de calcul partagés (UMD) au navigateur (session builder, plan builder…)
app.use('/vendor', express.static(path.join(__dirname, 'src')));
app.use(express.urlencoded({ extended: false }));

const SESSION_COOKIE = 'dash_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function authConfigured() {
  return Boolean(process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS);
}

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.dashboardAuthEnabled = authConfigured();
  next();
});

// Protège les pages HTML via une vraie page de login + cookie de session signé (HMAC).
// Pas de stockage serveur (adapté à Vercel, serverless/stateless). Si DASHBOARD_USER/
// DASHBOARD_PASS ne sont pas définis, aucun changement de comportement (pas d'auth, comme avant).
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getSessionSecret() {
  return process.env.DASHBOARD_SESSION_SECRET || `${process.env.DASHBOARD_USER}:${process.env.DASHBOARD_PASS}`;
}

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(data).digest('base64url');
  if (!sig || !timingSafeEqual(sig, expectedSig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function requireDashboardAuth(req, res, next) {
  if (!authConfigured()) return next();

  const payload = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (payload && payload.u === process.env.DASHBOARD_USER) return next();

  const nextUrl = encodeURIComponent(req.originalUrl || '/dashboard');
  return res.redirect(`/login?next=${nextUrl}`);
}

app.get('/login', (req, res) => {
  if (!authConfigured()) return res.redirect('/dashboard');
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/dashboard';
  res.render('login', { error: null, next });
});

app.post('/login', (req, res) => {
  if (!authConfigured()) return res.redirect('/dashboard');

  const { username, password, next: nextUrl } = req.body;
  const safeNext = typeof nextUrl === 'string' && nextUrl.startsWith('/') ? nextUrl : '/dashboard';

  if (
    username && password &&
    timingSafeEqual(username, process.env.DASHBOARD_USER) &&
    timingSafeEqual(password, process.env.DASHBOARD_PASS)
  ) {
    const token = signSession({ u: username, exp: Date.now() + SESSION_MAX_AGE_MS });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSION_MAX_AGE_MS,
      path: '/',
    });
    return res.redirect(safeNext);
  }

  return res.status(401).render('login', { error: 'Identifiants invalides.', next: safeNext });
});

app.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect('/login');
});

app.get('/', requireDashboardAuth, (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', requireDashboardAuth);
app.get('/planning', requireDashboardAuth);

app.use(dashboardRoutes);
app.use(planningRoutes);

app.use((req, res) => {
  res.status(404).send('Page introuvable.');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`Erreur serveur : ${err.message}`);
});

// Sur Vercel, le serveur est appelé comme handler serverless (api/index.js) :
// pas de app.listen() dans ce cas, il faut juste exporter `app`.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Training Load Dashboard — http://localhost:${PORT}`);
  });
}

module.exports = app;
