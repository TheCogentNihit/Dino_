const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const database = require('./database');

// --- Excel Exports Directory ---
const EXPORTS_DIR = path.join(__dirname, 'exports');
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1kb' })); // tiny payloads only
app.use(express.static(path.join(__dirname, 'public')));

// --- Rate Limiters ---

// General rate limiter: high threshold for 300+ simultaneous participants
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3000,
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
  validate: false,
  skip: (req) => req.headers['x-simulation'] === 'true',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// Score submission limiter: per-player throttling (30 attempts/min per player)
const scoreLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req.body && req.body.playerId) || req.headers['x-forwarded-for'] || req.ip,
  validate: false,
  skip: (req) => req.headers['x-simulation'] === 'true',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many score submissions. Please wait.' },
});

// Leaderboard limiter: 1000 requests per minute (served from in-memory cache)
const leaderboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
  validate: false,
  skip: (req) => req.headers['x-simulation'] === 'true',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many leaderboard requests. Please wait.' },
});

app.use('/api/', generalLimiter);

// --- Leaderboard Cache ---
let leaderboardCache = null;
let leaderboardCacheTime = 0;
const CACHE_TTL = 3000; // 3 seconds

function getCachedLeaderboard() {
  const now = Date.now();
  if (!leaderboardCache || now - leaderboardCacheTime > CACHE_TTL) {
    leaderboardCache = database.getLeaderboard(100);
    leaderboardCacheTime = now;
  }
  return leaderboardCache;
}

// --- API Routes ---

// Register a new player
app.post('/api/register', (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 30) {
      return res.status(400).json({ error: 'Name must be 1-30 characters.' });
    }

    const cleanName = name.trim();

    // Check if player with same name already exists
    const existing = database.findPlayerByName(cleanName);
    if (existing) {
      return res.json({
        playerId: existing.id,
        name: existing.name,
        returning: true,
      });
    }

    const playerId = 'P-' + crypto.randomUUID().slice(0, 8).toUpperCase();
    database.registerPlayer(playerId, cleanName);

    res.json({
      playerId,
      name: cleanName,
      returning: false,
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

// Submit a score
app.post('/api/scores', scoreLimiter, (req, res) => {
  try {
    const { playerId, score, scoreId, durationMs } = req.body;

    // Validate required fields
    if (!playerId || typeof score !== 'number' || !scoreId) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Validate score range (plausibility check)
    if (score < 0 || score > 99999 || !Number.isFinite(score)) {
      return res.status(400).json({ error: 'Invalid score value.' });
    }

    // Validate duration (game should last at least 1 second)
    if (durationMs && (durationMs < 1000 || durationMs > 3600000)) {
      return res.status(400).json({ error: 'Invalid game duration.' });
    }

    const result = database.submitScore(scoreId, playerId, score, durationMs);

    if (result.duplicate) {
      return res.json({ message: 'Score already recorded.', duplicate: true });
    }

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    // Invalidate leaderboard cache
    leaderboardCache = null;

    res.json({
      message: 'Score recorded!',
      attemptNumber: result.attemptNumber,
      bestScore: result.bestScore,
    });
  } catch (err) {
    console.error('Score submission error:', err);
    res.status(500).json({ error: 'Score submission failed.' });
  }
});

// Get leaderboard
app.get('/api/leaderboard', leaderboardLimiter, (req, res) => {
  try {
    const leaderboard = getCachedLeaderboard();
    res.json({ leaderboard });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Failed to load leaderboard.' });
  }
});

// Get player stats
app.get('/api/player/:id', (req, res) => {
  try {
    const player = database.getPlayer(req.params.id);
    if (!player) {
      return res.status(404).json({ error: 'Player not found.' });
    }

    const scores = database.getPlayerScores(req.params.id);
    res.json({ player, scores });
  } catch (err) {
    console.error('Player lookup error:', err);
    res.status(500).json({ error: 'Failed to load player.' });
  }
});

// --- Admin Routes (password-protected) ---

const ADMIN_PASSWORD = 'dino2024'; // Change this before the event!

function adminAuth(req, res, next) {
  const password = req.query.password || req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  next();
}

// Get stats
app.get('/api/admin/stats', adminAuth, (req, res) => {
  try {
    const stats = database.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

// Export CSV
app.get(['/api/admin/export-csv', '/api/admin/export'], adminAuth, (req, res) => {
  try {
    const results = database.getAllResults();

    let csv = 'Rank,Player ID,Name,Score,Attempt,Duration (sec),Submitted At\n';
    results.forEach((row, i) => {
      csv += `${i + 1},"${row.player_id}","${row.name}",${row.score},${row.attempt_number},${(row.duration_ms / 1000).toFixed(1)},"${row.submitted_at}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=dino_game_results.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export failed.' });
  }
});

// Export live Excel (.xlsx)
app.get('/api/admin/export-excel', adminAuth, async (req, res) => {
  try {
    const filePath = await generateExcelReport();
    const fileName = path.basename(filePath);
    res.download(filePath, fileName);
  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).json({ error: 'Excel export failed.' });
  }
});

// List all previous exports
app.get('/api/admin/exports', adminAuth, (req, res) => {
  try {
    const files = fs.readdirSync(EXPORTS_DIR)
      .filter(f => f.endsWith('.xlsx'))
      .sort()
      .reverse()
      .map(f => ({
        name: f,
        size: fs.statSync(path.join(EXPORTS_DIR, f)).size,
        created: fs.statSync(path.join(EXPORTS_DIR, f)).birthtime,
      }));
    res.json({ exports: files });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list exports.' });
  }
});

// Download a specific previous export
app.get('/api/admin/exports/:filename', adminAuth, (req, res) => {
  const fileName = req.params.filename;
  // Prevent directory traversal
  if (fileName.includes('..') || fileName.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename.' });
  }
  const filePath = path.join(EXPORTS_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found.' });
  }
  res.download(filePath, fileName);
});

// --- Excel Report Generator ---
async function generateExcelReport(customName) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Dino Game Competition';
  workbook.created = new Date();

  // --- Sheet 1: Leaderboard (Best scores) ---
  const lbSheet = workbook.addWorksheet('Leaderboard', {
    properties: { tabColor: { argb: '6366F1' } },
  });

  lbSheet.columns = [
    { header: 'Rank', key: 'rank', width: 8 },
    { header: 'Player ID', key: 'player_id', width: 14 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Best Score', key: 'best_score', width: 14 },
    { header: 'Attempts', key: 'attempts', width: 12 },
    { header: 'Last Played', key: 'last_played', width: 22 },
  ];

  // Style header row
  lbSheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 12 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '6366F1' } };
    cell.alignment = { horizontal: 'center' };
  });

  const leaderboard = database.getLeaderboard(1000);
  leaderboard.forEach((entry, i) => {
    const row = lbSheet.addRow({
      rank: i + 1,
      player_id: entry.player_id,
      name: entry.name,
      best_score: entry.best_score,
      attempts: entry.attempts,
      last_played: entry.last_played,
    });

    // Gold/Silver/Bronze highlighting
    if (i === 0) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8E1' } }; });
    if (i === 1) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F5F5F5' } }; });
    if (i === 2) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E0' } }; });
  });

  // --- Sheet 2: All Attempts ---
  const allSheet = workbook.addWorksheet('All Attempts', {
    properties: { tabColor: { argb: '22C55E' } },
  });

  allSheet.columns = [
    { header: 'Rank', key: 'rank', width: 8 },
    { header: 'Player ID', key: 'player_id', width: 14 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Score', key: 'score', width: 12 },
    { header: 'Attempt #', key: 'attempt_number', width: 12 },
    { header: 'Duration (sec)', key: 'duration', width: 16 },
    { header: 'Submitted At', key: 'submitted_at', width: 22 },
  ];

  allSheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 12 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '22C55E' } };
    cell.alignment = { horizontal: 'center' };
  });

  const allResults = database.getAllResults();
  allResults.forEach((row, i) => {
    allSheet.addRow({
      rank: i + 1,
      player_id: row.player_id,
      name: row.name,
      score: row.score,
      attempt_number: row.attempt_number,
      duration: (row.duration_ms / 1000).toFixed(1),
      submitted_at: row.submitted_at,
    });
  });

  // --- Sheet 3: Summary Stats ---
  const statsSheet = workbook.addWorksheet('Summary', {
    properties: { tabColor: { argb: 'F59E0B' } },
  });

  const stats = database.getStats();
  statsSheet.columns = [
    { header: 'Metric', key: 'metric', width: 24 },
    { header: 'Value', key: 'value', width: 20 },
  ];

  statsSheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 12 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F59E0B' } };
  });

  statsSheet.addRow({ metric: 'Total Players', value: stats.total_players || 0 });
  statsSheet.addRow({ metric: 'Total Attempts', value: stats.total_attempts || 0 });
  statsSheet.addRow({ metric: 'Highest Score', value: stats.highest_score || 0 });
  statsSheet.addRow({ metric: 'Average Score', value: Math.round(stats.avg_score || 0) });
  statsSheet.addRow({ metric: 'Export Time', value: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) });

  // Save file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = customName || `dino_results_${timestamp}.xlsx`;
  const filePath = path.join(EXPORTS_DIR, fileName);
  await workbook.xlsx.writeFile(filePath);

  console.log(`📊 Excel exported: ${filePath}`);
  return filePath;
}

// --- Serve frontend pages ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/game', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'leaderboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- Start server ---
app.listen(PORT, '0.0.0.0', async () => {
  console.log('');
  console.log('🦖 ═══════════════════════════════════════════════════');
  console.log('🦖  DINO GAME COMPETITION SERVER');
  console.log('🦖 ═══════════════════════════════════════════════════');
  console.log(`🦖  Local:    http://localhost:${PORT}`);

  // Show all network IPs
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`🦖  Network:  http://${iface.address}:${PORT}`);
      }
    }
  }

  console.log('🦖 ═══════════════════════════════════════════════════');
  console.log(`🦖  Admin:    http://localhost:${PORT}/admin`);
  console.log(`🦖  Password: ${ADMIN_PASSWORD}`);
  console.log('🦖 ═══════════════════════════════════════════════════');

  // Auto-export Excel snapshot on startup
  try {
    const stats = database.getStats();
    if (stats.total_attempts > 0) {
      const filePath = await generateExcelReport();
      console.log(`📊 Auto-exported previous session data to:`);
      console.log(`   ${filePath}`);
    } else {
      console.log('📊 No previous data to export (fresh database).');
    }
  } catch (err) {
    console.error('⚠️  Auto-export failed:', err.message);
  }

  // List existing exports
  const existingExports = fs.readdirSync(EXPORTS_DIR).filter(f => f.endsWith('.xlsx'));
  console.log(`📁 Export folder: ${EXPORTS_DIR}`);
  console.log(`📁 Total exports saved: ${existingExports.length}`);
  console.log('🦖 ═══════════════════════════════════════════════════');
  console.log('');
});
