const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// 임시 디렉토리 서빙용 (public 폴더가 없을 경우 루트에서 index.html 제공)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 게임 데이터 상태 관리
let players = {};
let oilPrice = 70.00; // 배럴당 시작가 (달러)
let priceHistory = [70.00];

// 배당률 및 베팅 시스템 데이터
let totalBets = { UP: 0, DOWN: 0 };
let leverageBets = { UP: {}, DOWN: {} }; // 레버리지 베팅 유저 기록

// 가격 변동 함수 (매 5초마다 변동)
setInterval(() => {
    const change = (Math.random() * 4 - 2).toFixed(2); // -2$ ~ +2$ 변동
    const previousPrice = oilPrice;
    oilPrice = parseFloat((oilPrice + parseFloat(change)).toFixed(2));
    if (oilPrice < 10) oilPrice = 10; // 최소 가격 제한

    priceHistory.push(oilPrice);
    if (priceHistory.length > 20) priceHistory.shift();

    // 방향 확인 (UP 또는 DOWN)
    const direction = oilPrice > previousPrice ? "UP" : "DOWN";

    // 1. 일반 베팅 정산 처리
    let totalWinBets = direction === "UP" ? totalBets.UP : totalBets.DOWN;
    let totalLoseBets = direction === "UP" ? totalBets.DOWN : totalBets.UP;
    
    // 배당금 지급 비율 계산
    let dividendRate = 1.9; // 기본 배당률
    if (totalWinBets > 0 && totalLoseBets > 0) {
        dividendRate = parseFloat((1 + (totalLoseBets / totalWinBets) * 0.9).toFixed(2));
    }

    // 2. 레버리지(3배) 정산 처리
    const priceChangePercent = ((oilPrice - previousPrice) / previousPrice); // 가격 변동률

    // 각 플레이어별 자산 정산
    Object.keys(players).forEach(id => {
        let p = players[id];
        let balanceChanged = false;

        // 일반 베팅 정산
        if (p.currentBet && p.currentBet.type === direction) {
            const reward = Math.floor(p.currentBet.amount * dividendRate);
            p.points += reward;
            p.lastResult = `성공! +${reward}포인트 수령 (배당률: ${dividendRate}x)`;
            balanceChanged = true;
        } else if (p.currentBet) {
            p.lastResult = `실패... -${p.currentBet.amount}포인트 손실`;
            balanceChanged = true;
        }

        // 레버리지(3배) 베팅 정산
        if (p.leverageBet) {
            const leverage = p.leverageBet.leverage; // 3
            const betAmount = p.leverageBet.amount;
            let profitPercent = priceChangePercent * leverage; // 변동률 * 3

            if (p.leverageBet.type === "DOWN") {
                profitPercent = -profitPercent; // 숏(DOWN)은 가격이 떨어져야 이득
            }

            const profitOrLoss = Math.floor(betAmount * profitPercent);
            p.points += profitOrLoss;

            if (p.points <= 0) {
                p.points = 0; // 파산 처리
                p.lastResult = `💥 레버리지 마진콜 발생! (청산 완료)`;
            } else {
                p.lastResult = `레버리지(${leverage}x) 결과: ${profitOrLoss >= 0 ? '+' : ''}${profitOrLoss}포인트 반영`;
            }
            p.leverageBet = null; // 레버리지 베팅 초기화
            balanceChanged = true;
        }

        if (balanceChanged) {
            p.currentBet = null; // 일반 베팅 초기화
            io.to(id).emit('updateBalance', { points: p.points, lastResult: p.lastResult });
        }
    });

    // 베팅 판 초기화 및 배당률 재계산
    totalBets = { UP: 0, DOWN: 0 };
    const rates = calculateOdds();

    io.emit('priceUpdate', { 
        price: oilPrice, 
        history: priceHistory,
        rates: rates
    });
}, 5000);

// 실시간 배당률 계산 함수
function calculateOdds() {
    const total = totalBets.UP + totalBets.DOWN;
    if (total === 0) return { UP: 1.9, DOWN: 1.9 };

    const upRate = totalBets.UP > 0 ? (1 + (totalBets.DOWN / totalBets.UP) * 0.9).toFixed(2) : 1.9;
    const downRate = totalBets.DOWN > 0 ? (1 + (totalBets.UP / totalBets.DOWN) * 0.9).toFixed(2) : 1.9;

    return {
        UP: parseFloat(upRate),
        DOWN: parseFloat(downRate)
    };
}

io.on('connection', (socket) => {
    console.log(`유저 접속: ${socket.id}`);

    // 새 유저 등록
    players[socket.id] = {
        points: 10000, // 시작 포인트
        currentBet: null,
        leverageBet: null,
        lastResult: ''
    };

    // 최초 접속 시 기본 데이터 전송
    socket.emit('init', {
        price: oilPrice,
        points: players[socket.id].points,
        history: priceHistory,
        rates: calculateOdds()
    });

    // 일반 베팅 신청 수신
    socket.on('placeBet', (data) => {
        const p = players[socket.id];
        if (!p || p.points < data.amount || p.currentBet || p.leverageBet) return;

        p.points -= data.amount;
        p.currentBet = { type: data.type, amount: data.amount };
        
        if (data.type === 'UP') totalBets.UP += data.amount;
        if (data.type === 'DOWN') totalBets.DOWN += data.amount;

        socket.emit('updateBalance', { points: p.points, lastResult: '베팅 완료! 다음 가격 변동을 기다리는 중...' });
        io.emit('betUpdate', calculateOdds()); // 전체 유저에게 실시간 배당률 갱신
    });

    // 레버리지(3배) 베팅 신청 수신
    socket.on('placeLeverageBet', (data) => {
        const p = players[socket.id];
        if (!p || p.points < data.amount || p.currentBet || p.leverageBet) return;

        p.points -= data.amount;
        p.leverageBet = { type: data.type, amount: data.amount, leverage: 3 };

        socket.emit('updateBalance', { points: p.points, lastResult: '3배 마진 거래 시작! 다음 가격 변동 감시 중...' });
    });

    socket.on('disconnect', () => {
        console.log(`유저 퇴장: ${socket.id}`);
        delete players[socket.id];
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`정유 시뮬레이터 서버 기동 중... 포트: ${PORT}`);
});