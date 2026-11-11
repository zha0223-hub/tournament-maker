// TRN server: Express + socket.io. State is in memory (see README for persistence notes).
const express = require('express'), http = require('http'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const { Server } = require('socket.io'), { verifyToken, createClerkClient } = require('@clerk/backend'), nodemailer = require('nodemailer');

const PK = process.env.CLERK_PUBLISHABLE_KEY || '', SK = process.env.CLERK_SECRET_KEY || '';
const PRE = +(process.env.PRE_SECONDS || 60);        // countdown before an event (set 10 while testing)
const OBJ = 5, PRIZE = 120;                          // objective screen seconds, end-of-tournament countdown
const URL_BASE = process.env.PUBLIC_URL || 'https://trn.geocornr.com';
const RECDIR = process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings');
fs.mkdirSync(RECDIR, { recursive: true });
const THEMES = ['Grass', 'Stone', 'Lava', 'Ocean', 'Sand'];
const RESERVED = ['rec', 'upload', 'config', 'icon', 'socket', 'api'];
const clerk = createClerkClient({ secretKey: SK }), comps = new Map();
const tx = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }) : null;
async function mail(to, subject, text) {
  if (!tx) return console.log('[mail not configured]', to, subject);
  try { await tx.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text }); }
  catch (e) { console.error('mail failed:', e.message); }
}
const clip = (s, n) => String(s || '').trim().slice(0, n);
const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(x => x[1]);
const okSlug = x => /^[a-z0-9-]{2,20}$/.test(x) && !RESERVED.includes(x) && !comps.has(x);
const alive = c => [...c.members.values()].filter(m => !m.ghost);
const okImg = d => !d || (typeof d === 'string' && d.startsWith('data:image/') && d.length < 600000);

const app = express(), srv = http.createServer(app), io = new Server(srv, { maxHttpBufferSize: 2e6 });
app.get('/config.js', (q, r) => r.type('js').send('window.CLERK_PK=' + JSON.stringify(PK) + ';'));
app.use('/rec', express.static(RECDIR));
app.use(express.static(path.join(__dirname, 'public')));
app.post('/upload/:slug/:eid/:sub', express.raw({ type: '*/*', limit: '150mb' }), (req, res) => {
  const c = comps.get(req.params.slug);
  if (!c || req.get('x-key') !== c.key) return res.sendStatus(403);
  const rec = c.recs.find(r => r.id === req.params.eid), m = c.members.get(req.params.sub);
  if (!rec || !m || !Buffer.isBuffer(req.body)) return res.sendStatus(400);
  const f = crypto.randomUUID() + '.webm';
  fs.writeFileSync(path.join(RECDIR, f), req.body);
  rec.files.push({ name: m.name, url: '/rec/' + f }); push(c); res.sendStatus(200);
});
app.get('/:slug', (q, r) => r.sendFile(path.join(__dirname, 'public', 'index.html')));

io.use(async (s, next) => {
  try {
    const p = await verifyToken(String(s.handshake.auth.token || ''), { secretKey: SK });
    const cu = await clerk.users.getUser(p.sub);
    const em = (cu.emailAddresses.find(e => e.id === cu.primaryEmailAddressId) || cu.emailAddresses[0] || {}).emailAddress || '';
    s.data.u = { sub: p.sub, email: em, name: cu.fullName || cu.username || 'Player' }; next();
  } catch (e) { console.error('auth failed:', e.message); next(new Error('auth')); }
});

function view(c, sub) {
  const cr = c.creator === sub, mem = [...c.members.values()], names = Object.fromEntries(mem.map(m => [m.sub, m.name]));
  const v = {
    now: Date.now(), slug: c.slug, name: c.name, rules: c.rules, theme: c.theme, logo: c.logo, min: c.min, win: c.win,
    role: cr ? 'creator' : 'player', me: sub, phase: c.phase, endsAt: c.endsAt, joined: mem.length,
    ghost: !cr && !!(c.members.get(sub) || {}).ghost,
    players: mem.filter(m => cr || !m.ghost).map(m => ({ sub: m.sub, name: m.name, ghost: m.ghost })),
    winners: c.phase === 'idle' ? [] : alive(c).map(m => m.name),
    prize: c.prize,
    recs: c.recs.map(r => ({ id: r.id, name: r.name, winners: r.winners, files: r.files })),
    events: c.events.filter(e => !e.done).map(e => {
      const i = e.teams.findIndex(t => t.includes(sub));
      return { id: e.id, name: e.name, at: e.at, obj: e.obj, timed: e.timed, dur: e.dur, T: e.T, P: e.P,
        teams: cr ? e.teams.map(t => t.map(s => names[s])) : undefined,
        mine: i < 0 ? null : { team: i + 1, mates: e.teams[i].filter(s => s !== sub).map(s => names[s]) } };
    })
  };
  if (cr) v.key = c.key;
  const r = c.run;
  if (r) {
    const flat = r.ev.teams.flat();
    v.run = { id: r.ev.id, phase: r.phase, endsAt: r.endsAt, startedAt: r.startedAt, name: r.ev.name, obj: r.ev.obj, timed: r.ev.timed,
      competing: flat.includes(sub), myTeam: r.ev.teams.findIndex(t => t.includes(sub)),
      teams: r.ev.teams.map(t => t.map(s => ({ sub: s, name: names[s] }))), shared: r.shared };
    if (flat.includes(sub)) v.run.viewers = [...c.socks.keys()].filter(s => !flat.includes(s));
  }
  return v;
}
function push(c) { for (const [sub, sid] of c.socks) io.to(sid).emit('state', view(c, sub)); }
function emitTo(c, sub, ev, d) { const sid = c.socks.get(sub); if (sid) io.to(sid).emit(ev, d); }

function beginPre(c, e) {
  e.teams = e.teams.map(t => t.filter(s => c.members.has(s) && !c.members.get(s).ghost)).filter(t => t.length);
  if (!e.teams.length) { e.done = true; return push(c); }
  c.run = { ev: e, phase: 'pre', endsAt: e.at, shared: {} };
  push(c); c.timer = setTimeout(() => advance(c), Math.max(0, e.at - Date.now()));
}
function advance(c) {
  const r = c.run; if (!r) return; const e = r.ev;
  if (r.phase === 'pre') {
    const multi = e.teams.length > 1, ok = e.teams.filter(t => t.every(s => r.shared[s])), bad = e.teams.filter(t => !ok.includes(t));
    if (!ok.length && multi) { e.done = true; c.run = null; c.socks.forEach((_, s) => emitTo(c, s, 'alert', 'Nobody shared a screen. Event cancelled.')); return push(c); }
    bad.flat().forEach(s => { c.members.get(s).ghost = true; emitTo(c, s, 'alert', 'You did not share your screen. Forfeit.'); });
    e.teams = ok;
    if (!ok.length) return finish(c, -1, 'forfeit');
    if (multi && ok.length === 1) return finish(c, 0, 'forfeit');
    r.phase = 'obj'; r.endsAt = Date.now() + OBJ * 1000;
  } else if (r.phase === 'obj') {
    r.phase = 'live'; r.startedAt = Date.now(); r.endsAt = e.timed ? Date.now() + e.dur * 1000 : 0;
  } else if (r.phase === 'live') {
    r.phase = 'decide'; r.endsAt = 0; c.recs.push({ id: e.id, name: e.name, winners: null, files: [] });
  }
  push(c); clearTimeout(c.timer);
  if (r.endsAt) c.timer = setTimeout(() => advance(c), r.endsAt - Date.now());
}
function finish(c, w, why) {
  const e = c.run.ev; clearTimeout(c.timer);
  e.teams.forEach((t, i) => { if (i !== w) t.forEach(s => { c.members.get(s).ghost = true; }); });
  let rec = c.recs.find(x => x.id === e.id); if (!rec) c.recs.push(rec = { id: e.id, name: e.name, files: [] });
  rec.winners = w >= 0 ? e.teams[w].map(s => c.members.get(s).name) : []; rec.why = why;
  e.done = true; c.run = null;
  if (alive(c).length <= c.win) c.phase = 'podium';
  push(c);
}
function end(c) {
  io.to(c.slug).emit('ended'); io.in(c.slug).socketsLeave(c.slug); comps.delete(c.slug);
  c.recs.forEach(r => r.files.forEach(f => fs.unlink(path.join(RECDIR, path.basename(f.url)), () => {})));
}
setInterval(() => {
  const now = Date.now();
  for (const c of comps.values()) {
    if (c.phase === 'prize' && now >= c.endsAt) { end(c); continue; }
    if (c.run || c.phase !== 'idle') continue;
    const e = c.events.filter(x => !x.done).sort((a, b) => a.at - b.at)[0];
    if (e && e.at - now <= PRE * 1000) beginPre(c, e);
  }
}, 500);

io.on('connection', s => {
  const u = s.data.u, mine = () => s.data.slug && comps.get(s.data.slug), isC = c => c && c.creator === u.sub;
  const attach = c => {
    s.data.slug = c.slug; s.join(c.slug); c.socks.set(u.sub, s.id);
    if (!isC(c)) emitTo(c, c.creator, 'peer', u.sub);
    push(c);
  };
  s.on('slug:check', (x, cb) => cb(okSlug(String(x))));
  s.on('comp:create', (d, cb) => {
    const name = clip(d.name, 30), min = Math.floor(+d.min), win = Math.floor(+d.win), slug = String(d.slug || '').toLowerCase();
    if (!name) return cb({ err: 'Give it a name' });
    if (!(min >= 2)) return cb({ err: 'Minimum players must be 2 or more' });
    if (!(win >= 1 && win < min)) return cb({ err: 'Winners must be 1 or more and less than minimum players' });
    if (!THEMES.includes(d.theme) || !okImg(d.logo)) return cb({ err: 'Bad theme or logo' });
    if (!okSlug(slug)) return cb({ err: '/' + slug + ' is taken or invalid (2-20 letters, numbers, dashes)' });
    comps.set(slug, { slug, name, rules: clip(d.rules, 1500) || 'No rules set.', theme: d.theme, logo: d.logo || null, min, win,
      creator: u.sub, creatorEmail: u.email, key: crypto.randomBytes(16).toString('hex'),
      members: new Map(), socks: new Map(), events: [], recs: [], phase: 'idle', run: null, prize: null });
    cb({ ok: 1, slug });
  });
  s.on('room:peek', (slug, cb) => {
    const c = comps.get(String(slug)); if (!c) return cb({ err: 'No competition lives at /' + slug });
    cb({ name: c.name, rules: c.rules, theme: c.theme, logo: c.logo, creator: isC(c), joined: c.members.has(u.sub) });
  });
  s.on('room:join', (d, cb) => {
    const c = comps.get(String(d.slug)); if (!c) return cb({ err: 'Not found' });
    if (!isC(c) && !c.members.has(u.sub)) {
      const nm = clip(d.name, 14);
      if (!nm || !d.agree) return cb({ err: 'Pick a name and accept the rules' });
      if ([...c.members.values()].some(m => m.name.toLowerCase() === nm.toLowerCase())) return cb({ err: 'That display name is taken' });
      if (c.recs.length || c.run || c.phase !== 'idle') return cb({ err: 'This tournament already started' });
      c.members.set(u.sub, { sub: u.sub, email: u.email, name: nm, ghost: false });
    }
    attach(c); cb({ ok: 1 });
  });
  s.on('ghost', (d, cb) => {
    const c = mine(); if (!isC(c)) return; const m = c.members.get(d.sub); if (!m) return;
    m.ghost = !!d.ghost; push(c);
  });
  s.on('event:create', (d, cb) => {
    const c = mine(); if (!isC(c) || c.phase !== 'idle') return cb({ err: 'Not allowed right now' });
    const T = Math.floor(+d.T), P = Math.floor(+d.P), pool = alive(c), name = clip(d.name, 40);
    if (c.members.size < c.min) return cb({ err: `Need ${c.min} players first (${c.members.size} joined)` });
    if (!name) return cb({ err: 'Name the event' });
    if (!(T >= 1 && P >= 1)) return cb({ err: 'Need 1+ teams and 1+ players per team' });
    if (T * P > pool.length) return cb({ err: `Only ${pool.length} players are alive` });
    const pick = shuffle(pool).slice(0, T * P), teams = Array.from({ length: T }, (_, i) => pick.slice(i * P, i * P + P).map(m => m.sub));
    const e = { id: crypto.randomUUID(), name, at: Math.max(+d.at || 0, Date.now() + PRE * 1000), obj: clip(d.obj, 200) || 'Win!',
      timed: !!d.timed, dur: Math.min(3600, Math.max(5, +d.dur || 60)), T, P, teams, done: false };
    c.events.push(e);
    pick.forEach(m => {
      const i = teams.findIndex(t => t.includes(m.sub)), mates = teams[i].filter(x => x !== m.sub).map(x => c.members.get(x).name);
      emitTo(c, m.sub, 'alert', `You were drawn for "${name}" (Team ${i + 1})`);
      mail(m.email, `${c.name}: you are in "${name}"`, `Team ${i + 1}${mates.length ? ' with ' + mates.join(', ') : ' (solo)'}\nStarts: ${new Date(e.at).toUTCString()}\nObjective: ${e.obj}\n\nBe on ${URL_BASE}/${c.slug} one minute early and share your screen, or you forfeit.`);
    });
    mail(c.creatorEmail, `${c.name}: teams drawn for "${name}"`, teams.map((t, i) => `Team ${i + 1}: ` + t.map(x => c.members.get(x).name).join(', ')).join('\n'));
    push(c); cb({ ok: 1 });
  });
  s.on('event:start', id => {
    const c = mine(); if (!isC(c) || c.run || c.phase !== 'idle') return;
    const e = c.events.find(x => x.id === id && !x.done); if (!e) return;
    e.at = Date.now() + PRE * 1000; beginPre(c, e);
  });
  s.on('screen:shared', () => {
    const c = mine(); if (!c || !c.run || c.run.phase !== 'pre' || !c.run.ev.teams.flat().includes(u.sub)) return;
    c.run.shared[u.sub] = true; push(c);
  });
  s.on('event:stop', () => { const c = mine(); if (isC(c) && c.run && c.run.phase === 'live') advance(c); });
  s.on('event:decide', w => {
    const c = mine(); if (!isC(c) || !c.run || c.run.phase !== 'decide') return;
    w = Math.floor(+w); finish(c, w >= 0 && w < c.run.ev.teams.length ? w : -1, '');
  });
  s.on('prize:award', (d, cb) => {
    const c = mine(); if (!isC(c) || c.phase !== 'podium') return;
    const text = clip(d.text, 80); if (!text || !okImg(d.pic)) return cb({ err: 'Enter the prize (picture max about 400KB)' });
    c.prize = { text, pic: d.pic || null }; c.phase = 'prize'; c.endsAt = Date.now() + PRIZE * 1000;
    alive(c).forEach(m => mail(m.email, `You won ${c.name}!`, `${clip(d.message, 1500)}\n\nPrize: ${text}`));
    push(c); cb({ ok: 1 });
  });
  s.on('rtc', m => { const c = mine(); if (c && typeof m.to === 'string') emitTo(c, m.to, 'rtc', { ...m, from: u.sub }); });
  s.on('disconnect', () => { const c = mine(); if (c && c.socks.get(u.sub) === s.id) { c.socks.delete(u.sub); push(c); } });
});
srv.listen(process.env.PORT || 3000, () => console.log('TRN listening'));
