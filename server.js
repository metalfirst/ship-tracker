const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// 存储船舶数据的 Map
const shipsMap = new Map();
let shipsList = [];

// ================== aisstream.io 连接 ==================
// 从环境变量读取 API Key（Railway 中配置）
const AIS_API_KEY = process.env.AIS_API_KEY;

if (!AIS_API_KEY) {
    console.error('❌ 错误：未设置 AIS_API_KEY 环境变量');
    process.exit(1);
}

const WS_URL = 'wss://stream.aisstream.io/v0/stream';
let ws = null;

function connectAISStream() {
    console.log('正在连接 aisstream.io...');
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        console.log('WebSocket 连接已建立');
        
        const subscription = {
            Apikey: AIS_API_KEY,
            BoundingBoxes: [[[-90, -180], [90, 180]]],  // 全球范围
            FilterMessageTypes: ['PositionReport', 'ShipStaticData']
        };
        ws.send(JSON.stringify(subscription));
        console.log('已发送订阅请求');
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            const messageType = message.MessageType;
            
            if (messageType === 'PositionReport') {
                const meta = message.MetaData;
                const pos = message.Message.PositionReport;
                
                if (meta && pos && meta.MMSI) {
                    const mmsi = meta.MMSI;
                    const existing = shipsMap.get(mmsi) || {};
                    
                    shipsMap.set(mmsi, {
                        ...existing,
                        mmsi: mmsi,
                        shipName: existing.shipName || meta.ShipName || `未知 (${mmsi})`,
                        latitude: pos.Latitude,
                        longitude: pos.Longitude,
                        sog: pos.SpeedOverGround,
                        cog: pos.CourseOverGround,
                        lastUpdate: new Date().toISOString(),
                        imo: existing.imo,
                        callsign: existing.callsign
                    });
                    updateShipsList();
                }
                
            } else if (messageType === 'ShipStaticData') {
                const meta = message.MetaData;
                const staticData = message.Message.ShipStaticData;
                
                if (meta && staticData && meta.MMSI) {
                    const mmsi = meta.MMSI;
                    const existing = shipsMap.get(mmsi) || {};
                    
                    shipsMap.set(mmsi, {
                        ...existing,
                        mmsi: mmsi,
                        shipName: meta.ShipName || staticData.ShipName || existing.shipName,
                        imo: staticData.ImoNumber || existing.imo,
                        callsign: staticData.CallSign || existing.callsign,
                        shipType: staticData.Type,
                        latitude: existing.latitude,
                        longitude: existing.longitude,
                        sog: existing.sog,
                        cog: existing.cog,
                        lastUpdate: existing.lastUpdate
                    });
                    updateShipsList();
                }
            }
        } catch (err) {
            console.error('解析消息出错:', err);
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket 错误:', err);
    });

    ws.on('close', () => {
        console.log('WebSocket 连接关闭，5秒后重连...');
        setTimeout(connectAISStream, 5000);
    });
}

function updateShipsList() {
    shipsList = Array.from(shipsMap.values()).filter(ship => ship.latitude !== undefined);
    console.log(`当前船舶数: ${shipsList.length}`);
}

// ================== API 路由 ==================

// 搜索船舶（支持船名、MMSI、IMO、呼号）
app.get('/api/search', (req, res) => {
    const { q, limit = 50 } = req.query;
    
    if (!q) {
        return res.json({ ships: shipsList.slice(0, limit) });
    }
    
    const query = q.toLowerCase().trim();
    const results = shipsList.filter(ship => {
        return (ship.shipName && ship.shipName.toLowerCase().includes(query)) ||
               (ship.mmsi && ship.mmsi.toString().includes(query)) ||
               (ship.imo && ship.imo.toString().includes(query)) ||
               (ship.callsign && ship.callsign.toLowerCase().includes(query));
    });
    
    res.json({ 
        query: q,
        count: results.length,
        ships: results.slice(0, limit)
    });
});

// 获取所有船舶（限制数量避免前端卡顿）
app.get('/api/ships', (req, res) => {
    const limit = parseInt(req.query.limit) || 200;
    const ships = shipsList.slice(0, limit);
    res.json({ count: shipsList.length, displayed: ships.length, ships });
});

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        shipCount: shipsList.length,
        wsConnected: ws && ws.readyState === WebSocket.OPEN
    });
});

// 启动服务器
server.listen(PORT, () => {
    console.log(`后端服务运行在 http://localhost:${PORT}`);
    connectAISStream();
});