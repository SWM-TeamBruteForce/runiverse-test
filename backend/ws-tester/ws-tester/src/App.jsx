import { useRef, useState } from 'react'

const WS_PATH = '/api/v1/ws/running'

// 봉투 단계 — 유스케이스에 닿기 전에 걸러지는 것들
const ENVELOPE_CASES = [
  ['HEALTH_CHECK',      '{"event":"HEALTH_CHECK","data":{}}'],
  ['깨진 JSON',          'this is not json'],
  ['event 없음',         '{"data":{}}'],
  ['event 공백',         '{"event":"   ","data":{}}'],
  ['모르는 타입',        '{"event":"MATCH_REQUEST","data":{}}'],
  ['S→C 전용 타입',      '{"event":"HEALTH_CHECKED","data":{}}'],
]

// 4001은 서버가 정한 값 — 다른 연결이 이어받았다는 뜻이라 클라는 재연결하지 않는다
const CLOSE_REASON = {
  1000: '정상 종료',
  1003: '바이너리 거부(TextWebSocketHandler)',
  1006: '비정상 종료 — 핸드셰이크 실패(401)일 가능성',
  1009: '버퍼 초과',
  1011: '서버 예외',
  4001: '다른 연결이 이어받음 (중복 연결)',
}

// 부산 어딘가 — 순번이 늘수록 북쪽으로 약 2.2m씩 이동시킨다
const BASE = { lat: 35.17955, lng: 129.07564 }

// 좌표 하나가 만드는 거리·시간. running-finish.min-distance-meters(100m)와
// min-duration-seconds(60s)를 둘 다 넘겨야 기록이 생긴다 — 아래 RECORDABLE_POINTS의 근거다
const METERS_PER_STEP = 2.22
const RECORDABLE_POINTS = 120          // 약 264m · 119초
// websocket.max-text-message-buffer-size=16KB — 한 메시지에 다 담으면 서버가 끊는다
const CHUNK_SIZE = 40

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 서버가 LocalDateTime으로 받으므로 UTC(toISOString)가 아니라 로컬 시각이어야 한다
const localIso = (date = new Date()) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)

// api-spec 5-D의 좌표 한 개 — 단말이 모두 측정한 정상 배치
const samplePoint = (seq) => ({
  sequence: seq,
  latitude: Number((BASE.lat + seq * 0.00002).toFixed(7)),
  longitude: BASE.lng,
  altitudeMeters: 18.4,
  accuracyMeters: 6.2,
  speedMetersPerSecond: 2.8,
  headingDegrees: 0,
  cadenceSpm: 165,
  currentPaceSecondsPerKm: 345,
  recordedAt: localIso(new Date(Date.now() + seq * 1000)),
})

// 단말이 못 재는 값을 뺀 좌표 — Location.isValid()가 요구하는 것만 담았다.
// 케이던스는 보수 센서가 있어야 하고, 속도·방위는 GPS 초기 픽스나 정지 상태에서 안 온다
const partialPoint = (seq) => ({
  sequence: seq,
  latitude: Number((BASE.lat + seq * 0.00002).toFixed(7)),
  longitude: BASE.lng,
  accuracyMeters: 6.2,
  recordedAt: localIso(new Date(Date.now() + seq * 1000)),
})

export default function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [roomId, setRoomId] = useState('')
  const [open, setOpen] = useState({ A: false, B: false })
  const [logs, setLogs] = useState([])
  const [trackSize, setTrackSize] = useState(0)   // 보낸 좌표 총 개수 (표시용)

  const sockets = useRef({ A: null, B: null })
  const heartbeat = useRef(null)

  const sequence = useRef(0)          // 러닝 내 좌표 순번 — 계속 증가
  const lastBatch = useRef([])        // 직전 배치 (중복 재전송용)
  const allPoints = useRef([])        // 전체 트랙 (재연결 시나리오용)
  const locationTimer = useRef(null)

  const log = (kind, text, slot = '-') =>
    setLogs((prev) => [...prev, { kind, text, slot, at: new Date().toLocaleTimeString() }])

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    })
    const text = await res.text()
    const body = text ? JSON.parse(text) : null
    return { ok: res.ok, status: res.status, body }
  }

  async function login() {
    const { ok, status, body } = await api('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    if (!ok) return log('error', `로그인 실패 ${status} — ${JSON.stringify(body)}`)
    setToken(body.accessToken)
    log('info', `로그인 성공 — userId=${body.userId}`)
  }

  // 방을 먼저 만들어야 RUNNING_START에 실을 runningRoomId가 생긴다.
  // 좌표·종료 전송에는 더 이상 필요 없다 — 서버가 세션에 들고 있다.
  // setState는 비동기라 전체 시나리오가 쓸 수 있게 id를 반환한다
  async function openSoloRoom() {
    if (!token) { log('error', '먼저 로그인하세요'); return null }
    const { ok, status, body } = await api('/api/v1/running-rooms/solo', { method: 'POST' })
    if (!ok) { log('error', `솔로 방 개시 실패 ${status} — ${JSON.stringify(body)}`); return null }
    setRoomId(String(body.runningRoomId))
    resetSequence()   // 방이 바뀌면 순번도 처음부터다
    // 이 시점 방은 MATCHED, 참가자는 JOINED다 — STARTED로 올리는 건 RUNNING_START다
    log('info', `솔로 방 개시 — runningRoomId=${body.runningRoomId} (MATCHED/JOINED)`)
    return body.runningRoomId
  }

  function connect(slot) {
    if (!token) return log('error', '먼저 로그인해서 accessToken을 받으세요')
    // 브라우저는 WS에 헤더를 못 붙인다 — vite.config.js의 proxyReqWs 훅이
    // ?token= 을 읽어 Authorization: Bearer 로 바꿔 서버에 넘긴다.
    // 그래서 서버가 보는 건 Flutter와 같은 헤더 인증 경로다
    const url = `ws://${location.host}${WS_PATH}?token=${encodeURIComponent(token)}`
    const socket = new WebSocket(url)
    sockets.current[slot] = socket

    socket.onopen = () => { setOpen((p) => ({ ...p, [slot]: true })); log('info', '연결됨', slot) }
    socket.onmessage = (e) => log('recv', e.data, slot)
    socket.onerror = () => log('error', '전송 오류 (핸드셰이크 401이면 여기로 온다)', slot)
    socket.onclose = (e) => {
      setOpen((p) => ({ ...p, [slot]: false }))
      if (slot === 'A') {
        clearInterval(heartbeat.current); heartbeat.current = null
        clearInterval(locationTimer.current); locationTimer.current = null
      }
      const why = CLOSE_REASON[e.code] ?? '알 수 없음'
      log('error', `종료 — code=${e.code} (${why}) reason="${e.reason}"`, slot)
    }
  }

  function send(slot, payload) {
    const socket = sockets.current[slot]
    if (socket?.readyState !== WebSocket.OPEN) return log('error', '연결되어 있지 않습니다', slot)
    socket.send(payload)
    log('sent', payload, slot)
  }

  const runningStart = (data) => `{"event":"RUNNING_START","data":${data}}`
  const runningFinish = (data) => `{"event":"RUNNING_FINISH","data":${data}}`

  // 재연결·재입장·최초 진입 모두 같은 메시지 — 두 번 보내도 상태가 안 바뀌어야 한다.
  // 이 메시지만이 방을 정한다. 성공하면 서버가 세션에 runningRoomId를 새긴다
  function sendStart(slot, id = roomId) {
    if (!id) return log('error', '먼저 솔로 방을 개시하거나 roomId를 입력하세요', slot)
    send(slot, runningStart(`{"runningRoomId":${id}}`))
  }

  function sendStartTwice(slot) {
    sendStart(slot)
    setTimeout(() => sendStart(slot), 300)
  }

  function sendBinary(slot) {
    sockets.current[slot]?.send(new Uint8Array([1, 2, 3]))
    log('sent', '(binary 3 bytes)', slot)
  }

  function toggleHeartbeat() {
    if (heartbeat.current) {
      clearInterval(heartbeat.current)
      heartbeat.current = null
      return log('info', '자동 헬스 체크 중지')
    }
    // websocket.idle-timeout=2m 이므로 그보다 짧게 보내야 세션이 유지된다
    heartbeat.current = setInterval(() => send('A', ENVELOPE_CASES[0][1]), 30_000)
    log('info', '자동 헬스 체크 시작 — 30초 간격')
  }

  // ── 위치 전송 ──────────────────────────────────────────────
  // 성공해도 ack가 없다(api-spec 5-D) — 화면은 조용하고 확인은 redis-cli로 한다.
  // runningRoomId는 싣지 않는다 — RUNNING_START가 정한 방을 서버가 세션에 들고 있다

  function sendLocations(slot, locations) {
    send(slot, JSON.stringify({
      event: 'RUNNING_LOCATION_UPDATE',
      data: { locations },
    }))
  }

  // data를 손대지 않고 그대로 보낸다 — 서버가 안 읽는 필드를 일부러 끼워 넣을 때 쓴다
  function sendLocationsRaw(slot, data) {
    send(slot, JSON.stringify({ event: 'RUNNING_LOCATION_UPDATE', data }))
  }

  // 클라는 1~2초 간격으로 모아 10초마다 보낸다 — 배치 하나에 5개
  function sendNextBatch(slot, count = 5) {
    const batch = []
    for (let i = 0; i < count; i += 1) {
      batch.push(samplePoint(sequence.current))
      sequence.current += 1
    }
    lastBatch.current = batch
    allPoints.current = [...allPoints.current, ...batch]
    setTrackSize(allPoints.current.length)
    sendLocations(slot, batch)
  }

  // 기록이 남는 러닝을 만든다 — 100m·60초를 못 넘기면 종료해도
  // "기록 없이 상태만 확정"으로 끝나 running_records가 비어 있다(feature-spec §2)
  async function sendRecordableTrack(slot, total = RECORDABLE_POINTS) {
    for (let sent = 0; sent < total; sent += CHUNK_SIZE) {
      sendNextBatch(slot, Math.min(CHUNK_SIZE, total - sent))
      await sleep(200)   // 버퍼(16KB)를 넘기지 않으려고 나눠 보낸다
    }
    const meters = Math.round(allPoints.current.length * METERS_PER_STEP)
    log('info', `기록 가능한 트랙 — 좌표 ${allPoints.current.length}개 ≈ ${meters}m`, slot)
  }

  // 직전 배치를 그대로 다시 — 전부 중복이라 Redis에 아무것도 안 쌓여야 한다
  function resendLastBatch(slot) {
    if (!lastBatch.current.length) return log('error', '먼저 배치를 보내세요', slot)
    sendLocations(slot, lastBatch.current)
  }

  // 재연결 시나리오 — 클라가 처음 sequence부터 전부 다시 보낸다(api-spec 5-D).
  // 트랙이 길면 버퍼를 넘기므로 나눠 보낸다
  async function resendAll(slot) {
    if (!allPoints.current.length) return log('error', '먼저 배치를 보내세요', slot)
    const points = allPoints.current
    for (let i = 0; i < points.length; i += CHUNK_SIZE) {
      sendLocations(slot, points.slice(i, i + CHUNK_SIZE))
      await sleep(200)
    }
  }

  function toggleAutoLocation(slot) {
    if (locationTimer.current) {
      clearInterval(locationTimer.current)
      locationTimer.current = null
      return log('info', '자동 위치 전송 중지')
    }
    sendNextBatch(slot)
    locationTimer.current = setInterval(() => sendNextBatch(slot), 10_000)
    log('info', '자동 위치 전송 시작 — 10초 간격')
  }

  function resetSequence() {
    sequence.current = 0
    lastBatch.current = []
    allPoints.current = []
    setTrackSize(0)
  }

  // ── 러닝 종료 ──────────────────────────────────────────────
  // 상태가 걸린 요청이라 ack가 있다 — RUNNING_FINISHED를 받으면 클라는 로컬 트랙을 지운다.
  // forced는 조기 종료 '의사'일 뿐, 최종 상태는 서버가 확정한 거리로 정해진다

  function sendFinish(slot, forced = false) {
    send(slot, runningFinish(`{"forced":${forced}}`))
  }

  // 서버가 안 읽는 필드 — 세션이 기억한 방이 끝나고 999999는 무시된다
  function sendFinishWithFakeRoom(slot) {
    send(slot, runningFinish('{"runningRoomId":999999,"forced":false}'))
  }

  // 종료를 두 번 — 두 번째도 RUNNING_FINISHED가 와야 한다.
  // 기록을 덮어쓰지 않고 트랙만 정리하는 멱등 경로다(api-spec 5-D)
  async function sendFinishTwice(slot) {
    sendFinish(slot)
    await sleep(500)
    sendFinish(slot)
  }

  // ── 전체 시나리오 ──────────────────────────────────────────
  // 방 개시 → 시작 → 기록 가능한 트랙 → 종료까지 한 번에.
  // 소켓 A가 이미 연결돼 있어야 한다(연결은 토큰이 필요해 수동으로 둔다)
  async function runFullScenario() {
    if (!open.A) return log('error', '먼저 소켓 A를 연결하세요', 'A')
    log('info', '=== 전체 시나리오 시작 ===')
    const id = await openSoloRoom()
    if (!id) return
    sendStart('A', id)
    await sleep(500)                    // RUNNING_STARTED를 받고 나서 좌표를 보낸다
    await sendRecordableTrack('A')
    await sleep(500)
    sendFinish('A')
    log('info', '=== RUNNING_FINISHED가 오면 성공 — running_records/running_splits 확인 ===')
  }

  // ── 방 위조 ────────────────────────────────────────────────
  // 서버는 클라가 보낸 runningRoomId를 읽지 않는다.
  // RUNNING_START가 참가자 검증을 마치고 세션에 새긴 값만 저장 키로 쓴다

  // 서버가 안 읽는 필드를 일부러 실어 보낸다 — 무시되고 내 방에 정상 저장돼야 한다.
  // 구버전 앱이 계속 보내도 안 깨진다는 확인이기도 하다
  function sendIgnoredRoomId(slot) {
    sendLocationsRaw(slot, {
      runningRoomId: 999999,
      locations: [samplePoint(sequence.current)],
    })
  }

  // RUNNING_START를 보내지 않은 소켓으로 좌표를 보낸다 — 서버에 정해진 방이 없다.
  // 연결만으로는 아무것도 등록되지 않으므로(핸들러 afterConnectionEstablished)
  // B를 연결해도 A가 4001로 끊기지 않는다
  function sendWithoutStart(slot) {
    sendLocationsRaw(slot, { locations: [samplePoint(sequence.current)] })
  }

  // ⚠️ 알려진 서버 버그 — Location.isValid()는 통과하지만 TrackPoint가 원시 타입이라
  // 언박싱 NPE가 난다. ERROR도 안 오고 이 배치가 통째로 사라진다
  function sendPartialPoint(slot) {
    sendLocations(slot, [partialPoint(sequence.current)])
  }

  const color = { sent: '#0b6', recv: '#06c', error: '#c33', info: '#666' }
  const row = { marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }
  const divider = { ...row, borderTop: '1px solid #ddd', paddingTop: 10 }

  return (
    <div style={{ fontFamily: 'monospace', padding: 24, maxWidth: 1000 }}>
      <h2>러닝 WebSocket 테스터 — START · LOCATION_UPDATE · FINISH</h2>

      <section style={row}>
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="password" type="password" value={password}
               onChange={(e) => setPassword(e.target.value)} />
        <button onClick={login}>로그인</button>
        <span>{token ? '🔑 토큰 있음' : '🔒 토큰 없음'}</span>
      </section>

      <section style={row}>
        <button onClick={openSoloRoom} disabled={!token}>솔로 방 개시 (POST /running-rooms/solo)</button>
        <input placeholder="runningRoomId" value={roomId} style={{ width: 120 }}
               onChange={(e) => setRoomId(e.target.value)} />
        <span style={{ color: '#666' }}>← RUNNING_START에만 쓴다</span>
      </section>

      {['A', 'B'].map((slot) => (
        <section key={slot} style={divider}>
          <strong style={{ width: 84 }}>소켓 {slot} {open[slot] ? '🟢' : '⚪'}</strong>
          <button onClick={() => connect(slot)} disabled={open[slot]}>연결</button>
          <button onClick={() => sockets.current[slot]?.close(1000, 'client bye')}
                  disabled={!open[slot]}>종료</button>
          <button onClick={() => sendStart(slot)} disabled={!open[slot]}>RUNNING_START</button>
          <button onClick={() => sendStartTwice(slot)} disabled={!open[slot]}>
            RUNNING_START ×2 (멱등)
          </button>
        </section>
      ))}

      {/* 개시부터 종료까지 — 기록이 실제로 만들어지는 유일한 경로 */}
      <section style={divider}>
        <strong style={{ width: 84 }}>전체 흐름</strong>
        <button onClick={runFullScenario} disabled={!open.A}
                style={{ fontWeight: 'bold' }}>
          ▶ 개시 → START → 트랙 {RECORDABLE_POINTS}개 → FINISH
        </button>
        <span style={{ color: '#666' }}>
          약 {Math.round(RECORDABLE_POINTS * METERS_PER_STEP)}m · {RECORDABLE_POINTS - 1}초 —
          100m/60초를 넘겨야 기록이 남는다
        </span>
      </section>

      <section style={divider}>
        <strong style={{ width: 84 }}>위치 전송</strong>
        <button onClick={() => sendNextBatch('A')} disabled={!open.A}>
          배치 전송 (5개)
        </button>
        <button onClick={() => sendRecordableTrack('A')} disabled={!open.A}>
          기록 가능한 트랙 ({RECORDABLE_POINTS}개)
        </button>
        <button onClick={() => resendLastBatch('A')} disabled={!open.A}>
          직전 배치 재전송 → 0개 적재
        </button>
        <button onClick={() => resendAll('A')} disabled={!open.A}>
          처음부터 전부 재전송 (재연결)
        </button>
        <button onClick={() => toggleAutoLocation('A')} disabled={!open.A}>
          자동 전송 10초
        </button>
        <button onClick={resetSequence}>순번 초기화</button>
        <span>보낸 좌표 {trackSize}개</span>
      </section>

      {/* 종료 — ack가 오는 두 메시지 중 하나다 */}
      <section style={divider}>
        <strong style={{ width: 84 }}>러닝 종료</strong>
        <button onClick={() => sendFinish('A')} disabled={!open.A}>
          RUNNING_FINISH → RUNNING_FINISHED
        </button>
        <button onClick={() => sendFinish('A', true)} disabled={!open.A}>
          forced:true (조기 종료)
        </button>
        <button onClick={() => sendFinishTwice('A')} disabled={!open.A}>
          종료 ×2 (멱등 — 두 번째도 ack)
        </button>
        <button onClick={() => sendFinishWithFakeRoom('A')} disabled={!open.A}>
          roomId 999999 끼워넣기 → 무시
        </button>
      </section>

      <section style={divider}>
        <strong style={{ width: 84 }}>종료 실패</strong>
        <button onClick={() => send('A', runningFinish('{}'))} disabled={!open.A}>
          forced 없음 → INVALID_REQUEST
        </button>
        <button onClick={() => sendFinish('B')} disabled={!open.B}>
          B: START 없이 종료 → RUNNING_NOT_STARTED
        </button>
        <button onClick={() => sendStart('A')} disabled={!open.A}>
          종료한 방에 다시 START → INVALID_ROOM_STATE
        </button>
      </section>

      {/* 서버가 클라의 roomId를 안 읽는지 확인한다 */}
      <section style={divider}>
        <strong style={{ width: 84 }}>방 위조</strong>
        <button onClick={() => sendIgnoredRoomId('A')} disabled={!open.A}>
          roomId 999999 끼워넣기 → 무시되고 내 방에 저장
        </button>
        <button onClick={() => sendWithoutStart('B')} disabled={!open.B}>
          B: START 없이 좌표 → RUNNING_NOT_STARTED
        </button>
      </section>

      <section style={divider}>
        <strong style={{ width: 84 }}>위치 실패</strong>
        <button onClick={() => sendLocations('A', [])} disabled={!open.A}>
          빈 배열 → INVALID_REQUEST
        </button>
        <button onClick={() => sendLocations('A', [{ ...samplePoint(0), latitude: 999 }])}
                disabled={!open.A}>
          위도 999 → INVALID_REQUEST
        </button>
        <button onClick={() => sendLocations('A', [{ ...samplePoint(0), recordedAt: null }])}
                disabled={!open.A}>
          시각 없음 → INVALID_REQUEST
        </button>
        <button onClick={() => sendLocations('A', [{ ...samplePoint(0), sequence: null }])}
                disabled={!open.A}>
          순번 없음 → INVALID_REQUEST
        </button>
        <button onClick={() => sendPartialPoint('A')} disabled={!open.A}
                style={{ borderColor: '#c33', color: '#c33' }}>
          ⚠️ 선택 필드 누락 → 응답 없이 유실 (서버 NPE)
        </button>
      </section>

      <section style={divider}>
        <strong style={{ width: 84 }}>실패 케이스</strong>
        <button onClick={() => send('A', runningStart('{}'))} disabled={!open.A}>
          roomId 없음 → INVALID_REQUEST
        </button>
        <button onClick={() => send('A', runningStart('{"runningRoomId":999999}'))} disabled={!open.A}>
          없는 방 → ROOM_NOT_FOUND
        </button>
        <button onClick={() => send('A', runningStart('{"runningRoomId":"abc"}'))} disabled={!open.A}>
          타입 오류 → INVALID_REQUEST
        </button>
      </section>

      <section style={divider}>
        <strong style={{ width: 84 }}>봉투 단계</strong>
        {ENVELOPE_CASES.map(([label, payload]) => (
          <button key={label} onClick={() => send('A', payload)} disabled={!open.A}>{label}</button>
        ))}
        <button onClick={() => sendBinary('A')} disabled={!open.A}>바이너리 (1003)</button>
        <button onClick={toggleHeartbeat} disabled={!open.A}>자동 헬스 체크</button>
        <button onClick={() => setLogs([])}>지우기</button>
      </section>

      <pre style={{ background: '#f6f6f6', padding: 12, height: 420, overflow: 'auto' }}>
        {logs.map((entry, i) => (
          <div key={i} style={{ color: color[entry.kind] }}>
            {entry.at} [{entry.slot}] {entry.kind.padEnd(5)} {entry.text}
          </div>
        ))}
      </pre>
    </div>
  )
}
