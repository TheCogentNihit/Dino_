const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'dino_game.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS scores (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    attempt_number INTEGER NOT NULL,
    duration_ms INTEGER DEFAULT 0,
    submitted_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (player_id) REFERENCES players(id)
  );

  CREATE INDEX IF NOT EXISTS idx_scores_player ON scores(player_id);
  CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score DESC);
  CREATE INDEX IF NOT EXISTS idx_scores_submitted ON scores(submitted_at);
`);

// Prepared statements for performance
const stmts = {
  insertPlayer: db.prepare('INSERT OR IGNORE INTO players (id, name) VALUES (?, ?)'),
  getPlayer: db.prepare('SELECT * FROM players WHERE id = ?'),
  getPlayerByName: db.prepare('SELECT * FROM players WHERE name = ? COLLATE NOCASE'),
  playerExists: db.prepare('SELECT 1 FROM players WHERE id = ?'),

  insertScore: db.prepare('INSERT OR IGNORE INTO scores (id, player_id, score, attempt_number, duration_ms) VALUES (?, ?, ?, ?, ?)'),
  scoreExists: db.prepare('SELECT 1 FROM scores WHERE id = ?'),
  getAttemptCount: db.prepare('SELECT COUNT(*) as count FROM scores WHERE player_id = ?'),
  getPlayerBest: db.prepare('SELECT MAX(score) as best FROM scores WHERE player_id = ?'),
  getPlayerScores: db.prepare('SELECT * FROM scores WHERE player_id = ? ORDER BY attempt_number DESC'),

  leaderboard: db.prepare(`
    SELECT 
      p.id as player_id,
      p.name,
      MAX(s.score) as best_score,
      COUNT(s.id) as attempts,
      MAX(s.submitted_at) as last_played
    FROM players p
    INNER JOIN scores s ON p.id = s.player_id
    GROUP BY p.id
    ORDER BY best_score DESC
    LIMIT ?
  `),

  allResults: db.prepare(`
    SELECT 
      p.id as player_id,
      p.name,
      s.score,
      s.attempt_number,
      s.duration_ms,
      s.submitted_at
    FROM scores s
    INNER JOIN players p ON s.player_id = p.id
    ORDER BY s.score DESC
  `),

  stats: db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM players) as total_players,
      (SELECT COUNT(*) FROM scores) as total_attempts,
      (SELECT MAX(score) FROM scores) as highest_score,
      (SELECT AVG(score) FROM scores) as avg_score
  `),

  totalPlayers: db.prepare('SELECT COUNT(*) as count FROM players'),
};

const submitScoreTx = db.transaction((scoreId, playerId, score, durationMs) => {
  // Check for duplicate submission
  if (stmts.scoreExists.get(scoreId)) {
    return { duplicate: true };
  }

  // Validate player exists
  if (!stmts.playerExists.get(playerId)) {
    return { error: 'Player not found' };
  }

  // Validate score
  if (typeof score !== 'number' || score < 0 || score > 99999) {
    return { error: 'Invalid score' };
  }

  // Get attempt number
  const { count } = stmts.getAttemptCount.get(playerId);
  const attemptNumber = count + 1;

  stmts.insertScore.run(scoreId, playerId, Math.floor(score), attemptNumber, durationMs || 0);

  const { best } = stmts.getPlayerBest.get(playerId);

  return { success: true, attemptNumber, bestScore: best };
});

module.exports = {
  db,
  stmts,

  registerPlayer(id, name) {
    return stmts.insertPlayer.run(id, name);
  },

  getPlayer(id) {
    return stmts.getPlayer.get(id);
  },

  findPlayerByName(name) {
    return stmts.getPlayerByName.get(name);
  },

  submitScore(scoreId, playerId, score, durationMs) {
    return submitScoreTx(scoreId, playerId, score, durationMs);
  },

  getLeaderboard(limit = 50) {
    return stmts.leaderboard.all(limit);
  },

  getAllResults() {
    return stmts.allResults.all();
  },

  getStats() {
    return stmts.stats.get();
  },

  getPlayerScores(playerId) {
    return stmts.getPlayerScores.all(playerId);
  },
};
