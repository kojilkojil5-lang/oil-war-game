const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// 정적 파일 제공 (index.html을 서비스하기 위함)
app.use(express.static(path.join(__dirname)));

// --- 게임 물리/경제 엔진 변수 ---
let currentOilPrice = 80.00; // 배럴당 기본 유가 ($)
let tensionLevel = 0;        // 이란 vs 미국 긴장도 (0 ~ 100)
let newsHistory = ["게임이 시작되었습니다. 호르무즈 해협은 평화롭습니다."];

// 예측 마켓 베팅 현황 (상대 베팅 풀 방식)
let bettingPool = {
  YES: 1, // 유가 폭등($100 돌파)에 건 총 포인트 (단, 0 나누기 방지용 기본값 1)
  NO: 1   // 유가 안정($100 미만 유지)에 건 총 포인트
};

// 유저 데이터 세션 (메모리 저장 - 실제 서비스 시 DB 연결 필요)
const players = {};

// --- 3초마다 자동으로 돌아가는 시장 경제 사이클 ---
setInterval(() => {
  // 1. 긴장도(Tension)에 비례한 유가 자연 변동 공식 (소폭의 노이즈 추가)
  const noise = (Math.random() - 0.5) * 2; // -1 ~ +1 사이 무작위 변동
  const tensionEffect = tensionLevel * 0.3; // 긴장도가 높을수록 유가 압박 상승
  
  // 유가 점진적 적용
  currentOilPrice = Math.max(40, currentOilPrice + noise + (tensionEffect * 0.1));
  
  // 자연스러운 긴장도 감소 (유저 행동이 없으면 시간이 지남에 따라 점차 진정됨)
  if (tensionLevel > 0) {
    tensionLevel = Math.max(0, tensionLevel - 0.5);
  }

  // 모든 유저에게 동기화 데이터 전송
  io.emit('marketUpdate', {
    oilPrice: currentOilPrice.toFixed(2),
    tensionLevel: Math.round(tensionLevel),
    bettingPool: bettingPool,
    news: newsHistory.slice(-5) // 최근 뉴스 5개만 전송
  });
}, 3000);

// --- 실시간 유저 소통 (Websocket) ---
io.on('connection', (socket) => {
  console.log(`유저 접속: ${socket.id}`);
  
  // 신규 유저 초기 자산 지급
  players[socket.id] = {
    balance: 10000, // 초기 자산 10,000 포인트
    currentBet: null,
    betAmount: 0
  };

  // 접속한 유저에게 본인 상태 전송
  socket.emit('initPlayer', players[socket.id]);

  // [액션 1] 지정학적 개입 (미국/이란 행동 버튼 클릭 시)
  socket.on('influence', (faction) => {
    let change = 0;
    let message = "";

    if (faction === 'US') {
      change = 8;
      tensionLevel = Math.min(100, tensionLevel + change);
      message = "📢 [미국] " + socket.id.substring(0, 5) + " 지휘관이 호르무즈 통행료 20% 관세를 추가 위협했습니다! (유가 상승 압박)";
    } else if (faction === 'IRAN') {
      change = 12;
      tensionLevel = Math.min(100, tensionLevel + change);
      message = "📢 [이란] " + socket.id.substring(0, 5) + " 지휘관이 호르무즈 해협 해상 훈련을 개시했습니다! (유가 급등 압박)";
    }

    newsHistory.push(message);
    io.emit('newsAlert', message);
  });

  // [액션 2] 예측 마켓 베팅 참여
  socket.on('placeBet', ({ type, amount }) => {
    const player = players[socket.id];
    if (!player) return;

    if (player.balance < amount || amount <= 0) {
      socket.emit('errorMsg', '잔액이 부족하거나 올바르지 않은 금액입니다.');
      return;
    }

    // 기존 베팅이 있다면 추가 누적
    player.balance -= amount;
    player.betAmount += amount;
    player.currentBet = type;

    bettingPool[type] += amount;

    socket.emit('initPlayer', player); // 유저 개별 잔액 업데이트
    io.emit('poolUpdate', bettingPool); // 전체 베팅 풀 실시간 동기화
    newsHistory.push(`🗳️ 누군가 ${type}에 ${amount} 포인트를 베팅했습니다!`);
  });

  socket.on('disconnect', () => {
    console.log(`유저 퇴장: ${socket.id}`);
    delete players[socket.id];
  });
});

// 포트 설정 (Render 배포 환경 포트 대응)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`정세 시뮬레이터 서버 기동 중... 포트: ${PORT}`);
});