const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ⚠️ 关键配置：这行代码让平台在云端也能正常运行
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.OPENWOND_API_KEY;
const MODEL_NAME = 'Nano Banana Pro';
const API_URL = 'https://image.openwond.com/v1/draw';
const REQUEST_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const MAX_LOGIN_ATTEMPTS_PER_WINDOW = 10;
const UPSTREAM_TIMEOUT_MS = 60 * 1000;
const MAX_PROMPT_LENGTH = 2_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const TRUST_PROXY_HOPS = process.env.TRUST_PROXY_HOPS;

if (!API_KEY || !APP_PASSWORD || !SESSION_SECRET) {
    throw new Error('OPENWOND_API_KEY, APP_PASSWORD, and SESSION_SECRET must be configured');
}

if (TRUST_PROXY_HOPS !== undefined) {
    if (!/^\d+$/.test(TRUST_PROXY_HOPS)) throw new Error('TRUST_PROXY_HOPS must be a non-negative integer');
    app.set('trust proxy', Number(TRUST_PROXY_HOPS));
}

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const rateLimitEntries = new Map();
let lastRateLimitCleanupAt = 0;

function rateLimit(namespace, maximumRequests) {
    return (req, res, next) => {
        const now = Date.now();
        if (now - lastRateLimitCleanupAt >= REQUEST_WINDOW_MS) {
            for (const [key, record] of rateLimitEntries) {
                if (now - record.windowStartedAt >= REQUEST_WINDOW_MS) rateLimitEntries.delete(key);
            }
            lastRateLimitCleanupAt = now;
        }
        const key = `${namespace}:${req.ip}`;
        const entry = rateLimitEntries.get(key);
        const recentRequests = !entry || now - entry.windowStartedAt >= REQUEST_WINDOW_MS
            ? { windowStartedAt: now, count: 0 }
            : entry;

        if (recentRequests.count >= maximumRequests) {
            const retryAfterSeconds = Math.ceil((REQUEST_WINDOW_MS - (now - recentRequests.windowStartedAt)) / 1000);
            res.set('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
        }

        recentRequests.count += 1;
        rateLimitEntries.set(key, recentRequests);
        return next();
    };
}

function constantTimeEquals(value, expected) {
    const valueBuffer = Buffer.from(value || '');
    const expectedBuffer = Buffer.from(expected);
    return valueBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}

function getCookie(req, name) {
    const prefix = `${name}=`;
    const value = (req.headers.cookie || '').split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(prefix));
    try {
        return value ? decodeURIComponent(value.slice(prefix.length)) : null;
    } catch {
        return null;
    }
}

function createSessionToken() {
    const payload = Buffer.from(JSON.stringify({ expiresAt: Date.now() + SESSION_TTL_MS })).toString('base64url');
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function hasValidSession(req) {
    const token = getCookie(req, 'session');
    if (!token) return false;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return false;

    const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (!constantTimeEquals(signature, expectedSignature)) return false;

    try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return Number.isFinite(session.expiresAt) && session.expiresAt > Date.now();
    } catch {
        return false;
    }
}

function requireSession(req, res, next) {
    if (!hasValidSession(req)) return res.status(401).json({ error: '请先登录' });
    return next();
}

app.post('/api/session', rateLimit('login', MAX_LOGIN_ATTEMPTS_PER_WINDOW), (req, res) => {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !constantTimeEquals(password, APP_PASSWORD)) {
        return res.status(401).json({ error: '密码错误' });
    }

    res.cookie('session', createSessionToken(), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: SESSION_TTL_MS,
        path: '/'
    });
    return res.status(204).end();
});

 // 生图接口
app.post('/api/generate', requireSession, rateLimit('generate', MAX_REQUESTS_PER_WINDOW), async (req, res) => {
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
