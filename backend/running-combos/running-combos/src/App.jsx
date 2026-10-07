import { useEffect, useRef, useState } from 'react'

const API = '/api/v1'
// 강남역 — 좌표를 미는 쪽(gps_5556.sh)의 LAT0/LNG0과 같아야 한다
const ORIGIN_LAT = 37.4979
const ORIGIN_LNG = 127.0276
const METERS_PER_DEGREE = 111_320
const BATCH_SECONDS = 10         // 서버 tick(10s)과 맞춘다
const DISTANCES = [3000, 5000, 10000]
const SLOT_MINUTES = 5           // ApplyMatchRequest.SLOT_MINUTES와 맞춘다
const CLOSE_OFFSET_MIN = 10      // match.close-offset — 이보다 가까운 슬롯은 서버가 거절한다

// 상대는 3.0m/s(333s/km) 고정이다. 붙어 가되 발은 맞지 않게 흔든다 —
// 간격은 base*RATIO*PERIOD/2π ≈ 5m만 오가서 콤보 판정 30m 안에 남는다.
const WOBBLE_RATIO = 0.12        // 기준 속도의 ±12% (페이스로는 297~378s/km)
const WOBBLE_PERIOD = 90         // 초
// 상대가 먼저 출발해 앞서 있는 만큼. 여기서 출발해야 옆에 붙는다 —
// 0에서 시작하면 그 차이가 그대로 간격이 되어 콤보가 안 붙는다.
// 서버는 점과 점 사이 거리를 더하므로 첫 점을 앞에 찍어도 기록 거리는 0부터다
const START_OFFSET_METERS = 600

// 서버 websocket.idle-timeout이 2분이다 — 좌표 배치가 멎는 구간(완주 뒤, 탭이
// 백그라운드로 밀려 타이머가 늦춰질 때)을 HEALTH_CHECK로 메운다
const HEARTBEAT_MS = 30_000
const RETRY_MS = 2_000           // 2·4·8… 초로 늘려 가며 다시 붙는다
const MAX_RETRY = 6
// 서버가 "다른 연결이 이어받았다"며 닫는 코드. 다시 붙으면 둘이 서로 밀어내며 돈다
const SUPERSEDED = 4001

// 서버가 LocalDateTime으로 받는다 — 타임존·밀리초를 빼야 한다
const localIso = (d) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)

// 지금 신청할 수 있는 가장 이른 슬롯 — 마감 오프셋을 넘긴 뒤 간격에 맞춰 올린다
const nextSlot = () => {
  const d = new Date(Date.now() + (CLOSE_OFFSET_MIN + 1) * 60_000)
  d.setSeconds(0, 0)
  d.setMinutes(Math.ceil(d.getMinutes() / SLOT_MINUTES) * SLOT_MINUTES)
  return d
}

export default function App() {
  return (
    <div style={{ display: 'flex', gap: 12, padding: 12, fontFamily: 'monospace' }}>
      <Runner label="A" />
      <Runner label="B" />
    </div>
  )
}

function Runner({ label }) {
  const initial = nextSlot()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('Password123!')
  const [auth, setAuth] = useState(null)
  const [date, setDate] = useState(localIso(initial).slice(0, 10))
  const [time, setTime] = useState(localIso(initial).slice(11, 16))
  const [distance, setDistance] = useState(5000)
  const [roomId, setRoomId] = useState('')
  const [pace, setPace] = useState(333)      // 3.003m/s — 상대의 3.0과 미세하게 다르다
  const [running, setRunning] = useState(false)
  const [peers, setPeers] = useState([])
  const [logs, setLogs] = useState([])

  const ws = useRef(null)
  const abort = useRef(null)
  const beat = useRef(null)                  // HEALTH_CHECK 타이머
  const retry = useRef(0)
  const closing = useRef(false)              // 우리가 의도해서 닫는 중인가
  const seq = useRef(0)
  const meters = useRef(START_OFFSET_METERS)
  const paceRef = useRef(pace)
  useEffect(() => { paceRef.current = pace }, [pace])

  // 화면을 벗어날 때 타이머와 소켓을 남기지 않는다
  useEffect(() => () => {
    clearInterval(beat.current)
    closing.current = true
    ws.current?.close()
  }, [])

  const log = (line) =>
    setLogs((p) => [`${new Date().toLocaleTimeString()} ${line}`, ...p].slice(0, 60))

  const call = async (path, options = {}) => {
    const res = await fetch(API + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${auth.accessToken}` } : {}),
      },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${res.status} ${text}`)
    return text ? JSON.parse(text) : null      // 204는 본문이 없다
  }

  const run = (task) => task().catch((e) => log(`✗ ${e.message}`))

  // ---------- 로그인 ----------
  const login = () => run(async () => {
    const body = await call('/auth/login', {
      method: 'POST',
      // 서버는 입력값 그대로 조회한다 — 대문자가 섞이면 401이다
      body: JSON.stringify({ email: email.toLowerCase(), password }),
    })
    setAuth(body)
    log(`로그인 ${body.userId.slice(0, 8)}`)
  })

  // ---------- 예약 · 취소 · 솔로 ----------
  const apply = () => run(async () => {
    const body = await call('/running-matches', {
      method: 'POST',
      body: JSON.stringify({
        scheduledStartAt: `${date}T${time}:00`,   // 초까지 00이어야 슬롯으로 인정된다
        targetDistanceMeters: distance,
      }),
    })
    setRoomId(String(body.runningRoomId))
    log(`예약 room=${body.runningRoomId} @ ${time}`)
    stream()                                    // 신청 성공 뒤에만 연다 — 먼저 열면 404다
  })

  const cancel = () => run(async () => {
    await call('/running-matches', { method: 'DELETE' })
    abort.current?.abort()
    setRoomId('')
    log('취소')
  })

  // 본문이 없다 — 솔로는 목표 거리를 받지 않는다
  const solo = () => run(async () => {
    const body = await call('/running-rooms/solo', { method: 'POST' })
    setRoomId(String(body.runningRoomId))
    log(`솔로 room=${body.runningRoomId}`)
  })

  const pickNextSlot = () => {
    const slot = nextSlot()
    setDate(localIso(slot).slice(0, 10))
    setTime(localIso(slot).slice(11, 16))
  }

  // ---------- SSE ----------
  // EventSource는 헤더를 못 붙인다 — fetch로 직접 읽는다
  const stream = async () => {
    const controller = new AbortController()
    abort.current = controller
    try {
      const res = await fetch(`${API}/running-matches/stream`, {
        headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!res.ok) return log(`✗ 스트림 ${res.status}`)
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop()
        for (const block of blocks) {
          if (!block.trim() || block.startsWith(':')) continue    // keep-alive
          const name = block.match(/^event:\s*(.+)$/m)?.[1]
          const data = block.match(/^data:\s*(.+)$/m)?.[1]
          log(`SSE ${name}`)
          const parsed = data && JSON.parse(data)
          if (parsed?.runningRoomId) setRoomId(String(parsed.runningRoomId))
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') log(`✗ SSE ${e.message}`)
    }
  }

  // ---------- WebSocket ----------
  // 재연결 중에는 소켓이 닫혀 있다 — 그대로 부르면 InvalidStateError가 난다
  const sendWs = (payload) => {
    const socket = ws.current
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(payload))
    return true
  }

  const connect = () => {
    closing.current = false
    // 브라우저는 헤더를 못 붙인다 — vite 프록시가 이 토큰을 Authorization으로 바꿔 전달한다
    const socket = new WebSocket(
      `ws://${location.host}${API}/ws/running?token=${auth.accessToken}`)
    ws.current = socket

    socket.onopen = () => {
      retry.current = 0
      // 재연결이어도 똑같이 보낸다 — 서버가 같은 방에 다시 붙여 준다
      socket.send(JSON.stringify({
        event: 'RUNNING_START', data: { runningRoomId: Number(roomId) },
      }))
      clearInterval(beat.current)
      beat.current = setInterval(() => {
        sendWs({ event: 'HEALTH_CHECK', data: {} })
      }, HEARTBEAT_MS)
    }

    socket.onmessage = (m) => {
      const { event, data } = JSON.parse(m.data)
      if (event === 'HEALTH_CHECKED') return          // 하트비트 응답 — 로그를 덮지 않는다
      if (event === 'RUNNING_COMBO_UPDATED') return setPeers(data.peers)
      if (event === 'RUNNING_PROGRESS_UPDATED') return
      log(`WS ${event} ${JSON.stringify(data)}`)
      if (event === 'RUNNING_STARTED') { setRunning(true); abort.current?.abort() }
      // 완주했으면 더 붙을 이유가 없다
      if (event === 'RUNNING_FINISHED') { closing.current = true; setRunning(false) }
    }

    socket.onclose = (e) => {
      clearInterval(beat.current)
      log(`WS 종료 ${e.code}${e.reason ? ` ${e.reason}` : ''}${e.wasClean ? '' : ' (비정상)'}`)
      // 이미 새 연결로 갈아탄 뒤다 — 살아 있는 쪽의 running을 내리면 안 된다
      if (ws.current !== socket) return
      if (closing.current || e.code === SUPERSEDED) return setRunning(false)
      if (retry.current >= MAX_RETRY) {
        setRunning(false)
        return log('✗ 재연결 포기')
      }
      const wait = RETRY_MS * 2 ** retry.current++
      log(`재연결 ${retry.current}회차 · ${wait / 1000}초 뒤`)
      // running은 그대로 둔다 — 좌표 타이머가 살아 있어야 다시 붙었을 때 이어진다
      setTimeout(connect, wait)
    }

    socket.onerror = () => log('✗ WS — 프록시·토큰 확인')
  }

  // ---------- 가짜 GPS ----------
  // 북쪽으로만 직진한다. 누적 거리만 맞으면 콤보 판정에는 충분하다
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      const now = Date.now()
      const locations = Array.from({ length: BATCH_SECONDS }, (_, i) => {
        // 한 표본이 1초다 — sequence가 그대로 경과 초라 사인파 위상으로 쓴다
        const t = seq.current++
        const speed = (1000 / paceRef.current) *
          (1 + WOBBLE_RATIO * Math.sin((2 * Math.PI * t) / WOBBLE_PERIOD))
        meters.current += speed
        return {
          sequence: t,
          latitude: ORIGIN_LAT + meters.current / METERS_PER_DEGREE,
          longitude: ORIGIN_LNG,
          altitudeMeters: 10,
          accuracyMeters: 4.0,
          speedMetersPerSecond: speed,
          headingDegrees: 0,
          cadenceSpm: 170,
          currentPaceSecondsPerKm: Math.round(1000 / speed),
          recordedAt: localIso(new Date(now - (BATCH_SECONDS - i) * 1000)),
        }
      })
      // 재연결 중이면 이 배치는 버린다. meters는 그대로 올려 둔다 —
      // 다시 붙었을 때 위도가 건너뛰고, 서버는 점 사이 거리를 더하므로 빠진 만큼이 메워진다
      const sent = sendWs({ event: 'RUNNING_LOCATION_UPDATE', data: { locations } })
      log(`배치 ${Math.round(meters.current)}m${sent ? '' : ' — 연결 끊김, 버림'}`)
    }, BATCH_SECONDS * 1000)
    return () => clearInterval(timer)
  }, [running])

  // 종료는 우리가 부른 것이다 — 뒤따르는 close에 재연결이 붙으면 안 된다
  const finish = () => {
    closing.current = true
    sendWs({ event: 'RUNNING_FINISH', data: { runningRoomId: Number(roomId), forced: false } })
  }

  // ---------- 화면 ----------
  return (
    <div style={{ flex: 1, border: '1px solid #999', padding: 8, display: 'grid', gap: 6 }}>
      <b>러너 {label} {auth && `· ${auth.userId.slice(0, 8)}`}</b>

      <div>
        <input style={{ width: 150 }} placeholder="email"
               value={email} onChange={(e) => setEmail(e.target.value)} />
        <input style={{ width: 110 }} type="password"
               value={password} onChange={(e) => setPassword(e.target.value)} />
        <button onClick={login}>로그인</button>
      </div>

      <div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" step={SLOT_MINUTES * 60}
               value={time} onChange={(e) => setTime(e.target.value)} />
        <button onClick={pickNextSlot}>다음 슬롯</button>
      </div>

      <div>
        <select value={distance} onChange={(e) => setDistance(Number(e.target.value))}>
          {DISTANCES.map((d) => <option key={d} value={d}>{d}m</option>)}
        </select>
        <button onClick={apply} disabled={!auth}>예약</button>
        <button onClick={cancel} disabled={!auth}>취소</button>
        <button onClick={solo} disabled={!auth}>솔로</button>
      </div>

      <div>
        room <input style={{ width: 60 }} value={roomId}
                    onChange={(e) => setRoomId(e.target.value)} />
        <button onClick={connect} disabled={!auth || !roomId}>START</button>
        <button onClick={finish} disabled={!running}>FINISH</button>
      </div>

      <div>
        페이스 {pace}s/km
        <input type="range" min="240" max="480" value={pace}
               onChange={(e) => setPace(Number(e.target.value))} />
      </div>
      <div>{Math.round(meters.current)}m {running && '· 달리는 중'}</div>

      <div style={{ background: '#eefaee', padding: 6, minHeight: 40 }}>
        <b>콤보</b>
        {peers.length === 0 && <div>(없음)</div>}
        {peers.map((p) => (
          <div key={p.userId}>
            {p.userId.slice(0, 8)} gap {p.gapMeters > 0 ? '+' : ''}{p.gapMeters}
            {' '}combo {p.comboCount} max {p.maxComboCount}
          </div>
        ))}
      </div>

      <pre style={{ height: 140, overflow: 'auto', background: '#111', color: '#0f0',
                    padding: 6, margin: 0, fontSize: 11 }}>
        {logs.join('\n')}
      </pre>
    </div>
  )
}
