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

// 生成房间ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

// 创建房间
function createRoom(playerId, playerData) {
  const roomId = generateRoomId()
  const room = {
    id: roomId,
    players: [{
      id: playerId,
      name: playerData.name || '玩家1',
      socketId: playerId,
      ready: false,
      diceConfig: playerData.diceConfig || Array(6).fill('ordinary')
    }],
    gameState: null, // 游戏开始后才有状态
    bet: playerData.bet,
    status: 'waiting' // waiting, playing, finished
  }
  rooms.set(roomId, room)
  return room
}

// 匹配玩家
function matchPlayers(playerId, playerData) {
  if (waitingPlayers.length === 0) {
    // 没有等待的玩家，创建新房间
    const room = createRoom(playerId, playerData)
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
      // 如果房间不存在，创建新房间（这种情况不应该发生）
      room = createRoom(waitingPlayer.id, waitingPlayer.data)
    }
    
    console.log('第二个玩家加入房间，房间ID:', roomId, '新玩家:', playerId, '原玩家:', waitingPlayer.id)
    console.log('加入前房间玩家数:', room.players.length)
    
    // 添加第二个玩家
    room.players.push({
      id: playerId,
      name: playerData.name || '玩家2',
      socketId: playerId,
      ready: false,
      diceConfig: playerData.diceConfig || Array(6).fill('ordinary')
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

  // 加入匹配队列
  socket.on('findMatch', (playerData) => {
    console.log('玩家寻找匹配:', socket.id, playerData.name || '玩家')
    console.log('当前等待队列长度:', waitingPlayers.length)
    
    const { room, isHost } = matchPlayers(socket.id, playerData)
    socket.join(room.id)
    
    console.log('玩家加入房间:', room.id, '是房主:', isHost, '房间玩家数:', room.players.length)
    console.log('房间玩家列表:', room.players.map(p => ({ id: p.socketId, name: p.name })))
    
    // 通知玩家加入房间
    socket.emit('matched', {
      roomId: room.id,
      isHost: isHost,
      players: room.players,
      bet: room.bet
    })
    
    // 如果房间已满，通知所有玩家
    if (room.players.length === 2) {
      console.log('✅ 房间已满，通知所有玩家，房间ID:', room.id)
      io.to(room.id).emit('roomReady', {
        roomId: room.id,
        players: room.players,
        bet: room.bet
      })
    } else {
      console.log('⏳ 房间未满，等待更多玩家，当前玩家数:', room.players.length)
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
  socket.on('disconnect', () => {
    console.log('玩家断开连接:', socket.id)
    
    // 从等待队列中移除
    const waitingIndex = waitingPlayers.findIndex(p => p.id === socket.id)
    if (waitingIndex !== -1) {
      waitingPlayers.splice(waitingIndex, 1)
    }
    
    // 从房间中移除
    for (const [roomId, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id)
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1)
        
        // 通知对手玩家离开
        socket.to(roomId).emit('playerLeft', {
          message: '对手已离开游戏'
        })
        
        // 清理房间
        cleanupRoom(roomId)
        break
      }
    }
  })
})

const PORT = process.env.PORT || 3001

server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`)
})

