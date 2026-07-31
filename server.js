const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase 클라이언트
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // index.html 서빙

// ── 리더보드 조회 (상위 20개)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leaderboard')
      .select('id, name, score, level, created_at')
      .order('score', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 점수 등록
app.post('/api/leaderboard', async (req, res) => {
  try {
    const { name, score, level } = req.body;
    if (!name || score == null || level == null)
      return res.status(400).json({ error: '필수값 누락' });
    if (typeof score !== 'number' || score < 0 || score > 9999999)
      return res.status(400).json({ error: '유효하지 않은 점수' });

    const cleanName = String(name).trim().slice(0, 12) || '익명';

    const { data, error } = await supabase
      .from('leaderboard')
      .insert({ name: cleanName, score, level })
      .select()
      .single();
    if (error) throw error;

    // 등록 후 순위 계산
    const { count } = await supabase
      .from('leaderboard')
      .select('*', { count: 'exact', head: true })
      .gt('score', score);

    res.json({ entry: data, rank: (count || 0) + 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`서버 실행 중 port ${PORT}`));
