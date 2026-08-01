// HASH FARM - 실시간 접속자 표시 서버 (Supabase 영구 리더보드 연동)
// Node.js + Express + Socket.io + @supabase/supabase-js
// Render.com 환경변수에 SUPABASE_URL, SUPABASE_SERVICE_KEY 를 설정해야 합니다.

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ---------- CORS 설정 ----------
const ALLOWED_ORIGINS = [
  'https://kojilkojil5-lang.github.io',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// ---------- Supabase 연결 ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('[Supabase] 연결됨');
} else {
  console.warn('[Supabase] 환경변수 미설정 — 리더보드가 메모리로만 동작합니다.');
}

// ---------- 리더보드 함수 (Supabase 사용 시 DB, 아니면 메모리) ----------
const memLeaderboards = {};
const LEADERBOARD_LIMIT = 50;

async function submitScore(tierIndex, nickname, icon, net) {
  if (supabase) {
    const { error } = await supabase
      .from('hashfarm_leaderboard')
      .upsert(
        { tier_index: tierIndex, nickname, icon, net, updated_at: new Date().toISOString() },
        { onConflict: 'tier_index,nickname' }
      );
    if (error) console.error('[Supabase] submitScore 오류:', error.message);
  } else {
    if (!memLeaderboards[tierIndex]) memLeaderboards[tierIndex] = [];
    let list = memLeaderboards[tierIndex].filter(e => e.nickname !== nickname);
    list.push({ nickname, icon, net });
    list.sort((a, b) => b.net - a.net);
    memLeaderboards[tierIndex] = list.slice(0, LEADERBOARD_LIMIT);
  }
}

async function fetchLeaderboard(tierIndex) {
  if (supabase) {
    const { data, error } = await supabase
      .from('hashfarm_leaderboard')
      .select('nickname, icon, net')
      .eq('tier_index', tierIndex)
      .order('net', { ascending: false })
      .limit(LEADERBOARD_LIMIT);
    if (error) { console.error('[Supabase] fetchLeaderboard 오류:', error.message); return []; }
    return data || [];
  } else {
    return memLeaderboards[tierIndex] || [];
  }
}

// ---------- 소켓 서버 ----------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
});

// 메모리 상태 (접속자, 채팅은 여전히 메모리 — 재시작 시 초기화 OK)
const users = new Map();
const chatHistory = [];
const CHAT_HISTORY_LIMIT = 50;
const CHAT_MIN_INTERVAL_MS = 1500;
const CHAT_MAX_LENGTH = 200;

function broadcastUserList() {
  const list = Array.from(users.values()).map(u => ({ id: u.id, nickname: u.nickname, icon: u.icon }));
  io.emit('user_update', { count: list.length, users: list });
}

io.on('connection', (socket) => {
  const defaultNickname = `채굴러-${socket.id.slice(0, 4)}`;
  users.set(socket.id, { id: socket.id, nickname: defaultNickname, icon: '👶', connectedAt: Date.now() });

  console.log(`[접속] ${socket.id} (현재 ${users.size}명)`);
  broadcastUserList();
  socket.emit('chat_history', chatHistory);

  socket.on('update_profile', (profile) => {
    const user = users.get(socket.id);
    if (!user || !profile || typeof profile !== 'object') return;
    if (typeof profile.nickname === 'string' && profile.nickname.trim())
      user.nickname = profile.nickname.trim().slice(0, 16);
    if (typeof profile.icon === 'string' && profile.icon.length <= 4)
      user.icon = profile.icon;
    broadcastUserList();
  });

  socket.on('set_nickname', (nickname) => {
    const user = users.get(socket.id);
    if (user && typeof nickname === 'string' && nickname.trim()) {
      user.nickname = nickname.trim().slice(0, 16);
      broadcastUserList();
    }
  });

  socket.on('chat_message', (payload) => {
    const user = users.get(socket.id);
    if (!user || !payload || typeof payload.text !== 'string') return;
    const now = Date.now();
    if (user.lastMsgTime && now - user.lastMsgTime < CHAT_MIN_INTERVAL_MS) return;
    const text = payload.text.trim().slice(0, CHAT_MAX_LENGTH);
    if (!text) return;
    user.lastMsgTime = now;
    const msg = { nickname: user.nickname, icon: user.icon, text, ts: now };
    chatHistory.push(msg);
    if (chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory.shift();
    io.emit('chat_message', msg);
  });

  // 리더보드 등록 (Supabase에 영구 저장)
  socket.on('submit_score', async (payload) => {
    if (!payload || typeof payload.tierIndex !== 'number' || typeof payload.net !== 'number') return;
    const name = String(payload.nickname || '익명채굴러').trim().slice(0, 16) || '익명채굴러';
    const icon = typeof payload.icon === 'string' && payload.icon.length <= 4 ? payload.icon : '👤';
    await submitScore(payload.tierIndex, name, icon, payload.net);
    const list = await fetchLeaderboard(payload.tierIndex);
    io.emit('leaderboard_update', { tierIndex: payload.tierIndex, list });
  });

  // 리더보드 조회 (DB에서 불러오기)
  socket.on('get_leaderboard', async (tierIndex) => {
    if (typeof tierIndex !== 'number') return;
    const list = await fetchLeaderboard(tierIndex);
    socket.emit('leaderboard_update', { tierIndex, list });
  });

  socket.on('disconnect', () => {
    users.delete(socket.id);
    console.log(`[퇴장] ${socket.id} (현재 ${users.size}명)`);
    broadcastUserList();
  });
});

app.get('/', (req, res) => {
  res.send(`HASH FARM realtime server running. Connected: ${users.size}. Supabase: ${supabase ? 'connected' : 'memory-only'}`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: 포트 ${PORT}`));
