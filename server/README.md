# 天国拯救骰子游戏 - 服务器端

## 安装

```bash
cd server
npm install
```

## 运行

```bash
npm start
```

或者使用 nodemon 进行开发（自动重启）：

```bash
npm run dev
```

服务器默认运行在端口 3001。

## 环境变量

可以通过环境变量 `PORT` 设置服务器端口：

```bash
PORT=3001 npm start
```

## 功能

- 实时多人游戏匹配
- WebSocket 连接管理
- 游戏状态同步
- 房间管理

## API

### Socket.io 事件

#### 客户端 -> 服务器

- `findMatch` - 寻找匹配
- `playerReady` - 玩家准备
- `rollDice` - 掷骰子
- `selectDice` - 选择骰子
- `keepScore` - 保留得分
- `bankScore` - 提交得分
- `bust` - 爆点

#### 服务器 -> 客户端

- `matched` - 匹配成功
- `roomReady` - 房间准备就绪
- `playerReadyUpdate` - 玩家准备状态更新
- `gameStart` - 游戏开始
- `opponentRolled` - 对手掷骰
- `opponentSelectedDice` - 对手选择骰子
- `opponentKeptScore` - 对手保留得分
- `turnChanged` - 回合切换
- `opponentBusted` - 对手爆点
- `gameEnd` - 游戏结束
- `playerLeft` - 玩家离开

