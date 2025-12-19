# 部署到 Render 指南

## 准备工作

1. 确保 `server/` 目录包含所有必要文件：
   - `server.js`
   - `package.json`
   - `README.md`

## 部署步骤

### 1. 创建 Render 服务

1. 登录 [Render](https://render.com)
2. 点击 "New +" → "Web Service"
3. 连接你的 GitHub 仓库

### 2. 配置服务

- **Name**: `kcd-dice-server` (或你喜欢的名称)
- **Environment**: `Node`
- **Root Directory**: `server` (重要！)
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Plan**: 选择免费或付费计划

### 3. 环境变量（可选）

如果需要自定义端口，可以添加环境变量：
- `PORT`: 服务器端口（Render 会自动设置，通常不需要）

### 4. 部署

点击 "Create Web Service"，Render 会自动：
1. 克隆仓库
2. 安装依赖
3. 启动服务器

### 5. 获取服务器地址

部署完成后，Render 会提供一个 URL，例如：
- `https://your-service.onrender.com`

### 6. 更新客户端配置

在 `src/components/OnlineGame.jsx` 中更新 `SERVER_URL`：
```javascript
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'https://your-service.onrender.com'
```

## 注意事项

1. **免费计划限制**：
   - 服务在 15 分钟无活动后会休眠
   - 首次访问需要几秒钟唤醒
   - 每月有使用时间限制

2. **健康检查**：
   - 服务器已包含 `/health` 端点
   - Render 会自动使用此端点进行健康检查

3. **WebSocket 支持**：
   - Render 免费计划支持 WebSocket
   - Socket.io 会自动处理连接

4. **日志**：
   - 在 Render 控制台可以查看服务器日志
   - 有助于调试连接问题

## 测试

部署后，访问：
- `https://your-service.onrender.com/health`

应该看到类似以下响应：
```json
{
  "name": "天国拯救骰子游戏 - 多人联机服务器",
  "status": "running",
  "version": "1.0.0",
  "rooms": 0,
  "waitingPlayers": 0,
  "timestamp": 1234567890,
  "endpoints": {
    "health": "/health",
    "socket": "Socket.io 连接"
  }
}
```

