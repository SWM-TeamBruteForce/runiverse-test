import { useEffect, useRef, useState } from 'react';

// 화면 맨 위에 보인다 — 이 글자가 안 보이면 예전 코드가 떠 있는 것이다(강력 새로고침)
const VERSION = 'v7 · forced=true 전용';

const API = '/api/v1';
const wsUrl = (token) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API}/ws/running?token=${encodeURIComponent(token)}`;
const WAIT_MS = 15_000;
const BATCH = 150;      // WS 수신 한도 64KB — 좌표 하나가 약 260B
const MAX_LOGS = 800;
const START_POINT = { lat: 37.4979, lng: 127.0276 }; // 강남역
const M_PER_DEG_LAT = 111_194.93;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((START_POINT.lat * Math.PI) / 180);
const MATCH_TARGET = 3000;
const TICK_MS = 10_000;        // 실제 앱처럼 10초마다 보낸다 — 콤보는 서버 수신 시각으로 판정한다
const COMBO_WAIT_MS = 80_000;
// 종료 메시지는 이것 하나뿐이다 — forced=false를 보내는 코드는 없다
const FINISH_FORCED = JSON.stringify({ event: 'RUNNING_FINISH', data: { forced: true } });

const RESULT_STYLE = {
  PASS: { bg: '#dcfce7', fg: '#166534' },
  FAIL: { bg: '#fee2e2', fg: '#991b1b' },
  RUNNING: { bg: '#e0e7ff', fg: '#3730a3' },
  SKIP: { bg: '#f3f4f6', fg: '#6b7280' },
  WAIT: { bg: '#fff', fg: '#9ca3af' },
};

const pad = (n, w = 2) => String(n).padStart(w, '0');
// 서버는 recordedAt을 오프셋 없는 KST LocalDateTime으로 받는다
const localIso = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const clock = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseLocal = (s) => new Date(s);

function Badge({ value }) {
  const s = RESULT_STYLE[value] ?? { bg: '#fee2e2', fg: '#991b1b' };
  return <span style={{ background: s.bg, color: s.fg, padding: '2px 8px', borderRadius: 999, fontWeight: 700, fontSize: 12 }}>{value}</span>;
}

// ── WS 클라이언트 ──
class RunningSocket {
  constructor(name, token, log) {
    this.name = name;
    this.token = token;
    this.log = log;
    this.ws = null;
    this.waiters = new Set();
    this.finished = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(this.token));
      this.ws = ws;
      ws.onopen = () => { this.log(this.name, '←', 'WS open'); resolve(); };
      ws.onerror = () => reject(new Error(`${this.name} WS 연결 실패`));
      ws.onclose = (e) => this.log(this.name, '✕', 'WS close', { code: e.code });
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.event === 'RUNNING_FINISHED') this.finished = true;
        if (!msg.event?.startsWith('HEALTH')) this.log(this.name, '←', msg.event, msg.data);
        for (const w of [...this.waiters]) {
          if (w.pred(msg)) { this.waiters.delete(w); clearTimeout(w.timer); w.hit(msg); }
        }
      };
    });
  }

  get isOpen() { return this.ws?.readyState === WebSocket.OPEN; }

  send(event, data = {}) {
    if (!this.isOpen) throw new Error(`${this.name} ${event}: WS가 닫혀 있다`);
    this.ws.send(JSON.stringify({ event, data }));
    const shown = event === 'RUNNING_LOCATION_UPDATE'
      ? { count: data.locations.length, sequence: `${data.locations[0].sequence}~${data.locations.at(-1).sequence}` }
      : data;
    this.log(this.name, '→', event, shown);
  }

  // 종료는 원문 그대로 보내고 원문을 로그에 남긴다 — 무엇을 보냈는지 화면에서 바로 확인한다
  sendFinishForced() {
    if (!this.isOpen) throw new Error(`${this.name} RUNNING_FINISH: WS가 닫혀 있다`);
    this.ws.send(FINISH_FORCED);
    this.log(this.name, '→', 'RUNNING_FINISH (원문)', FINISH_FORCED);
  }

  waitFor(pred, label, ms = WAIT_MS) {
    return new Promise((resolve, reject) => {
      const w = { pred, hit: resolve };
      w.timer = setTimeout(() => { this.waiters.delete(w); reject(new Error(`${this.name}: ${ms}ms 안에 오지 않음 — ${label}`)); }, ms);
      this.waiters.add(w);
    });
  }

  expectNone(pred, label, ms) {
    return new Promise((resolve, reject) => {
      const w = { pred, hit: (msg) => reject(new Error(`${this.name}: 오면 안 되는 메시지 — ${label} → ${JSON.stringify(msg.data)}`)) };
      w.timer = setTimeout(() => { this.waiters.delete(w); resolve(); }, ms);
      this.waiters.add(w);
    });
  }

  sendTrack(points) {
    for (let i = 0; i < points.length; i += BATCH) {
      this.send('RUNNING_LOCATION_UPDATE', { locations: points.slice(i, i + BATCH) });
    }
  }

  close() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close(1000, 'harness');
  }
}

// ── 트랙: 순번·시각을 기억한다. 방 하나에 사람마다 하나만 쓴다 ──
function createTrack(startMs) {
  const raw = [{ north: 0, east: 0, t: 0 }];
  let north = 0, east = 0, t = 0, sent = 0;
  const add = (n, e, dt) => { north = n; east = e; t += dt; raw.push({ north: n, east: e, t }); };
  const toPoint = (p, i) => ({
    sequence: i,
    latitude: +(START_POINT.lat + p.north / M_PER_DEG_LAT).toFixed(7),
    longitude: +(START_POINT.lng + p.east / M_PER_DEG_LNG).toFixed(7),
    altitudeMeters: 20,
    accuracyMeters: 5,
    speedMetersPerSecond: 3,
    headingDegrees: 0,
    cadenceSpm: 170,
    currentPaceSecondsPerKm: 333,
    recordedAt: localIso(new Date(startMs + p.t * 1000)),
  });
  const track = {
    run10s() { for (let i = 0; i < 10; i++) add(north + 3, east, 1); return track; },   // 10초 동안 3m/s 북쪽
    stand10s() {                                                                        // 10초 동안 제자리 ±1m
      const bn = north, be = east;
      for (let i = 1; i <= 5; i++) add(bn, be + (i % 2 ? -1 : 1), 2);
      north = bn; east = be;
      return track;
    },
    take() { const out = raw.slice(sent).map((p, k) => toPoint(p, sent + k)); sent = raw.length; return out; },
  };
  return track;
}

const isEvent = (event) => (m) => m.event === event;
const isComboWith = (peerId, pred) => (m) =>
  m.event === 'RUNNING_COMBO_UPDATED' && pred(m.data?.peers?.find((p) => p.userId === peerId));

// 새 연결로 끝낸다 — RUNNING_START가 같은 계정의 다른 연결(다른 탭·앱)을 4001로 끊은 뒤 forced=true를 보낸다.
// 서버는 forced=true에 거리 검사를 하지 않으므로 RUNNING_FINISHED만 돌아온다
async function finishFresh(name, token, roomId, log) {
  const sock = new RunningSocket(name, token, log);
  await sock.open();
  try {
    const started = sock.waitFor((m) => m.event === 'RUNNING_STARTED' || m.event === 'ERROR', 'RUNNING_STARTED');
    sock.send('RUNNING_START', { runningRoomId: roomId });
    const s = await started;
    if (s.event === 'ERROR') throw new Error(`${name} RUNNING_START 거절: ${s.data?.code}`);
    const fin = sock.waitFor((m) => m.event === 'RUNNING_FINISHED' || m.event === 'ERROR', 'RUNNING_FINISHED');
    sock.sendFinishForced();
    const f = await fin;
    if (f.event === 'ERROR') throw new Error(`${name} 종료 거절: ${f.data?.code}`);
    log(name, '·', `방 ${roomId} 종료 완료`);
  } finally {
    sock.close();
  }
}

// 10초마다 A·B가 함께 보낸다
async function stream(c, ticks, kind) {
  for (let i = 0; i < ticks; i++) {
    const startedAt = Date.now();
    for (const p of [c.a, c.b]) {
      if (kind === 'run') p.track.run10s(); else p.track.stand10s();
      if (p.sock.isOpen && !p.sock.finished) p.sock.sendTrack(p.track.take());
    }
    await sleep(Math.max(0, TICK_MS - (Date.now() - startedAt)));
  }
}

const comboText = (m, peerId) => {
  const p = m.data.peers.find((x) => x.userId === peerId);
  return `${p.comboCount}콤보 · 최고 ${p.maxComboCount} · 차 ${p.gapMeters}m`;
};

const STEPS = [
  {
    name: '둘 다 START', expect: 'RUNNING_STARTED',
    run: async (c) => {
      for (const p of [c.a, c.b]) {
        const ack = p.sock.waitFor(isEvent('RUNNING_STARTED'), 'RUNNING_STARTED');
        p.sock.send('RUNNING_START', { runningRoomId: c.roomId });
        await ack;
      }
      return '둘 다 시작';
    },
  },
  {
    name: '출발선 20초 (둘 다 제자리)', expect: '콤보 안 붙음',
    run: async (c) => {
      const none = c.a.sock.expectNone(isComboWith(c.b.userId, (p) => !!p), '출발선 콤보', 21_000);
      await stream(c, 2, 'stand');
      await none;
      return '콤보 없음';
    },
  },
  {
    name: '나란히 60초', expect: '콤보 3 이상',
    run: async (c) => {
      const reached = c.a.sock.waitFor(isComboWith(c.b.userId, (p) => p?.comboCount >= 3), '콤보 ≥3', COMBO_WAIT_MS);
      await stream(c, 6, 'run');
      return comboText(await reached, c.b.userId);
    },
  },
  {
    name: '둘 다 신호 대기 40초', expect: '끊김 → Redis seg에 구간 1',
    run: async (c) => {
      const broken = c.a.sock.waitFor(isComboWith(c.b.userId, (p) => !p), '콤보가 목록에서 빠짐', COMBO_WAIT_MS);
      await stream(c, 4, 'stand');
      await broken;
      return '끊김';
    },
  },
  {
    name: '다시 나란히 40초', expect: '새 콤보 2 이상',
    run: async (c) => {
      const again = c.a.sock.waitFor(isComboWith(c.b.userId, (p) => p?.comboCount >= 2), '새 콤보 ≥2', COMBO_WAIT_MS);
      await stream(c, 4, 'run');
      return comboText(await again, c.b.userId);
    },
  },
];

// 오늘(또는 내일) 신청할 수 있는 슬롯 — 마감(시작 − 오프셋)이 지나지 않은 것만
function availableSlots(closeOffsetMin) {
  const out = [];
  const now = Date.now();
  for (let day = 0; day < 2 && out.length < 6; day++) {
    for (let m = 18 * 60; m <= 22 * 60; m += 30) {
      const d = new Date();
      d.setDate(d.getDate() + day);
      d.setHours(Math.floor(m / 60), m % 60, 0, 0);
      if (d.getTime() - closeOffsetMin * 60_000 > now + 30_000) out.push(localIso(d));
    }
  }
  return out.slice(0, 6);
}

const ALL_STEPS = [...STEPS.map((s) => s.name), '둘 다 강제 종료 (새 연결 · forced=true)'];
const blank = () => ALL_STEPS.map(() => ({ result: 'WAIT', actual: '' }));

export default function App() {
  const [cred, setCred] = useState({ A: { email: '', password: '' }, B: { email: '', password: '' } });
  const [auth, setAuth] = useState({ A: null, B: null });
  const [results, setResults] = useState(blank());
  const [busy, setBusy] = useState(false);
  const [closeOffset, setCloseOffset] = useState(10);
  const [slot, setSlot] = useState('');
  const [match, setMatch] = useState(null); // { roomId, startAt }
  const [roomInput, setRoomInput] = useState('');
  const [now, setNow] = useState(Date.now());
  const [logs, setLogs] = useState([]);
  const startedRef = useRef(false);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { if (!slot) setSlot(availableSlots(closeOffset)[0] ?? ''); }, [closeOffset, slot]);

  const log = (who, dir, event, data = null) =>
    setLogs((prev) => [{ id: `${Date.now()}-${Math.random()}`, t: clock(), who, dir, event, data }, ...prev].slice(0, MAX_LOGS));

  const api = async (method, path, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    log('API', '→', `${method} ${path}`, body ?? null);
    const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    log('API', res.ok ? '←' : '✕', `${res.status} ${method} ${path}`, data);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.code ?? ''}`);
    return data;
  };

  const login = (who) => async () => {
    try {
      const c = cred[who];
      const d = await api('POST', '/auth/login', { email: c.email.trim().toLowerCase(), password: c.password }, null);
      setAuth((p) => ({ ...p, [who]: { token: d.accessToken, userId: d.userId } }));
    } catch { /* 로그에 남았다 */ }
  };

  // 둘 다 강제 종료 — 방 번호 칸이 비어 있으면 각자 지금 뛰고 있는 방을 서버에 물어본다
  const finishBoth = async (roomId) => {
    for (const who of ['A', 'B']) {
      if (!auth[who]) continue;
      try {
        let target = roomId;
        if (!target) {
          const s = await api('GET', '/users/me/status', null, auth[who].token);
          if (s.status !== 'RUNNING') { log(who, '·', '뛰고 있는 방 없음', { status: s.status }); continue; }
          target = s.runningRoomId;
        }
        await finishFresh(who, auth[who].token, Number(target), log);
      } catch (e) {
        log(who, '✕', '종료 실패', e.message);
      }
    }
  };

  // 남은 신청은 취소한다 — 활성 신청이 있으면 새로 신청할 수 없다
  const cancelWaiting = async (who) => {
    const s = await api('GET', '/users/me/status', null, auth[who].token);
    if (s.status === 'WAITING' || s.status === 'READY') await api('DELETE', '/running-matches', null, auth[who].token);
  };

  const applyMatch = async () => {
    setBusy(true);
    try {
      await finishBoth(null);
      await cancelWaiting('A');
      await cancelWaiting('B');
      const body = { scheduledStartAt: slot, targetDistanceMeters: MATCH_TARGET };
      const ra = await api('POST', '/running-matches', body, auth.A.token);
      const rb = await api('POST', '/running-matches', body, auth.B.token);
      if (ra.runningRoomId !== rb.runningRoomId) throw new Error(`서로 다른 방 A=${ra.runningRoomId} B=${rb.runningRoomId}`);
      startedRef.current = false;
      setResults(blank());
      setMatch({ roomId: ra.runningRoomId, startAt: parseLocal(slot).getTime() });
    } catch (e) {
      log('API', '✕', '매칭 신청 실패', e.message);
    }
    setBusy(false);
  };

  const mark = (i, result, actual = '') => setResults((r) => r.map((x, j) => (j === i ? { result, actual } : x)));

  const runCombo = async () => {
    setBusy(true);
    setResults(blank());
    const startMs = Date.now();
    const c = { roomId: match.roomId };
    try {
      c.a = { name: 'A', ...auth.A, track: createTrack(startMs), sock: new RunningSocket('A', auth.A.token, log) };
      c.b = { name: 'B', ...auth.B, track: createTrack(startMs), sock: new RunningSocket('B', auth.B.token, log) };
      await c.a.sock.open();
      await c.b.sock.open();
      let failed = false;
      for (let i = 0; i < STEPS.length; i++) {
        if (failed) { mark(i, 'SKIP'); continue; }
        mark(i, 'RUNNING');
        log('·', '·', `── ${i + 1}. ${STEPS[i].name}`);
        try {
          mark(i, 'PASS', await STEPS[i].run(c));
        } catch (e) {
          failed = true;
          mark(i, 'FAIL', e.message);
        }
      }
    } catch (e) {
      log('·', '✕', '연결 실패', e.message);
    }
    // 어디서 멈췄든 새 연결·forced=true로 둘 다 끝낸다 — 방이 닫혀야 콤보가 저장된다
    c.a?.sock.close();
    c.b?.sock.close();
    const last = STEPS.length;
    mark(last, 'RUNNING');
    try {
      await finishFresh('A', auth.A.token, c.roomId, log);
      await finishFresh('B', auth.B.token, c.roomId, log);
      mark(last, 'PASS', `방 ${c.roomId} 닫힘 — 서버 로그 "콤보 저장 …" 확인`);
    } catch (e) {
      mark(last, 'FAIL', e.message);
    }
    setBusy(false);
  };

  // 시작 시각 + 3초에 자동 실행
  useEffect(() => {
    if (match && !startedRef.current && now >= match.startAt + 3000) {
      startedRef.current = true;
      runCombo();
    }
  }, [now, match]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = { border: '1px solid #d1d5db', borderRadius: 8, padding: 12, marginBottom: 12 };
  const row = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 };
  const btn = (color = '#111827') => ({ padding: '5px 12px', borderRadius: 6, border: `1px solid ${color}`, background: '#fff', color, cursor: 'pointer' });
  const secondsLeft = match ? Math.max(0, Math.round((match.startAt - now) / 1000)) : null;
  const expects = [...STEPS.map((s) => s.expect), '둘 다 RUNNING_FINISHED → 방 FINISHED → 콤보 저장'];

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16, color: '#111827', maxWidth: 1100 }}>
      <h2 style={{ marginTop: 0 }}>콤보 저장 확인 <span style={{ fontSize: 14, color: '#dc2626' }}>{VERSION}</span></h2>

      <div style={box}>
        <b>1. 로그인</b> <small style={{ color: '#6b7280' }}>— 온보딩을 마친 계정 둘</small>
        {['A', 'B'].map((who) => (
          <div key={who} style={row}>
            <b style={{ width: 20 }}>{who}</b>
            <input value={cred[who].email} placeholder="email" style={{ width: 200 }}
              onChange={(e) => setCred((p) => ({ ...p, [who]: { ...p[who], email: e.target.value } }))} />
            <input value={cred[who].password} placeholder="password" type="password"
              onChange={(e) => setCred((p) => ({ ...p, [who]: { ...p[who], password: e.target.value } }))} />
            <button style={btn()} onClick={login(who)}>로그인</button>
            {auth[who] && <span style={{ fontSize: 13 }}>userId {auth[who].userId}</span>}
          </div>
        ))}
      </div>

      <div style={box}>
        <b>2. 지금 열린 방 강제 종료</b>
        <div style={row}>
          <input value={roomInput} placeholder="방 번호 (비우면 각자 뛰는 방)" style={{ width: 220 }}
            onChange={(e) => setRoomInput(e.target.value.replace(/\D/g, ''))} />
          <button style={btn('#dc2626')} disabled={!auth.A || !auth.B}
            onClick={() => finishBoth(roomInput ? Number(roomInput) : null)}>둘 다 강제 종료 (forced=true)</button>
          <small style={{ color: '#6b7280' }}>새 연결로 RUNNING_START → forced=true. 같은 계정의 다른 탭·앱 연결은 서버가 끊는다</small>
        </div>
      </div>

      <div style={box}>
        <b>3. 신청 → 시작 시각에 자동 실행 (약 3분)</b>
        <div style={row}>
          <span>마감 오프셋(분)</span>
          <input type="number" value={closeOffset} style={{ width: 60 }}
            onChange={(e) => { setCloseOffset(+e.target.value); setSlot(''); }} />
          <select value={slot} onChange={(e) => setSlot(e.target.value)}>
            {availableSlots(closeOffset).map((s) => <option key={s} value={s}>{s.replace('T', ' ')}</option>)}
          </select>
          <button style={btn('#2563eb')} onClick={applyMatch} disabled={!auth.A || !auth.B || busy || !slot}>둘 다 신청</button>
          {match && (
            <span style={{ fontSize: 13 }}>
              방 {match.roomId} · {secondsLeft > 0 ? `${Math.floor(secondsLeft / 60)}분 ${secondsLeft % 60}초 뒤 시작` : '시작됨'}
            </span>
          )}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #d1d5db' }}>
              <th style={{ width: 30 }}>#</th><th>단계</th><th>기대</th><th style={{ width: 80 }}>결과</th><th>실제</th>
            </tr>
          </thead>
          <tbody>
            {ALL_STEPS.map((name, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                <td>{i + 1}</td><td><b>{name}</b></td><td style={{ color: '#4b5563' }}>{expects[i]}</td>
                <td><Badge value={results[i].result} /></td>
                <td style={{ color: results[i].result === 'FAIL' ? '#991b1b' : '#111827' }}>{results[i].actual}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={box}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <b>4. 로그</b>
          <button style={btn()} onClick={() => setLogs([])}>지우기</button>
        </div>
        <div style={{ maxHeight: 400, overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 12, marginTop: 6 }}>
          {logs.map((l) => {
            const color = l.dir === '✕' ? '#dc2626' : l.dir === '→' ? '#2563eb' : l.dir === '←' ? '#16a34a' : '#6b7280';
            return (
              <details key={l.id} style={{ borderBottom: '1px dashed #e5e7eb' }}>
                <summary style={{ color, cursor: 'pointer' }}>
                  {l.t} [{l.who}] {l.dir} {l.event}
                  {l.event === 'RUNNING_FINISH (원문)' && <> <b>{l.data}</b></>}
                  {l.event === 'RUNNING_COMBO_UPDATED' && <> <b>{
                    l.data?.peers?.length
                      ? l.data.peers.map((p) => `${p.comboCount}콤보(최고 ${p.maxComboCount}, 차 ${p.gapMeters}m)`).join(' · ')
                      : '콤보 없음'
                  }</b></>}
                  {l.event === 'ERROR' && <> <b>{l.data?.code}</b></>}
                </summary>
                <pre style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{typeof l.data === 'string' ? l.data : JSON.stringify(l.data, null, 2)}</pre>
              </details>
            );
          })}
        </div>
      </div>
    </div>
  );
}
