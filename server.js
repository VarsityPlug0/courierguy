const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 4500;
const DATA = path.join(__dirname, 'data');

// ── Helpers ──────────────────────────────────────────────────
const readJSON = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const writeJSON = (f, d) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(d, null, 2));

// ── Seed test user on startup ────────────────────────────────
async function seed() {
  const users = readJSON('users.json');
  if (!users.find(u => u.email === 'test@test.com')) {
    const hash = await bcrypt.hash('test123', 10);
    users.push({ id: uuidv4(), name: 'Test User', email: 'test@test.com', password: hash, role: 'customer', createdAt: new Date().toISOString() });
    writeJSON('users.json', users);
    console.log('  Test account created → email: test@test.com  password: test123');
  }
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(session({ secret: 'cg-secret-2026', resave: false, saveUninitialized: false, cookie: { maxAge: 86400000 } }));

// Logo upload
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'public')),
    filename: (req, file, cb) => cb(null, 'logo' + path.extname(file.originalname))
  }),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ── Auth Routes ──────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const users = readJSON('users.json');
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(400).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const user = { id: uuidv4(), name, email: email.toLowerCase(), password: hash, role: 'customer', createdAt: new Date().toISOString() };
    users.push(user);
    writeJSON('users.json', users);
    req.session.userId = user.id;
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const users = readJSON('users.json');
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid email or password' });
    req.session.userId = user.id;
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = readJSON('users.json').find(u => u.id === req.session.userId);
  if (!user) return res.json({ user: null });
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

// ── Tracking Routes ──────────────────────────────────────────
// Public: look up by waybill
app.get('/api/track/:waybill', (req, res) => {
  const t = readJSON('trackings.json').find(t => t.waybill.toLowerCase() === req.params.waybill.toLowerCase());
  if (!t) return res.status(404).json({ error: 'No tracking found for that waybill number.' });
  res.json(t);
});

// Admin: list all
app.get('/api/trackings', (req, res) => res.json(readJSON('trackings.json')));

// Admin: create
app.post('/api/trackings', (req, res) => {
  try {
    const trackings = readJSON('trackings.json');
    const { waybill, customer, origin, destination, status, note } = req.body;
    if (!waybill || !customer?.name) return res.status(400).json({ error: 'Waybill and customer name are required' });
    if (trackings.find(t => t.waybill.toLowerCase() === waybill.toLowerCase())) return res.status(400).json({ error: 'Waybill already exists' });
    const now = new Date().toISOString();
    const tracking = {
      waybill: waybill.toUpperCase(),
      customer: { name: customer.name, email: customer.email || '', phone: customer.phone || '' },
      origin: origin || '', destination: destination || '',
      status: status || 'Pending', createdAt: now, updatedAt: now,
      history: [{ status: status || 'Pending', location: origin || '', timestamp: now, note: note || 'Shipment created' }]
    };
    trackings.push(tracking);
    writeJSON('trackings.json', trackings);
    res.json({ success: true, tracking });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: add status update
app.post('/api/trackings/:waybill/update', (req, res) => {
  try {
    const trackings = readJSON('trackings.json');
    const idx = trackings.findIndex(t => t.waybill.toLowerCase() === req.params.waybill.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const { status, location, note } = req.body;
    const now = new Date().toISOString();
    trackings[idx].status = status;
    trackings[idx].updatedAt = now;
    trackings[idx].history.push({ status, location: location || '', timestamp: now, note: note || '' });
    writeJSON('trackings.json', trackings);
    res.json({ success: true, tracking: trackings[idx] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: update customer details
app.put('/api/trackings/:waybill', (req, res) => {
  try {
    const trackings = readJSON('trackings.json');
    const idx = trackings.findIndex(t => t.waybill.toLowerCase() === req.params.waybill.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const { customer, origin, destination } = req.body;
    if (customer) trackings[idx].customer = { ...trackings[idx].customer, ...customer };
    if (origin) trackings[idx].origin = origin;
    if (destination) trackings[idx].destination = destination;
    trackings[idx].updatedAt = new Date().toISOString();
    writeJSON('trackings.json', trackings);
    res.json({ success: true, tracking: trackings[idx] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: delete
app.delete('/api/trackings/:waybill', (req, res) => {
  try {
    let trackings = readJSON('trackings.json');
    trackings = trackings.filter(t => t.waybill.toLowerCase() !== req.params.waybill.toLowerCase());
    writeJSON('trackings.json', trackings);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: users list
app.get('/api/users', (req, res) => {
  res.json(readJSON('users.json').map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })));
});

// ── Content Routes ───────────────────────────────────────────
app.get('/api/content', (req, res) => res.json(readJSON('content.json')));
app.put('/api/content/:section', (req, res) => {
  try {
    const content = readJSON('content.json');
    const { section } = req.params;
    if (!(section in content)) return res.status(404).json({ error: 'Section not found' });
    content[section] = req.body;
    writeJSON('content.json', content);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/upload/logo', upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ success: true, url: '/public/logo' + path.extname(req.file.originalname) });
});

// ── Pages ────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));

seed().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  Courier Guy → http://localhost:${PORT}`);
    console.log(`  Admin panel  → http://localhost:${PORT}/admin\n`);
  });
});
