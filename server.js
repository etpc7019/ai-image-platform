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

        const responseData = response.data;
        
        // ✨ 先打印完整的响应，帮助我们调试
        console.log("完整的API响应:", JSON.stringify(responseData, null, 2));
        
        // ✨ 更健壮的解析逻辑
        let imageUrl;
        if (responseData && typeof responseData === 'object') {
            // 优先检查 url 字段
            if (responseData.url && typeof responseData.url === 'string') {
                imageUrl = responseData.url;
            } 
            // 其次检查 data 数组中的 url
            else if (responseData.data && Array.isArray(responseData.data) && responseData.data[0] && responseData.data[0].url) {
                imageUrl = responseData.data[0].url;
            }
            // 再检查 image_url 字段
            else if (responseData.image_url && typeof responseData.image_url === 'string') {
                imageUrl = responseData.image_url;
            }
            // 最后检查 images 数组
            else if (responseData.images && Array.isArray(responseData.images) && responseData.images[0]) {
                imageUrl = responseData.images[0];
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
