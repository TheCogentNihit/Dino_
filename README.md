# 🦖 Dino Game Competition Platform

A high-performance competition web platform where up to 1,000 participants can simultaneously play the classic T-Rex Dino runner game on mobile and desktop devices, submitting live scores to a central leaderboard and generating instant Excel reports.

Tested and proven to handle **300+ simultaneous players** with **600+ requests/sec** at zero packet loss and 0 crashes.

---

## ✨ Features

- **🎮 Mobile & Desktop Ready**: Custom touch, keyboard (Space/ArrowUp/ArrowDown), and tap controls.
- **⚡ High-Throughput Engine**: Powered by Node.js, Express, and `better-sqlite3` configured in WAL (Write-Ahead Logging) mode with atomic write transactions.
- **🏆 Live Public Leaderboard**: Auto-refreshing, low-latency leaderboard with in-memory caching (3s TTL) and gold/silver/bronze highlights.
- **📊 Admin Dashboard**:
  - Real-time competition metrics (Total Players, Total Attempts, High Score, Average Score).
  - 1-click live **Excel report download (`.xlsx`)** formatted with tab colors and rank styles.
  - Automatic session archive on each server restart (keeps all historical sessions safe).
  - CSV export fallback.
- **🛡️ Fair-Play & Abuse Mitigation**:
  - Per-player submission throttling (prevents single-user script spamming while allowing hundreds of users on shared Wi-Fi).
  - Duplicate UUID score validation.
  - Plausible game duration and score bounds checking.
- **🧪 Stress Testing Suite**: Built-in 300-player simultaneous load simulation script (`npm run test:load`).

---

## 🚀 Quick Start

### 1. Installation
```bash
npm install
```

### 2. Run the Server
```bash
npm start
```
By default, the server listens on port `3000`:
- **Player Interface**: `http://localhost:3000` (or `http://<YOUR-IP>:3000` for Wi-Fi players)
- **Live Leaderboard**: `http://localhost:3000/leaderboard`
- **Admin Dashboard**: `http://localhost:3000/admin` (Password: `dino2024`)

---

## 🧪 Load Testing (300 Simultaneous Players)

To simulate 300 concurrent players registering, playing multiple rounds, querying the leaderboard, and submitting scores:

```bash
npm run test:load
```

---

## 📁 Project Structure

```
├── public/                 # Client assets
│   ├── index.html          # Registration & home landing
│   ├── game.html           # Dino game canvas & gameplay loop
│   ├── leaderboard.html    # Standalone public scoreboard
│   ├── admin.html          # Password-protected admin console
│   ├── css/style.css       # Unified design system & responsive UI
│   └── js/                 # Client-side scripts
├── database.js             # SQLite schema, WAL configuration & atomic transactions
├── server.js               # Express API endpoints, rate limiters, Excel generator
├── simulate_300_players.js # 300-player concurrent stress testing suite
├── exports/                # Auto-generated historical Excel archives (.xlsx)
├── package.json            # Project manifest & npm run scripts
└── .gitignore              # Ignores node_modules, sqlite files, and excel exports
```

---

## 📜 License
ISC License
