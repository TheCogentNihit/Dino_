/**
 * Dino Game Competition — 300 Simultaneous Players Load & Stress Test
 * 
 * Simulates 300 active players simultaneously:
 * 1. Registering 300 distinct players
 * 2. Concurrently playing and submitting scores across multiple attempts
 * 3. Concurrently polling the live leaderboard (simulating mobile browsers + big screens)
 * 4. Tracking request latency (avg, min, max, p95), error rates, and server crash status
 */

const crypto = require('crypto');

const BASE_URL = process.env.SERVER_URL || 'http://localhost:3000';
const NUM_PLAYERS = 300;
const ROUNDS_PER_PLAYER = 2; // Each player plays 2 rounds -> 600 score submissions!

// Metrics collector
const metrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  statusCodeCounts: {},
  latencies: [],
  registeredPlayers: 0,
  scoresSubmitted: 0,
  leaderboardQueries: 0,
  errors: [],
  startTime: 0,
  endTime: 0,
};

function recordRequest(statusCode, latencyMs, error = null) {
  metrics.totalRequests++;
  metrics.statusCodeCounts[statusCode] = (metrics.statusCodeCounts[statusCode] || 0) + 1;
  metrics.latencies.push(latencyMs);

  if (statusCode >= 200 && statusCode < 400) {
    metrics.successfulRequests++;
  } else {
    metrics.failedRequests++;
    if (error) metrics.errors.push(error);
  }
}

async function makeRequest(url, options = {}) {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'x-simulation': 'true',
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const latency = performance.now() - start;
    recordRequest(res.status, latency);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data, latency };
  } catch (err) {
    const latency = performance.now() - start;
    recordRequest(0, latency, err.message);
    return { ok: false, status: 0, error: err.message, latency };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Player simulation worker
async function simulatePlayer(index) {
  const playerName = `Runner_${String(index).padStart(3, '0')}`;
  const simulatedIp = `10.222.${Math.floor(index / 250)}.${(index % 250) + 1}`;

  // 1. Registration
  const regRes = await makeRequest(`${BASE_URL}/api/register`, {
    method: 'POST',
    headers: { 'x-forwarded-for': simulatedIp },
    body: JSON.stringify({ name: playerName }),
  });

  if (!regRes.ok || !regRes.data.playerId) {
    return { success: false, index, error: 'Registration failed' };
  }

  const playerId = regRes.data.playerId;
  metrics.registeredPlayers++;

  // 2. Play multiple rounds
  for (let round = 1; round <= ROUNDS_PER_PLAYER; round++) {
    // Simulate game startup & check leaderboard
    await makeRequest(`${BASE_URL}/api/leaderboard`, {
      method: 'GET',
      headers: { 'x-forwarded-for': simulatedIp },
    });
    metrics.leaderboardQueries++;

    // Stagger simulated playing duration (between 100ms and 1500ms in accelerated test)
    const playDuration = 200 + Math.floor(Math.random() * 800);
    await sleep(playDuration);

    // Random realistic dino game score
    const score = Math.floor(150 + Math.random() * 2500);
    const scoreId = crypto.randomUUID();

    // Submit score
    const scoreRes = await makeRequest(`${BASE_URL}/api/scores`, {
      method: 'POST',
      headers: { 'x-forwarded-for': simulatedIp },
      body: JSON.stringify({
        playerId,
        score,
        scoreId,
        durationMs: playDuration * 10,
      }),
    });

    if (scoreRes.ok) {
      metrics.scoresSubmitted++;
    }

    // Occasional leaderboard refresh between runs
    if (Math.random() > 0.5) {
      await makeRequest(`${BASE_URL}/api/leaderboard`, {
        method: 'GET',
        headers: { 'x-forwarded-for': simulatedIp },
      });
      metrics.leaderboardQueries++;
    }
  }

  return { success: true, index, playerId };
}

// Background scoreboard viewer (simulating live displays & audience viewing)
async function simulateAudienceTraffic(abortSignal) {
  while (!abortSignal.aborted) {
    await makeRequest(`${BASE_URL}/api/leaderboard`);
    metrics.leaderboardQueries++;
    await sleep(100); // 10 requests per second background stream
  }
}

async function runLoadTest() {
  console.log('🦖 ══════════════════════════════════════════════════════════════');
  console.log('🦖   DINO GAME STRESS TEST: 300 SIMULTANEOUS PLAYERS');
  console.log('🦖 ══════════════════════════════════════════════════════════════');
  console.log(`🎯 Target URL:          ${BASE_URL}`);
  console.log(`👥 Concurrent Players:  ${NUM_PLAYERS}`);
  console.log(`🎮 Rounds Per Player:   ${ROUNDS_PER_PLAYER}`);
  console.log(`📊 Expected Submissions:${NUM_PLAYERS * ROUNDS_PER_PLAYER}`);
  console.log('🦖 ══════════════════════════════════════════════════════════════\n');

  // Verify server is alive before beginning
  console.log('🔍 Testing server initial health...');
  const healthCheck = await makeRequest(`${BASE_URL}/api/leaderboard`);
  if (!healthCheck.ok) {
    console.error('❌ Server is not responding at', BASE_URL);
    process.exit(1);
  }
  console.log('✅ Server is reachable. Initial response time:', Math.round(healthCheck.latency), 'ms\n');

  console.log(`🚀 Launching 300 players simultaneously...`);
  metrics.startTime = performance.now();

  const abortController = { aborted: false };
  const audiencePromise = simulateAudienceTraffic(abortController);

  // Launch all 300 players concurrently
  const playerPromises = Array.from({ length: NUM_PLAYERS }, (_, i) => simulatePlayer(i + 1));

  // Progress logger
  const progressInterval = setInterval(() => {
    const elapsedSec = ((performance.now() - metrics.startTime) / 1000).toFixed(1);
    process.stdout.write(
      `\r⏳ [${elapsedSec}s] Requests: ${metrics.totalRequests} | Registered: ${metrics.registeredPlayers}/${NUM_PLAYERS} | Scores Saved: ${metrics.scoresSubmitted} | Fails: ${metrics.failedRequests}`
    );
  }, 300);

  // Wait for all 300 players to complete
  await Promise.all(playerPromises);

  // Stop audience background queries
  abortController.aborted = true;
  await audiencePromise;
  clearInterval(progressInterval);

  metrics.endTime = performance.now();
  const totalDurationSec = ((metrics.endTime - metrics.startTime) / 1000).toFixed(2);

  console.log('\n\n🔍 Performing post-test health check & database audit...');

  // Post-test health check
  const postHealth = await makeRequest(`${BASE_URL}/api/leaderboard`);
  const adminStats = await makeRequest(`${BASE_URL}/api/admin/stats?password=dino2024`);

  // Calculate statistics
  metrics.latencies.sort((a, b) => a - b);
  const avgLatency = (metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length).toFixed(1);
  const minLatency = metrics.latencies[0].toFixed(1);
  const maxLatency = metrics.latencies[metrics.latencies.length - 1].toFixed(1);
  const p95Latency = metrics.latencies[Math.floor(metrics.latencies.length * 0.95)].toFixed(1);
  const p99Latency = metrics.latencies[Math.floor(metrics.latencies.length * 0.99)].toFixed(1);
  const requestsPerSec = (metrics.totalRequests / (metrics.endTime - metrics.startTime) * 1000).toFixed(1);

  console.log('\n==============================================================');
  console.log('                  📊 STRESS TEST RESULTS                      ');
  console.log('==============================================================');
  console.log(`⏱️  Total Duration:         ${totalDurationSec} seconds`);
  console.log(`👥 Total Simulated Players: ${NUM_PLAYERS}`);
  console.log(`📝 Registered Successfully: ${metrics.registeredPlayers} / ${NUM_PLAYERS}`);
  console.log(`🎮 Scores Submitted:        ${metrics.scoresSubmitted} / ${NUM_PLAYERS * ROUNDS_PER_PLAYER}`);
  console.log(`🏆 Leaderboard Queries:     ${metrics.leaderboardQueries}`);
  console.log(`📦 Total HTTP Requests:     ${metrics.totalRequests} (${requestsPerSec} req/sec)`);
  console.log(`--------------------------------------------------------------`);
  console.log(`⚡ LATENCY BREAKDOWN:`);
  console.log(`   - Minimum:  ${minLatency} ms`);
  console.log(`   - Average:  ${avgLatency} ms`);
  console.log(`   - 95th %:   ${p95Latency} ms`);
  console.log(`   - 99th %:   ${p99Latency} ms`);
  console.log(`   - Maximum:  ${maxLatency} ms`);
  console.log(`--------------------------------------------------------------`);
  console.log(`📡 HTTP STATUS CODES:`);
  for (const [code, count] of Object.entries(metrics.statusCodeCounts)) {
    console.log(`   - Status ${code}: ${count} requests`);
  }
  console.log(`--------------------------------------------------------------`);
  console.log(`💾 DATABASE AUDIT:`);
  if (adminStats.ok) {
    console.log(`   - Total Players in DB:  ${adminStats.data.total_players}`);
    console.log(`   - Total Scores in DB:   ${adminStats.data.total_attempts}`);
    console.log(`   - Highest Score in DB:  ${adminStats.data.highest_score}`);
    console.log(`   - Average Score in DB:  ${Math.round(adminStats.data.avg_score)}`);
  }
  console.log(`--------------------------------------------------------------`);
  
  const serverAlive = postHealth.ok;
  const zeroServerErrors = (metrics.statusCodeCounts[500] || 0) === 0 && (metrics.statusCodeCounts[502] || 0) === 0 && (metrics.statusCodeCounts[503] || 0) === 0;

  if (serverAlive && zeroServerErrors && metrics.failedRequests === 0) {
    console.log(`🎉 SERVER STATUS: 🟢 100% HEALTHY & RESPONSIVE (0 CRASHES)`);
    console.log(`✅ The site handled 300 simultaneous players with ZERO crashes!`);
  } else if (serverAlive) {
    console.log(`⚠️ SERVER STATUS: 🟡 ALIVE WITH MINOR RETRIES/FAILS`);
    console.log(`   Failed requests: ${metrics.failedRequests}`);
  } else {
    console.log(`💥 SERVER STATUS: 🔴 CRASHED / UNRESPONSIVE`);
  }
  console.log('==============================================================\n');
}

runLoadTest();
