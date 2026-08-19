const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();

// ⚠️ 关键配置：这行代码让平台在云端也能正常运行
const PORT = process.env.PORT || 3000;

// ⚠️ API Key 配置：优先使用云端环境变量，如果没有则使用下面的默认值
const API_KEY = process.env.OPENWOND_API_KEY || 'sk-open-a94a155c7e8e40118239ec0461f7480fca52b696aef245fda9127f5274e7847b';
const MODEL_NAME = 'Nano Banana Pro';
const API_URL = 'https://image.openwond.com/v1/draw';
const CLIENT_API_KEY = process.env.GENERATE_API_KEY;
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const REQUEST_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const UPSTREAM_TIMEOUT_MS = 60 * 1000;
const MAX_PROMPT_LENGTH = 2_000;

if (!CLIENT_API_KEY) {
    throw new Error('GENERATE_API_KEY must be configured');
}

app.use(cors({
    origin(origin, callback) {
        // Requests without an Origin header are same-origin or non-browser clients.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
    }
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const requestCounts = new Map();
let lastRateLimitCleanupAt = 0;

function protectGenerateEndpoint(req, res, next) {
    if (req.get('X-API-Key') !== CLIENT_API_KEY) {
        return res.status(401).json({ error: '未授权' });
    }

    const now = Date.now();
    if (now - lastRateLimitCleanupAt >= REQUEST_WINDOW_MS) {
        for (const [ip, record] of requestCounts) {
            if (now - record.windowStartedAt >= REQUEST_WINDOW_MS) requestCounts.delete(ip);
        }
        lastRateLimitCleanupAt = now;
    }
    const clientId = req.ip;
    const entry = requestCounts.get(clientId);
    const recentRequests = !entry || now - entry.windowStartedAt >= REQUEST_WINDOW_MS
        ? { windowStartedAt: now, count: 0 }
        : entry;

    if (recentRequests.count >= MAX_REQUESTS_PER_WINDOW) {
        const retryAfterSeconds = Math.ceil((REQUEST_WINDOW_MS - (now - recentRequests.windowStartedAt)) / 1000);
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }

    recentRequests.count += 1;
    requestCounts.set(clientId, recentRequests);
    return next();
}

 // 生图接口
app.post('/api/generate', protectGenerateEndpoint, async (req, res) => {
    const { prompt } = req.body || {};
    if (typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: '请输入提示词' });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
        return res.status(400).json({ error: `提示词不能超过 ${MAX_PROMPT_LENGTH} 个字符` });
    }
    const sanitizedPrompt = prompt.trim();

    try {
        console.log('正在请求生图');
        const response = await axios.post(API_URL, {
            model: MODEL_NAME,
            prompt: sanitizedPrompt,
            size: "auto",
            images: [],
            resolution: "1K"
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            timeout: UPSTREAM_TIMEOUT_MS
        });

        let responseData = response.data;
        
        // ✨ 确保responseData是对象，如果不是，尝试解析为JSON
        if (typeof responseData === 'string') {
            try {
                responseData = JSON.parse(responseData);
            } catch (e) {
                console.error("无法将响应解析为JSON:", e.message);
                return res.status(500).json({ error: '响应格式错误' });
            }
        }

        // ✨ 更健壮的解析逻辑，覆盖所有可能的url字段位置
        let imageUrl;
        if (responseData && typeof responseData === 'object') {
            // 检查直接url字段（优先级最高）
            if (responseData.url && typeof responseData.url === 'string') {
                imageUrl = responseData.url;
            } 
            // 检查data对象中的url（data可能是对象）
            else if (responseData.data && typeof responseData.data === 'object' && responseData.data.url) {
                imageUrl = responseData.data.url;
            }
            // 检查data数组中的url（data可能是数组）
            else if (responseData.data && Array.isArray(responseData.data) && responseData.data[0] && responseData.data[0].url) {
                imageUrl = responseData.data[0].url;
            }
            // 检查image_url字段
            else if (responseData.image_url && typeof responseData.image_url === 'string') {
                imageUrl = responseData.image_url;
            }
            // 检查images数组（可能是数组形式）
            else if (responseData.images && Array.isArray(responseData.images) && responseData.images[0]) {
                imageUrl = responseData.images[0];
            }
            // 检查result字段（某些API可能使用此字段）
            else if (responseData.result && typeof responseData.result === 'string') {
                imageUrl = responseData.result;
            }
        }

        if (!imageUrl) {
            console.error("解析失败: 无法从响应中提取图片URL", responseData);
            return res.status(500).json({ error: '图片地址解析失败' });
        }

        res.json({ success: true, imageUrl: imageUrl });

    } catch (error) {
        console.error('生图错误:', error.message);
        res.status(502).json({ error: '生图服务暂时不可用，请稍后重试' });
    }
});   

// 启动服务
app.listen(PORT, () => {
    console.log(`✅ 服务已启动，访问端口: ${PORT}`);
});
