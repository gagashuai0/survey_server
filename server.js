require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
let config = {};
try {
  config = require('./env');
} catch (err) {
  console.warn('⚠️ env.js 未找到，将使用内置默认配置（建议按 env.example.js 创建）');
}

const app = express();
app.use(express.json());
app.use(cors());
const PORT = Number(process.env.PORT || config.PORT || 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || config.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || config.ADMIN_PASSWORD || 'admin123456';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || config.ADMIN_JWT_SECRET || 'survey-admin-secret';
const ADMIN_TOKEN_EXPIRES_IN = process.env.ADMIN_TOKEN_EXPIRES_IN || '12h';

// === MongoDB 连接 ===
const MONGO_URI = process.env.MONGO_URI || config.MONGO_URI || 'mongodb://127.0.0.1:27017/survey_app';
const DB_NAME = process.env.MONGO_DB_NAME || config.MONGO_DB_NAME || undefined;

mongoose.connect(MONGO_URI, {
    dbName: DB_NAME,
    serverSelectionTimeoutMS: 5000,
  })
    .then(() => console.log(`✅ MongoDB connected: ${mongoose.connection.name}`))
    .catch(err => console.error(err));

// === 定义数据模型 ===
const responseSchema = new mongoose.Schema({
    wx_id: String,
    user_info: Object,
    answers: [{ questionId: Number, answer: String }],
    duration: Number,
    current_question: Number,
    score: Number,
    status: { type: String, default: 'in-progress' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});
const Response = mongoose.model('Response', responseSchema);

const maskMongoUri = (uri) => uri.replace(/\/\/([^:/]+):([^@]+)@/, '//$1:***@');

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toDurationSeconds = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(Math.floor(parsed), 0);
};

const pickResponsePayload = (body = {}) => {
  const payload = {};

  if (body.wx_id !== undefined) payload.wx_id = body.wx_id;
  if (body.user_info !== undefined) payload.user_info = body.user_info;
  if (body.answers !== undefined) payload.answers = Array.isArray(body.answers) ? body.answers : [];
  if (body.duration !== undefined) payload.duration = toDurationSeconds(body.duration, 0);
  if (body.current_question !== undefined) payload.current_question = toNumber(body.current_question, 1);
  if (body.score !== undefined) payload.score = toNumber(body.score, 0);
  if (body.status !== undefined) payload.status = body.status;
  if (body.createdAt !== undefined) payload.createdAt = body.createdAt;

  payload.updatedAt = new Date();
  return payload;
};

const getBearerToken = (req) => {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) return '';
  return authorization.slice(7).trim();
};

const requireAdminAuth = (req, res, next) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: '未登录或登录已过期', code: 'UNAUTHORIZED' });
  }

  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    req.adminUser = { username: payload.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: '登录凭证无效，请重新登录', code: 'UNAUTHORIZED' });
  }
};

// === 路由 ===
app.get('/api/get-user-history', async (req, res) => {
    const { wx_id } = req.query;
    if (!wx_id) return res.status(400).json({ error: 'wx_id required' });

    const history = await Response.find({ wx_id })
        .sort({ createdAt: -1 })
        .select('_id createdAt score duration status');

    res.json({ data: history });
});

app.get('/api/get-history-detail', async (req, res) => {
    const { record_id } = req.query;
    if (!record_id) return res.status(400).json({ error: 'record_id required' });

    const record = await Response.findById(record_id);
    if (!record) return res.status(404).json({ error: 'not found' });

    res.json({ data: record });
});

app.get('/api/getOpenid', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'code required' });

    try {
        const wxResp = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
            params: {
                appid: config.appid,
                secret: config.secret,
                js_code: code,
                grant_type: 'authorization_code'
            }
        });
        if (wxResp.data.errcode) {
            return res.status(400).json({ error: wxResp.data });
        }
        res.json({
            openid: wxResp.data.openid,
            session_key: wxResp.data.session_key
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to get openid' });
    }
});

app.post('/api/save-progress', async (req, res) => {
  try {
    const { record_id, wx_id, user_info, answers, duration, current_question } = req.body;
    if (!wx_id) return res.status(400).json({ error: 'wx_id required' });

    let record = null;

    if (record_id) {
      // 精确更新指定草稿
      record = await Response.findOne({ _id: record_id, wx_id });
      if (!record) return res.status(404).json({ error: 'draft not found' });
      if (record.status !== 'in-progress') {
        return res.status(400).json({ error: 'draft already submitted' });
      }

      record.answers = answers ?? record.answers;
      if (duration !== undefined) record.duration = toDurationSeconds(duration, record.duration || 0);
      record.current_question = current_question ?? record.current_question;
      record.user_info = user_info ?? record.user_info;
      record.updatedAt = new Date();
      await record.save();
    } else {
      // 老逻辑：找“最新”的 in-progress，没有就新建
      record = await Response.findOne({ wx_id, status: 'in-progress' }).sort({ updatedAt: -1 });
      if (record) {
        record.answers = answers ?? record.answers;
        if (duration !== undefined) record.duration = toDurationSeconds(duration, record.duration || 0);
        record.current_question = current_question ?? record.current_question;
        record.user_info = user_info ?? record.user_info;
        record.updatedAt = new Date();
        await record.save();
      } else {
        record = await Response.create({
          wx_id,
          user_info,
          answers,
          duration: toDurationSeconds(duration, 0),
          current_question,
          status: 'in-progress',
          updatedAt: new Date(),
        });
      }
    }

    // 可选兜底：只保留“最新一条”草稿，清理其它残留
    // await Response.deleteMany({ wx_id, status: 'in-progress', _id: { $ne: record._id } });

    res.json({ success: true, data: record });
  } catch (err) {
    console.error("💥 保存答题进度出错:", err);
    res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

app.get('/api/get-latest-in-progress', async (req, res) => {
    const { wx_id } = req.query;
    if (!wx_id) return res.status(400).json({ error: 'wx_id required' });

    const record = await Response.findOne({ wx_id, status: 'in-progress' });
    res.json({ data: record });
});

app.post('/api/submit', async (req, res) => {
  const { record_id, wx_id, user_info, answers, duration } = req.body;
  if (!wx_id || !answers) return res.status(400).json({ error: 'wx_id 和 answers 必填' });

  // === 计算分数（保持你的原逻辑）===
  const answerMap = {};
  answers.forEach(a => answerMap[a.questionId] = a.answer);
  const has = (qid, vals) => vals.includes(answerMap[qid]);
  const and = (...conds) => conds.every(Boolean);
  const or = (...conds) => conds.some(Boolean);

  let score = 0;
  if (has(1, ["从不","偶尔，少于每周1天","每周1-3天"]) || has(2, ["从不","偶尔，少于每周1天","每周1-3天"]) || has(3, ["吸烟，每天9支以内","吸烟，每天10支以上"]) || has(4, ["经常，每月3次以上","频繁，几乎每天都喝"])) score++;
  if (has(5, ["2-4种","5种及以上"])) score++;
  if (has(6, ["5种及以上"])) score++;
  if (has(32, ["有些困难","比较困难","无法完成"]) || has(35, ["有些困难","比较困难","无法完成"])) score++;
  if (has(31, ["偶尔需要","有时需要","总是需要"]) || has(32, ["有些困难","比较困难","无法完成"])) score++;
  if (has(25, ["有时","总是"])) score++;
  if (has(26, ["有时","总是"])) score++;
  if (has(7, ["有困难"])) score++;
  if (has(8, ["不能听清"])) score++;
  if (has(9, ["有时","总是"])) score++;
  if (and(has(10, ["有几天"]), has(11, ["有几天"])) || has(10, ["一半以上的时间","几乎每天"]) || has(11, ["一半以上的时间","几乎每天"])) score++;
  if (and(has(12, ["有几天"]), has(13, ["有几天"])) || has(12, ["一半以上的时间","几乎每天"]) || has(13, ["一半以上的时间","几乎每天"])) score++;
  if (has(15, ["较差","很差"])) score++;
  if (has(19, ["是"])) score++;
  if (has(37, ["是"]) || has(38, ["不满意"])) score++;
  if (has(20, ["没有人","1-2人"])) score++;
  if (has(21, ["否"])) score++;
  if (has(16, ["是"])) score++;
  if (has(17, ["有困扰"])) score++;
  if (has(18, ["是"])) score++;
  if (has(34, ["是"])) score++;
  if (has(22, ["偶尔","有时","总是"])) score++;
  if (has(23, ["有时","总是"])) score++;
  if (has(24, ["是"])) score++;
  if (has(27, ["有","一直食量较小，最近无明显变化"]) || has(28, ["有"])) score++;
  if (has(29, ["手指圈刚好能闭合","手指圈能轻松闭合且留有空隙"])) score++;
  if (has(6, ["5种及以上"]) || has(14, ["是"]) || has(32, ["比较困难","无法完成"])) score++;
  if (has(30, ["是"])) score++;
  if (has(33, ["是"])) score++;
  if (has(36, ["较差","很差"])) score++;

  try {
    let record;

    if (record_id) {
      // ✅ 精确把这条草稿提交为 completed
      record = await Response.findOne({ _id: record_id, wx_id });
      if (!record) return res.status(404).json({ error: 'draft not found' });

      record.answers = answers;
      record.duration = toDurationSeconds(duration, 0);
      record.current_question = 38;
      record.score = score;
      record.status = 'completed';
      record.user_info = user_info || {};
      record.updatedAt = new Date();
      await record.save();
    } else {
      // 维持旧逻辑：找最新草稿，否则新建
      record = await Response.findOne({ wx_id, status: 'in-progress' }).sort({ updatedAt: -1 });
      if (record) {
        record.answers = answers;
        record.duration = toDurationSeconds(duration, 0);
        record.current_question = 38;
        record.score = score;
        record.status = 'completed';
        record.user_info = user_info || {};
        record.updatedAt = new Date();
        await record.save();
      } else {
        record = await Response.create({
          wx_id,
          user_info: user_info || {},
          answers,
          duration: toDurationSeconds(duration, 0),
          current_question: 38,
          score,
          status: 'completed',
          updatedAt: new Date()
        });
      }
    }

    // ✅ 提交成功后，清理所有其它 in-progress 残留
    await Response.deleteMany({ wx_id, status: 'in-progress' });

    res.json({ success: true, score, record_id: record._id });
  } catch (err) {
    console.error("💥 提交出错:", err);
    res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

// === 管理后台 CRUD 接口 ===
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码必填' });
  }

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '用户名或密码错误', code: 'UNAUTHORIZED' });
  }

  const token = jwt.sign({ username }, ADMIN_JWT_SECRET, {
    expiresIn: ADMIN_TOKEN_EXPIRES_IN,
  });

  res.json({
    data: {
      token,
      username,
      expiresIn: ADMIN_TOKEN_EXPIRES_IN,
    },
  });
});

app.use('/api/admin', requireAdminAuth);

app.get('/api/admin/me', (req, res) => {
  res.json({
    data: {
      username: req.adminUser?.username || ADMIN_USERNAME,
    },
  });
});

app.get('/api/admin/responses', async (req, res) => {
  try {
    const {
      page = 1,
      pageSize = 10,
      wx_id,
      status,
      startAt,
      endAt,
    } = req.query;

    const p = Math.max(toNumber(page, 1), 1);
    const ps = Math.max(toNumber(pageSize, 10), 1);

    const filter = {};
    if (wx_id) filter.wx_id = String(wx_id).trim();
    if (status) filter.status = String(status).trim();

    if (startAt || endAt) {
      filter.createdAt = {};
      if (startAt) filter.createdAt.$gte = new Date(startAt);
      if (endAt) filter.createdAt.$lte = new Date(endAt);
    }

    const [list, total] = await Promise.all([
      Response.find(filter)
        .sort({ createdAt: -1 })
        .skip((p - 1) * ps)
        .limit(ps),
      Response.countDocuments(filter),
    ]);

    res.json({
      data: {
        list,
        total,
        page: p,
        pageSize: ps,
      },
    });
  } catch (err) {
    console.error('💥 获取管理列表失败:', err);
    res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

app.post('/api/admin/responses', async (req, res) => {
  res.status(405).json({ error: '新增记录功能已关闭' });
});

app.put('/api/admin/responses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const payload = pickResponsePayload(req.body);
    const updated = await Response.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({ error: 'not found' });
    }

    res.json({ data: updated });
  } catch (err) {
    console.error('💥 管理更新失败:', err);
    res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

app.delete('/api/admin/responses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const deleted = await Response.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ error: 'not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('💥 管理删除失败:', err);
    res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

app.get('/api/admin/db-diagnostics', async (_req, res) => {
  try {
    const [responsesCount, inProgressCount, completedCount, latest] = await Promise.all([
      Response.countDocuments({}),
      Response.countDocuments({ status: 'in-progress' }),
      Response.countDocuments({ status: 'completed' }),
      Response.findOne({}).sort({ createdAt: -1 }).select('_id wx_id status createdAt updatedAt'),
    ]);

    res.json({
      data: {
        mongoUri: maskMongoUri(MONGO_URI),
        dbName: mongoose.connection.name,
        counts: {
          responses: responsesCount,
          inProgress: inProgressCount,
          completed: completedCount,
        },
        latest,
      },
    });
  } catch (err) {
    console.error('💥 诊断接口失败:', err);
    res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

// === 启动 HTTP 服务 ===
app.listen(PORT, () => {
    console.log(`🚀 HTTP server listening on port ${PORT}, mongo=${maskMongoUri(MONGO_URI)}`);
});
