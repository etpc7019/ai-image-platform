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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let imageHistory = [];

 // 生图接口
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: '请输入提示词' });

    try {
        console.log(`正在请求生图: ${prompt}`);
        const response = await axios.post(API_URL, {
            model: MODEL_NAME,
            prompt: prompt,
            size: "auto",
            images: [],
            resolution: "1K"
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            }
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

        // 记录历史
        imageHistory.unshift({ id: Date.now(), prompt, imageUrl, createdAt: new Date().toLocaleString() });
        res.json({ success: true, imageUrl: imageUrl });

    } catch (error) {
        console.error('生图错误:', error.message);
        res.status(500).json({ error: '生图服务出错', details: error.message });
    }
});   

// 启动服务
app.listen(PORT, () => {
    console.log(`✅ 服务已启动，访问端口: ${PORT}`);
});
