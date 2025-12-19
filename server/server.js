const express = require('express')
const http = require('http')
const socketIo = require('socket.io')
const cors = require('cors')
const path = require('path')

const app = express()
const server = http.createServer(app)
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
})

app.use(cors())
app.use(express.json())

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({
    name: '天国拯救骰子游戏 - 多人联机服务器',
    status: 'running',
    version: '1.0.0',
    rooms: rooms.size,
    waitingPlayers: waitingPlayers.length,
    timestamp: Date.now(),
    endpoints: {
      health: '/health',
      socket: 'Socket.io 连接'
    }
  })
})

// 游戏房间管理
const rooms = new Map() // roomId -> { players: [], gameState: {}, bet: {} }
const waitingPlayers = [] // 等待匹配的玩家队列
const playerSessions = new Map() // playerId -> { socketId, roomId, playerData } 用于重连恢复

// 生成房间ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

// 创建房间
function createRoom(playerId, playerData, socketId) {
  const roomId = generateRoomId()
  const room = {
    id: roomId,
    players: [{
      id: playerId,
      name: playerData.name || '玩家1',
      socketId: socketId, // 使用实际的 socket.id
      ready: false,
      diceConfig: playerData.diceConfig || Array(6).fill('ordinary')
    }],
    gameState: null, // 游戏开始后才有状态
    bet: playerData.bet,
    status: 'waiting' // waiting, playing, finished
  }
  rooms.set(roomId, room)
  
  // 保存玩家会话信息用于重连
  playerSessions.set(playerId, {
    socketId: socketId,
    roomId: roomId,
    playerData: playerData
  })
  
  return room
}

// 匹配玩家
function matchPlayers(playerId, playerData, socketId) {
  // 检查是否是重连
  const existingSession = playerSessions.get(playerId)
  if (existingSession) {
    const room = rooms.get(existingSession.roomId)
    if (room) {
      // 更新玩家的 socketId
      const player = room.players.find(p => p.id === playerId)
      if (player) {
        player.socketId = socketId
        existingSession.socketId = socketId
        console.log('玩家重连，恢复房间:', existingSession.roomId, '玩家:', playerId)
        return { room, isHost: room.players[0].id === playerId }
      }
    } else {
      // 房间不存在，清除会话
      playerSessions.delete(playerId)
    }
  }
  
  if (waitingPlayers.length === 0) {
    // 没有等待的玩家，创建新房间
    const room = createRoom(playerId, playerData, socketId)
    // 保存 roomId 到等待队列
    waitingPlayers.push({ 
      id: playerId, 
      data: playerData,
      roomId: room.id  // 保存房间ID
    })
    console.log('创建新房间等待匹配，房间ID:', room.id, '玩家:', playerId)
    return { room, isHost: true }
  } else {
    // 找到等待的玩家，加入房间
    const waitingPlayer = waitingPlayers.shift()
    const roomId = waitingPlayer.roomId
    let room = rooms.get(roomId)
    
    if (!room) {
      console.error('房间不存在，但等待队列中有玩家，房间ID:', roomId)
      // 如果房间不存在，从会话中获取 socketId 或使用当前 socketId
      const session = playerSessions.get(waitingPlayer.id)
      const waitingSocketId = session ? session.socketId : socketId
      room = createRoom(waitingPlayer.id, waitingPlayer.data, waitingSocketId)
    }
    
    console.log('第二个玩家加入房间，房间ID:', roomId, '新玩家:', playerId, '原玩家:', waitingPlayer.id)
    console.log('加入前房间玩家数:', room.players.length)
    
    // 添加第二个玩家
    room.players.push({
      id: playerId,
      name: playerData.name || '玩家2',
      socketId: socketId,
      ready: false,
      diceConfig: playerData.diceConfig || Array(6).fill('ordinary')
    })
    
    // 保存第二个玩家的会话
    playerSessions.set(playerId, {
      socketId: socketId,
      roomId: roomId,
      playerData: playerData
    })
    
    console.log('加入后房间玩家数:', room.players.length)
    console.log('房间玩家列表:', room.players.map(p => ({ id: p.socketId, name: p.name })))
    
    rooms.set(roomId, room)
    return { room, isHost: false }
  }
}

// 清理空房间
function cleanupRoom(roomId) {
  const room = rooms.get(roomId)
  if (room && room.players.length === 0) {
    rooms.delete(roomId)
  }
}

// Socket.io 连接处理
io.on('connection', (socket) => {
  console.log('玩家连接:', socket.id)

  // 创建房间
  socket.on('createRoom', (playerData) => {
    const playerId = playerData.playerId || socket.id
    console.log('玩家创建房间:', socket.id, '玩家ID:', playerId, '名称:', playerData.name || '玩家')
    
    const room = createRoom(playerId, playerData, socket.id)
    socket.join(room.id)
    
    console.log('房间创建成功，房间ID:', room.id, '玩家数:', room.players.length)
    
    // 通知玩家房间创建成功
    socket.emit('roomCreated', {
      roomId: room.id,
      isHost: true,
      players: room.players,
      bet: room.bet
    })
  })

  // 加入房间
  socket.on('joinRoom', (data) => {
    const { roomId, playerData } = data
    const playerId = playerData.playerId || socket.id
    console.log('玩家尝试加入房间:', socket.id, '房间ID:', roomId, '玩家ID:', playerId)
    
    const room = rooms.get(roomId)
    
    if (!room) {
      console.log('房间不存在:', roomId)
      socket.emit('joinRoomError', {
        message: '房间不存在，请检查房间号是否正确'
      })
      return
    }
    
    if (room.players.length >= 2) {
      console.log('房间已满:', roomId)
      socket.emit('joinRoomError', {
        message: '房间已满，无法加入'
      })
      return
    }
    
    // 检查玩家是否已在房间中（重连情况）
    const existingPlayer = room.players.find(p => p.id === playerId)
    if (existingPlayer) {
      // 重连，更新 socketId
      existingPlayer.socketId = socket.id
      const session = playerSessions.get(playerId)
      if (session) {
        session.socketId = socket.id
      }
      console.log('玩家重连，恢复房间:', roomId, '玩家:', playerId)
    } else {
      // 新玩家加入
      room.players.push({
        id: playerId,
        name: playerData.name || '玩家2',
        socketId: socket.id,
        ready: false,
        diceConfig: playerData.diceConfig || Array(6).fill('ordinary')
      })
      
      // 保存玩家会话
      playerSessions.set(playerId, {
        socketId: socket.id,
        roomId: roomId,
        playerData: playerData
      })
      
      console.log('新玩家加入房间:', roomId, '玩家:', playerId)
    }
    
    socket.join(roomId)
    
    console.log('房间玩家数:', room.players.length)
    console.log('房间玩家列表:', room.players.map(p => ({ id: p.socketId, name: p.name })))
    
    // 通知所有玩家房间状态更新
    io.to(roomId).emit('roomJoined', {
      roomId: roomId,
      players: room.players,
      bet: room.bet
    })
    
    // 如果房间已满，通知所有玩家
    if (room.players.length === 2) {
      console.log('✅ 房间已满，通知所有玩家，房间ID:', roomId)
      io.to(roomId).emit('roomReady', {
        roomId: roomId,
        players: room.players,
        bet: room.bet
      })
    }
  })

  // 玩家准备
  socket.on('playerReady', (data) => {
    const { roomId } = data
    const room = rooms.get(roomId)
    
    console.log('收到准备信号，房间ID:', roomId, '玩家ID:', socket.id)
    
    if (!room) {
      console.error('房间不存在:', roomId)
      return
    }
    
    const player = room.players.find(p => p.socketId === socket.id)
    if (!player) {
      console.error('玩家不在房间中:', socket.id, '房间玩家:', room.players.map(p => p.socketId))
      return
    }
    
    player.ready = true
    console.log('玩家已准备:', player.name, 'Socket ID:', socket.id)
    console.log('房间玩家状态:', room.players.map(p => ({ name: p.name, ready: p.ready, socketId: p.socketId })))
    
    // 检查是否所有玩家都准备好了
    const allReady = room.players.every(p => p.ready)
    const playerCount = room.players.length
    
    console.log('准备检查 - 所有玩家准备好:', allReady, '玩家数量:', playerCount)
    
    if (allReady && playerCount === 2) {
      // 初始化游戏状态
      room.gameState = {
        currentTurn: 0, // 0 = 玩家1, 1 = 玩家2
        playerScores: [0, 0],
        turnScores: [0, 0],
        dice: [[], []], // 每个玩家的骰子
        gameStarted: true
      }
      room.status = 'playing'
      
      console.log('✅ 游戏开始，房间:', roomId)
      console.log('玩家列表:', room.players.map(p => ({ id: p.socketId, name: p.name, index: room.players.indexOf(p) })))
      console.log('当前回合:', room.gameState.currentTurn)
      console.log('发送 gameStart 事件到房间:', roomId)
      
      // 通知游戏开始
      io.to(roomId).emit('gameStart', {
        roomId: roomId,
        gameState: room.gameState,
        players: room.players
      })
      
      console.log('gameStart 事件已发送')
    } else {
      console.log('等待更多玩家准备...', { allReady, playerCount })
      // 通知玩家准备状态
      io.to(roomId).emit('playerReadyUpdate', {
        players: room.players
      })
    }
  })

  // 玩家掷骰子
  socket.on('rollDice', (data) => {
    const { roomId, diceValues, diceTypes } = data
    const room = rooms.get(roomId)
    
    if (room && room.gameState) {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id)
      
      if (playerIndex === room.gameState.currentTurn) {
        // 更新游戏状态
        room.gameState.dice[playerIndex] = diceValues.map((value, i) => ({
          value: value,
          diceType: diceTypes[i] || 'ordinary',
          selected: false,
          kept: false
        }))
        
        // 广播给房间内所有玩家
        socket.to(roomId).emit('opponentRolled', {
          dice: room.gameState.dice[playerIndex],
          playerIndex: playerIndex
        })
      }
    }
  })

  // 玩家选择骰子
  socket.on('selectDice', (data) => {
    const { roomId, selectedIndices } = data
    const room = rooms.get(roomId)
    
    if (room && room.gameState) {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id)
      
      if (playerIndex === room.gameState.currentTurn) {
        // 更新骰子选择状态
        room.gameState.dice[playerIndex].forEach((die, i) => {
          die.selected = selectedIndices.includes(i)
        })
        
        // 广播给对手
        socket.to(roomId).emit('opponentSelectedDice', {
          dice: room.gameState.dice[playerIndex],
          playerIndex: playerIndex
        })
      }
    }
  })

  // 玩家保留得分
  socket.on('keepScore', (data) => {
    const { roomId, score } = data
    const room = rooms.get(roomId)
    
    if (room && room.gameState) {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id)
      
      if (playerIndex === room.gameState.currentTurn) {
        room.gameState.turnScores[playerIndex] += score
        
        // 广播给对手
        socket.to(roomId).emit('opponentKeptScore', {
          turnScore: room.gameState.turnScores[playerIndex],
          playerIndex: playerIndex
        })
      }
    }
  })

  // 玩家提交得分
  socket.on('bankScore', (data) => {
    const { roomId, score } = data
    const room = rooms.get(roomId)
    
    if (room && room.gameState) {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id)
      
      if (playerIndex === room.gameState.currentTurn) {
        room.gameState.playerScores[playerIndex] += room.gameState.turnScores[playerIndex] + score
        room.gameState.turnScores[playerIndex] = 0
        
        // 检查是否获胜
        const targetScore = room.bet.targetScore || 4000
        const won = room.gameState.playerScores[playerIndex] >= targetScore
        
        if (won) {
          // 游戏结束
          room.status = 'finished'
          io.to(roomId).emit('gameEnd', {
            winner: playerIndex,
            scores: room.gameState.playerScores
          })
        } else {
          // 切换到下一个玩家
          room.gameState.currentTurn = (room.gameState.currentTurn + 1) % 2
          room.gameState.dice[playerIndex] = []
          
          // 通知回合切换
          io.to(roomId).emit('turnChanged', {
            currentTurn: room.gameState.currentTurn,
            scores: room.gameState.playerScores
          })
        }
      }
    }
  })

  // 玩家爆点
  socket.on('bust', (data) => {
    const { roomId } = data
    const room = rooms.get(roomId)
    
    if (room && room.gameState) {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id)
      
      if (playerIndex === room.gameState.currentTurn) {
        room.gameState.turnScores[playerIndex] = 0
        
        // 切换到下一个玩家
        room.gameState.currentTurn = (room.gameState.currentTurn + 1) % 2
        room.gameState.dice[playerIndex] = []
        
        // 通知对手
        socket.to(roomId).emit('opponentBusted', {
          currentTurn: room.gameState.currentTurn
        })
      }
    }
  })

  // 断开连接
  socket.on('disconnect', (reason) => {
    console.log('玩家断开连接:', socket.id, '原因:', reason)
    
    // 查找玩家的房间
    let playerFound = false
    for (const [roomId, room] of rooms.entries()) {
      const player = room.players.find(p => p.socketId === socket.id)
      if (player) {
        playerFound = true
        console.log('找到玩家房间:', roomId, '玩家:', player.name)
        
        // 如果是正常关闭（客户端关闭页面），立即移除
        // 如果是网络问题（transport close），等待重连
        if (reason === 'transport close' || reason === 'ping timeout') {
          // 网络问题，等待重连（不立即移除）
          console.log('网络断开，等待重连，玩家:', player.name)
          // 通知对手玩家暂时断开
          socket.to(roomId).emit('playerDisconnected', {
            message: `${player.name} 暂时断开连接，等待重连...`
          })
        } else {
          // 正常断开，移除玩家
          console.log('正常断开，移除玩家:', player.name)
          room.players.splice(room.players.indexOf(player), 1)
          
          // 清除会话
          playerSessions.delete(player.id)
          
          // 通知对手玩家离开
          socket.to(roomId).emit('playerLeft', {
            message: '对手已离开游戏'
          })
          
          // 清理房间
          cleanupRoom(roomId)
        }
        break
      }
    }
    
    // 从等待队列中移除（使用 socket.id 匹配）
    const waitingIndex = waitingPlayers.findIndex(p => {
      const session = playerSessions.get(p.id)
      return session && session.socketId === socket.id
    })
    if (waitingIndex !== -1) {
      const waitingPlayer = waitingPlayers[waitingIndex]
      playerSessions.delete(waitingPlayer.id)
      waitingPlayers.splice(waitingIndex, 1)
      console.log('从等待队列移除:', waitingPlayer.id)
    }
  })
})

const PORT = process.env.PORT || 3001

server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`)
})

