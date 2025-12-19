import React, { useState, useEffect, useCallback, useRef } from 'react'
import { io } from 'socket.io-client'
import Dice from './Dice'
import Scoreboard from './Scoreboard'
import LogPanel from './LogPanel'
import ResultModal from './ResultModal'
import ConfirmModal from './ConfirmModal'
import { calculateScore, canScoreAny } from '../utils/gameLogic'
import { getDiceById, rollDiceWithProbability } from '../data/diceData'
import './Game.css'

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'https://kcd-dice-game.onrender.com'

// 根据赌注设置目标分数
const getTargetScore = (bet) => {
  if (bet && bet.targetScore) {
    return bet.targetScore
  }
  const betName = bet?.name || bet
  const targetScores = {
    '乞丐！': 1500,
    '车夫！': 2000,
    '大师！': 3000,
    '侍臣！': 4000
  }
  return targetScores[betName] || 4000
}

function OnlineGame({ playerGroschen, setPlayerGroschen, playerName, currentBet, onGameEnd }) {
  const [socket, setSocket] = useState(null)
  const [roomId, setRoomId] = useState(null)
  const [isHost, setIsHost] = useState(false)
  const [opponentName, setOpponentName] = useState('等待对手...')
  const [gameStarted, setGameStarted] = useState(false)
  const [isPlayerTurn, setIsPlayerTurn] = useState(false)
  const [isRolling, setIsRolling] = useState(false)
  const [dice, setDice] = useState([])
  const [playerScore, setPlayerScore] = useState(0)
  const [turnScore, setTurnScore] = useState(0)
  const [opponentScore, setOpponentScore] = useState(0)
  const [opponentTurnScore, setOpponentTurnScore] = useState(0)
  const [logs, setLogs] = useState(['正在寻找对手...'])
  const [resultModal, setResultModal] = useState({ show: false, type: 'win', message: '', winnings: 0 })
  const [confirmModal, setConfirmModal] = useState({ show: false, message: '', onConfirm: null })
  const [matching, setMatching] = useState(true)
  const [players, setPlayers] = useState([])
  
  // 获取玩家选中的骰子配置
  const [playerDiceConfig, setPlayerDiceConfig] = useState(() => {
    const saved = localStorage.getItem('kcd_dice_selected_dice')
    if (saved) {
      return JSON.parse(saved)
    }
    return Array(6).fill('ordinary')
  })
  
  const targetScore = currentBet ? getTargetScore(currentBet) : 4000
  const playerIndexRef = useRef(0) // 0 或 1
  // 生成或获取玩家ID（用于重连恢复）
  const playerIdRef = useRef((() => {
    let playerId = localStorage.getItem('kcd_dice_player_id')
    if (!playerId) {
      playerId = 'player_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9)
      localStorage.setItem('kcd_dice_player_id', playerId)
    }
    return playerId
  })())
  
  // 检查服务器是否可用
  const checkServerHealth = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/health`)
      if (response.ok) {
        const data = await response.json()
        console.log('服务器状态:', data)
        if (data.name && data.name.includes('骰子游戏')) {
          return true
        } else {
          setLogs(prev => [
            '> ⚠️ 警告：服务器可能不是骰子游戏服务器',
            `> 服务器名称: ${data.name || '未知'}`,
            '> 请确认服务器地址是否正确',
            ...prev
          ])
          return true // 仍然尝试连接
        }
      }
    } catch (error) {
      console.error('健康检查失败:', error)
      setLogs(prev => [
        '> ⚠️ 无法检查服务器状态',
        '> 将尝试直接连接...',
        ...prev
      ])
      return true // 仍然尝试连接
    }
    return false
  }
  
  // 初始化 Socket 连接
  useEffect(() => {
    let newSocket = null
    
    const initConnection = async () => {
      // 先检查服务器健康状态
      await checkServerHealth()
      
      newSocket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5,
        timeout: 20000,
        forceNew: true
      })
      
      newSocket.on('connect', () => {
        console.log('已连接到服务器')
        setLogs(prev => ['> 已连接到服务器，正在寻找对手...', ...prev])
        
        // 发送匹配请求（包含玩家ID用于重连恢复）
        const diceConfig = playerDiceConfig || Array(6).fill('ordinary')
        newSocket.emit('findMatch', {
          playerId: playerIdRef.current, // 发送玩家ID用于重连恢复
          name: playerName || '玩家',
          bet: currentBet,
          diceConfig: diceConfig
        })
      })
      
      newSocket.on('reconnect', (attemptNumber) => {
      console.log('重新连接成功，尝试次数:', attemptNumber)
      setLogs(prev => [`> ✅ 重新连接到服务器（尝试 ${attemptNumber} 次）`, ...prev])
      
      // 重连后自动恢复匹配
      if (roomId) {
        console.log('重连后恢复房间:', roomId)
        const diceConfig = playerDiceConfig || Array(6).fill('ordinary')
        newSocket.emit('findMatch', {
          playerId: playerIdRef.current,
          name: playerName || '玩家',
          bet: currentBet,
          diceConfig: diceConfig
        })
      }
    })
    
    newSocket.on('reconnect_attempt', (attemptNumber) => {
      console.log('尝试重新连接:', attemptNumber)
      setLogs(prev => [`> 正在尝试重新连接... (${attemptNumber}/5)`, ...prev])
    })
    
    newSocket.on('reconnect_failed', () => {
      console.error('重新连接失败')
      setLogs(prev => [
        '> ❌ 无法连接到服务器',
        '> 请检查：',
        '> 1. 服务器是否正在运行',
        '> 2. 服务器地址是否正确',
        '> 3. 网络连接是否正常',
        ...prev
      ])
    })
    
    newSocket.on('matched', (data) => {
      console.log('匹配成功:', data)
      setRoomId(data.roomId)
      setIsHost(data.isHost)
      setPlayers(data.players)
      playerIndexRef.current = data.isHost ? 0 : 1
      
      const opponent = data.players.find(p => p.socketId !== newSocket.id)
      if (opponent) {
        setOpponentName(opponent.name)
      }
      
      setLogs(prev => ['> 已找到对手！等待对手准备...', ...prev])
      setMatching(false)
    })
    
    newSocket.on('roomReady', (data) => {
      console.log('房间准备就绪:', data)
      setPlayers(data.players)
      setLogs(prev => ['> 对手已加入！点击"准备"开始游戏', ...prev])
    })
    
    newSocket.on('playerReadyUpdate', (data) => {
      console.log('玩家准备状态更新:', data)
      console.log('玩家列表:', data.players.map(p => ({ name: p.name, ready: p.ready })))
      setPlayers(data.players)
      const allReady = data.players.every(p => p.ready)
      const playerCount = data.players.length
      console.log('准备状态 - 所有准备好:', allReady, '玩家数量:', playerCount)
      
      if (allReady && playerCount === 2) {
        setLogs(prev => ['> ✅ 所有玩家已准备！等待游戏开始...', ...prev])
        console.log('⚠️ 所有玩家已准备，但未收到 gameStart 事件')
      } else {
        const readyCount = data.players.filter(p => p.ready).length
        setLogs(prev => [`> ${readyCount}/${playerCount} 玩家已准备`, ...prev])
      }
    })
    
    newSocket.on('gameStart', (data) => {
      console.log('🎮 收到 gameStart 事件:', data)
      console.log('当前玩家索引:', playerIndexRef.current)
      console.log('当前回合:', data.gameState.currentTurn)
      console.log('玩家列表:', data.players)
      
      setGameStarted(true)
      setPlayerScore(0)
      setOpponentScore(0)
      setTurnScore(0)
      setOpponentTurnScore(0)
      
      const isMyTurn = data.gameState.currentTurn === playerIndexRef.current
      setIsPlayerTurn(isMyTurn)
      
      console.log('是否是我的回合:', isMyTurn)
      console.log('游戏状态已更新，gameStarted:', true, 'isPlayerTurn:', isMyTurn)
      
      setLogs(prev => [
        '> 🎮 游戏开始！',
        isMyTurn ? '> 轮到你的回合了！' : `> 轮到 ${opponentName} 的回合`,
        ...prev
      ])
      
      initDice(6)
      setMatching(false) // 确保匹配状态已关闭
    })
    
    newSocket.on('opponentRolled', (data) => {
      console.log('对手掷骰:', data)
      setLogs(prev => [`> ${opponentName} 掷出了骰子`, ...prev])
    })
    
    newSocket.on('opponentSelectedDice', (data) => {
      console.log('对手选择骰子:', data)
    })
    
    newSocket.on('opponentKeptScore', (data) => {
      console.log('对手保留得分:', data)
      setOpponentTurnScore(data.turnScore)
      setLogs(prev => [`> ${opponentName} 保留了得分，当前回合累计: ${data.turnScore}`, ...prev])
    })
    
    newSocket.on('turnChanged', (data) => {
      console.log('回合切换:', data)
      setPlayerScore(data.scores[playerIndexRef.current])
      setOpponentScore(data.scores[1 - playerIndexRef.current])
      setTurnScore(0)
      setOpponentTurnScore(0)
      setIsPlayerTurn(data.currentTurn === playerIndexRef.current)
      initDice(6)
      
      if (data.currentTurn === playerIndexRef.current) {
        setLogs(prev => ['> 轮到你的回合了！', ...prev])
      } else {
        setLogs(prev => [`> 轮到 ${opponentName} 的回合`, ...prev])
      }
    })
    
    newSocket.on('opponentBusted', (data) => {
      console.log('对手爆点:', data)
      setOpponentTurnScore(0)
      setLogs(prev => [`> ${opponentName} 爆点了！`, ...prev])
      setIsPlayerTurn(data.currentTurn === playerIndexRef.current)
      if (data.currentTurn === playerIndexRef.current) {
        initDice(6)
      }
    })
    
    newSocket.on('gameEnd', (data) => {
      console.log('游戏结束:', data)
      const won = data.winner === playerIndexRef.current
      const winnings = won ? (currentBet ? currentBet.amount : 0) : 0
      
      setResultModal({
        show: true,
        type: won ? 'win' : 'lose',
        message: won ? '耶稣基督保佑！你赢了！' : '你输了...',
        winnings: winnings
      })
    })
    
    newSocket.on('playerDisconnected', (data) => {
      console.log('对手暂时断开:', data)
      setLogs(prev => [data.message || '> 对手暂时断开连接，等待重连...', ...prev])
    })
    
    newSocket.on('playerLeft', (data) => {
      console.log('玩家离开:', data)
      setLogs(prev => ['> 对手已离开游戏', ...prev])
      setConfirmModal({
        show: true,
        message: '对手已离开游戏，返回主菜单？',
        onConfirm: () => {
          setConfirmModal({ show: false, message: '', onConfirm: null })
          if (onGameEnd) onGameEnd(false, 0)
        }
      })
    })
    
    newSocket.on('connect_error', (error) => {
      console.error('连接服务器失败:', error)
      setLogs(prev => [
        '> ❌ 无法连接到服务器',
        `> 错误: ${error.message || '连接失败'}`,
        `> 服务器地址: ${SERVER_URL}`,
        '> 请检查：',
        '> 1. 服务器是否正在运行',
        '> 2. 服务器地址是否正确',
        '> 3. 网络连接是否正常',
        '> 4. 如果使用 Render，服务器可能需要几秒钟唤醒',
        ...prev
      ])
      setMatching(false)
    })
    
    newSocket.on('disconnect', (reason) => {
      console.log('与服务器断开连接:', reason)
      if (reason === 'io server disconnect') {
        setLogs(prev => ['> 服务器主动断开连接', ...prev])
      } else {
        setLogs(prev => ['> 与服务器断开连接', ...prev])
      }
    })
    
      setSocket(newSocket)
    }
    
    initConnection()
    
    return () => {
      if (newSocket) {
        newSocket.close()
      }
    }
  }, [playerName, currentBet, playerDiceConfig, opponentName, onGameEnd])
  
  // 初始化骰子
  const initDice = useCallback((count = 6) => {
    const newDice = []
    for (let i = 0; i < count; i++) {
      const diceType = playerDiceConfig[i] || 'ordinary'
      newDice.push({ value: 1, selected: false, kept: false, diceType })
    }
    setDice(newDice)
    console.log('初始化骰子:', newDice.length, '个', newDice.map(d => d.diceType))
  }, [playerDiceConfig])
  
  // 添加日志
  const addLog = useCallback((msg) => {
    setLogs(prev => [`> ${msg}`, ...prev])
  }, [])
  
  // 切换骰子选择
  const toggleSelect = useCallback((index) => {
    if (isRolling || !gameStarted || !isPlayerTurn) return
    setDice(prev => prev.map((d, i) => 
      i === index ? { ...d, selected: !d.selected } : d
    ))
  }, [isRolling, gameStarted, isPlayerTurn])
  
  // 获取选中的骰子值
  const getSelectedValues = useCallback(() => {
    return dice.filter(d => d.selected).map(d => d.value)
  }, [dice])
  
  // 获取选中骰子的类型
  const getSelectedDiceTypes = useCallback(() => {
    return dice.filter(d => d.selected).map(d => d.diceType || 'ordinary')
  }, [dice])
  
  // 玩家准备
  const handleReady = useCallback(() => {
    if (socket && roomId) {
      console.log('发送准备信号，房间ID:', roomId)
      socket.emit('playerReady', { roomId })
      setLogs(prev => ['> 你已准备！等待对手准备...', ...prev])
    } else {
      console.error('无法准备：socket 或 roomId 不存在', { socket: !!socket, roomId })
      setLogs(prev => ['> ❌ 错误：无法发送准备信号', ...prev])
    }
  }, [socket, roomId])
  
  // 玩家掷骰子
  const rollDice = useCallback(() => {
    if (isRolling || !gameStarted || !isPlayerTurn || !socket || !roomId) return
    
    setIsRolling(true)
    
    // 模拟掷骰动画
    let rollCount = 0
    const rollInterval = setInterval(() => {
      setDice(prev => prev.map(d => {
        if (d.kept) return d
        return { ...d, value: Math.floor(Math.random() * 6) + 1 }
      }))
      rollCount++
      if (rollCount >= 8) {
        clearInterval(rollInterval)
      }
    }, 100)
    
    setTimeout(() => {
      clearInterval(rollInterval)
      
      // 生成最终结果
      setDice(prev => {
        const finalValues = []
        const finalTypes = []
        let activeIdx = 0
        
        for (let i = 0; i < prev.length; i++) {
          if (!prev[i].kept) {
            const diceId = playerDiceConfig[i] || 'ordinary'
            const diceData = getDiceById(diceId)
            finalValues.push(rollDiceWithProbability(diceData.probabilities))
            finalTypes.push(diceId)
            activeIdx++
          }
        }
        
        // 发送到服务器
        if (socket && roomId) {
          socket.emit('rollDice', {
            roomId,
            diceValues: finalValues,
            diceTypes: finalTypes
          })
        }
        
        // 检查是否得分
        if (!canScoreAny(finalValues, finalTypes)) {
          addLog("哎呀！没有得分骰子，本轮作废。")
          setTurnScore(0)
          setIsRolling(false)
          
          // 通知服务器爆点
          if (socket && roomId) {
            socket.emit('bust', { roomId })
          }
        } else {
          addLog("掷出了: " + finalValues.join(', '))
          setIsRolling(false)
        }
        
        // 更新骰子
        let activeIndex = 0
        return prev.map((d, i) => {
          if (d.kept) return d
          const newValue = finalValues[activeIndex]
          const newType = finalTypes[activeIndex]
          activeIndex++
          return { 
            ...d, 
            value: newValue,
            diceType: newType,
            selected: false 
          }
        })
      })
    }, 800)
  }, [isRolling, gameStarted, isPlayerTurn, socket, roomId, playerDiceConfig, addLog])
  
  // 保留得分
  const handleKeep = useCallback(() => {
    if (!gameStarted || !isPlayerTurn || !socket || !roomId) return
    
    const selectedData = calculateScore(getSelectedValues(), getSelectedDiceTypes())
    if (selectedData.score === 0) return
    
    const newScore = turnScore + selectedData.score
    setTurnScore(newScore)
    
    // 发送到服务器
    socket.emit('keepScore', {
      roomId,
      score: selectedData.score
    })
    
    // 更新骰子状态
    setDice(prev => {
      const newDice = prev.map(d => 
        d.selected ? { ...d, kept: true, selected: false } : d
      )
      
      // 如果所有骰子都被保留，重置
      if (newDice.every(d => d.kept)) {
        addLog("【奖励】所有骰子均得分！重置6个骰子。")
        return Array(6).fill(null).map((_, i) => {
          const diceType = playerDiceConfig[i] || 'ordinary'
          return { value: 1, selected: false, kept: false, diceType }
        })
      }
      
      return newDice
    })
    
    addLog(`保留了得分：${selectedData.score}，当前回合累计: ${newScore}`)
  }, [gameStarted, isPlayerTurn, socket, roomId, turnScore, getSelectedValues, getSelectedDiceTypes, playerDiceConfig, addLog])
  
  // 提交得分
  const handleBank = useCallback(() => {
    if (!gameStarted || !isPlayerTurn || !socket || !roomId) return
    
    const selectedData = calculateScore(getSelectedValues(), getSelectedDiceTypes())
    const newScore = turnScore + selectedData.score
    
    setPlayerScore(prev => {
      const total = prev + newScore
      
      // 发送到服务器
      socket.emit('bankScore', {
        roomId,
        score: selectedData.score
      })
      
      addLog(`提交得分：${newScore}。回合结束。`)
      
      setTurnScore(0)
      return total
    })
  }, [gameStarted, isPlayerTurn, socket, roomId, turnScore, getSelectedValues, getSelectedDiceTypes, addLog])
  
  // 计算选中得分
  const selectedData = calculateScore(getSelectedValues(), getSelectedDiceTypes())
  const selectedScore = selectedData.score
  const selectedCount = dice.filter(d => d.selected).length
  const allSelectedScoring = selectedCount === 0 || selectedData.count === selectedCount
  
  // 按钮状态
  const canKeep = gameStarted && isPlayerTurn && selectedData.score > 0 && 
                  selectedData.count === selectedCount && !isRolling
  const canBank = gameStarted && isPlayerTurn && !isRolling && 
                  (turnScore + selectedData.score) > 0 && allSelectedScoring
  
  // 获取骰子配置
  const diceConfigs = dice.map(d => {
    const diceData = getDiceById(d.diceType || 'ordinary')
    return {
      bgColor: diceData.color?.bg || '#f5f5dc',
      dotColor: diceData.color?.dot || '#333333',
      name: diceData.name || '普通骰子'
    }
  })
  
  return (
    <div className="game-container">
      <div className="game-header">
        <h1>联机模式（测试）</h1>
        <div className="opponent-info">
          <span>对手: {opponentName}</span>
        </div>
      </div>
      
      <Scoreboard
        playerScore={playerScore}
        opponentScore={opponentScore}
        turnScore={turnScore}
        opponentTurnScore={opponentTurnScore}
        targetScore={targetScore}
        playerName={playerName || '你'}
        opponentName={opponentName}
        opponentSpeech={{ show: false, text: '' }}
      />
      
      <div className="game-board">
        <Dice
          dice={dice}
          onSelect={toggleSelect}
          diceConfigs={diceConfigs}
        />
      </div>
      
      <div className="game-controls">
        {matching && (
          <div className="matching-status">
            <p>正在连接服务器...</p>
            <p className="server-hint">如果长时间无法连接，请检查服务器是否运行在 {SERVER_URL}</p>
            <p className="server-hint">启动服务器: cd server && npm install && npm start</p>
          </div>
        )}
        
        {!matching && !gameStarted && (
          <button 
            className="game-button ready-button"
            onClick={handleReady}
          >
            准备
          </button>
        )}
        
        {gameStarted && isPlayerTurn && (
          <>
            <button
              className="game-button roll-button"
              onClick={rollDice}
              disabled={isRolling || dice.length === 0 || dice.filter(d => !d.kept).length === 0}
            >
              {isRolling ? '掷骰中...' : '掷骰子'}
            </button>
            
            <button
              className="game-button keep-button"
              onClick={handleKeep}
              disabled={!canKeep}
            >
              保留得分 ({selectedScore > 0 ? `+${selectedScore}` : '0'})
            </button>
            
            <button
              className="game-button bank-button"
              onClick={handleBank}
              disabled={!canBank}
            >
              提交得分并结束回合 ({turnScore + selectedScore > 0 ? `+${turnScore + selectedScore}` : '0'})
            </button>
          </>
        )}
        
        {gameStarted && !isPlayerTurn && (
          <div className="waiting-turn">
            <p>等待 {opponentName} 的回合...</p>
          </div>
        )}
      </div>
      
      <LogPanel logs={logs} />
      
      <ResultModal
        show={resultModal.show}
        type={resultModal.type}
        message={resultModal.message}
        winnings={resultModal.winnings}
        onClose={() => {
          const wasWin = resultModal.type === 'win'
          const winnings = resultModal.winnings || 0
          setResultModal({ show: false, type: 'win', message: '', winnings: 0 })
          if (onGameEnd) {
            onGameEnd(wasWin, winnings)
          }
        }}
      />
      
      <ConfirmModal
        show={confirmModal.show}
        message={confirmModal.message}
        onConfirm={confirmModal.onConfirm || (() => {})}
        onCancel={() => setConfirmModal({ show: false, message: '', onConfirm: null })}
      />
    </div>
  )
}

export default OnlineGame

