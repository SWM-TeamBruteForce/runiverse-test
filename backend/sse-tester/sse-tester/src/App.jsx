import { useCallback, useEffect, useRef, useState } from "react";

const BASE = "/api/v1";
const WS_PATH = `${BASE}/ws/running`;
const DISTANCES = [3000, 5000, 10000];

// ── 서버 설정(application.properties)과 맞물린 값. 한쪽만 고치면 어긋난다 ──────────
const HEALTH_MS = 20_000;      // websocket.idle-timeout=2m 보다 충분히 짧게
const DEAD_MS = 45_000;        // 이만큼 아무 프레임도 안 오면 죽은 연결로 보고 다시 붙는다
const BATCH_MS = 10_000;       // 위치 배치 주기 (api-spec 5-D)
const SAMPLE_MS = 1_000;       // 좌표 수집 주기 — 배치 하나에 10점
const RESEND_CHUNK = 100;      // websocket.max-text-message-buffer-size=64KB를 넘기지 않으려고 쪼갠다
const COMBO_WINDOW_M = 30;     // running-combo.enter-meters
const COMBO_TICK_MS = 10_000;  // running-combo.tick
const SUPERSEDED = 4001;       // 같은 유저의 새 연결이 이어받았다 — 재연결하면 안 된다
const BACKOFF_MS = [1000, 2000, 3000, 5000, 8000, 10_000];
// 도메인 Pace.MIN=120초/km — 평균이 이보다 빠르면 서버가 기록을 만들지 않는다.
// 자동 종료는 되지만 확정 거리가 0m가 돼 매칭 방에서는 RUNNING_LEFT_PENALTY로 끝난다
const MAX_AVG_SPEED = 1000 / 120;   // 8.33m/s
const TOP_SPEED = 8.0;              // 한계 바로 아래 — 125초/km

// 18:00~22:00 30분 간격 — 서버 ApplyMatchRequest 검증과 같은 규칙
function slots(dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
  const out = [];
  for (let h = 17; h <= 22; h++) {
    for (const m of h === 22 ? [0] : [0, 30]) {
      out.push(`${ymd}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
    }
  }
  return out;
}

const ALL_SLOTS = [...slots(0), ...slots(1)];

// 지금부터 N분 뒤에 이벤트가 터지게 하려면 오프셋을 얼마로 둬야 하는지
function offsetFor(slot, minutesFromNow) {
  const ms = new Date(slot).getTime() - Date.now() - minutesFromNow * 60_000;
  if (ms <= 0) return "이미 지난 슬롯";
  const total = Math.round(ms / 60_000);
  return `${Math.floor(total / 60)}h${total % 60}m`;
}

// 카운트다운은 언제나 슬롯 3초 전이다 — 오프셋으로 못 당긴다
function countdownAt(slot) {
  const t = new Date(new Date(slot).getTime() - 3_000);
  return t.toLocaleTimeString("ko-KR", { hour12: false });
}

// 서버 LocalDateTime은 오프셋 없는 초 단위다(api-convention) — 밀리초·Z를 붙이면 파싱이 깨진다
function toLocalIso(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

// ── 가상 러너 ────────────────────────────────────────────────────────────────
// 콤보는 좌표 근접이 아니라 **누적 주행 거리 차**로 판정한다(feature-spec 러닝 콤보 절).
//
// 속도를 흔들면 두 사람의 속도 차가 적분돼 몇 분 만에 창(30m)을 넘어 콤보가 끊긴다.
// 위치에 사인파를 얹고 두 패널의 위상을 반대로 두면 거리 차의 상한이 2×swing으로 고정된다 —
// 순간 페이스는 계속 다른데 절대 멀어지지 않는다.
//
//   거리 = V·t + 위상·S·sin(2πt/T)      → 두 패널의 차 = 2S·sin(...)
//   속도 = V + 위상·S·(2π/T)·cos(2πt/T)
//
// 기본값은 자동 종료 확인용 최고 속도(8m/s, 흔들림 0)다 — 흔들림을 주면 순간 속도가
// 한계(8.33m/s)를 넘는 구간이 생긴다. 콤보를 볼 때는 속도 3 / 흔들림 10으로 되돌린다
const ORIGIN = { lat: 37.4979, lng: 127.0276 };   // 강남역
const M_PER_DEG_LAT = 111_320;
const TWO_PI = Math.PI * 2;

function runnerAt(cfg, seconds) {
  const w = TWO_PI / cfg.periodSec;
  const meters = cfg.speed * seconds + cfg.phase * cfg.swing * Math.sin(w * seconds);
  const speed = cfg.speed + cfg.phase * cfg.swing * w * Math.cos(w * seconds);
  return {
    meters,
    speed,
    // 위도만 올린다 — 북쪽 직선이라 `속도 × 경과초`로 손검산이 된다
    latitude: ORIGIN.lat + meters / M_PER_DEG_LAT,
    longitude: ORIGIN.lng,
  };
}

// ⚠️ 뒤로 가면 서버 누적 거리가 줄지 않고 **더해진다**(거리는 방향 무관 이동량이다).
// 흔들림이 기준 속도를 이기는 설정은 시작 전에 막는다
function goesBackward(cfg) {
  return cfg.speed <= cfg.swing * (TWO_PI / cfg.periodSec);
}

// 평균 속도가 페이스 하한을 넘으면 기록이 안 남는다 — 시작 전에 막는다
function tooFast(cfg) {
  return cfg.speed > MAX_AVG_SPEED;
}

function paceOf(metersPerSecond) {
  if (!metersPerSecond || metersPerSecond <= 0) return "-";
  const sec = 1000 / metersPerSecond;
  return `${Math.floor(sec / 60)}'${String(Math.round(sec % 60)).padStart(2, "0")}"`;
}

function paceText(secondsPerKm) {
  if (secondsPerKm == null) return "-";
  return `${Math.floor(secondsPerKm / 60)}'${String(secondsPerKm % 60).padStart(2, "0")}"`;
}

function UserPanel({ label, phase }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [myUserId, setMyUserId] = useState(null);
  const [slot, setSlot] = useState(ALL_SLOTS[0]);
  const [distance, setDistance] = useState(3000);
  const [room, setRoom] = useState(null);
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);

  // RUNNING_READY 관련
  const [ready, setReady] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [skewMs, setSkewMs] = useState(null);
  // 테스트용 — startsInMs를 무시하고 이 값(ms)으로 발사 타이머를 건다
  const [forceMs, setForceMs] = useState("");

  // WS 관련
  const [wsState, setWsState] = useState("닫힘");
  const [closeInfo, setCloseInfo] = useState(null);
  const [retry, setRetry] = useState(0);
  const [roomIdInput, setRoomIdInput] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [progress, setProgress] = useState({});
  const [peers, setPeers] = useState([]);
  const [myMeters, setMyMeters] = useState(0);
  const [mySpeed, setMySpeed] = useState(0);
  const [sent, setSent] = useState({ points: 0, batches: 0 });
  const [cfg, setCfg] = useState({ speed: TOP_SPEED, swing: 0, periodSec: 120, phase });
  // 테스트용 — RUNNING_STARTED 때 이만큼 앞서 출발한 것처럼 과거 좌표를 채운다
  const [preRollSec, setPreRollSec] = useState("");
  const [finishedBy, setFinishedBy] = useState(null);   // "auto" | "ack"

  const abortRef = useRef(null);
  const tokenRef = useRef("");
  const forceRef = useRef("");
  const launchRef = useRef(null);
  const tickRef = useRef(null);

  const wsRef = useRef(null);
  const wantWsRef = useRef(false);     // 사용자가 붙어 있기를 원하는가 — 재연결의 유일한 기준
  const startedRef = useRef(false);    // 발사 시각을 지났는가 — 열리자마자 RUNNING_START를 보낼지 가른다
  const roomIdRef = useRef(null);
  const retryRef = useRef(0);
  const reconnectRef = useRef(null);
  const healthRef = useRef(null);
  const watchdogRef = useRef(null);
  const lastFrameRef = useRef(0);
  const sampleRef = useRef(null);
  const batchRef = useRef(null);
  const trackRef = useRef([]);         // 로컬 트랙 — RUNNING_FINISHED 전까지 안 지운다
  const sentIndexRef = useRef(0);
  const resendRef = useRef(false);     // 재연결이면 트랙을 처음부터 다시 올린다
  const runStartRef = useRef(null);
  const cfgRef = useRef(cfg);
  const preRollRef = useRef("");
  const finishRequestedRef = useRef(false);   // RUNNING_FINISHED가 ack인지 자동 종료인지 가른다

  const log = useCallback((kind, text) => {
    const at = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    setLogs((prev) => [{ at, kind, text }, ...prev].slice(0, 300));
  }, []);

  // 스트림·소켓 콜백은 최초 렌더의 클로저에 갇힌다 — 최신 값을 ref로 미러한다
  useEffect(() => {
    forceRef.current = forceMs;
  }, [forceMs]);
  useEffect(() => {
    cfgRef.current = cfg;
  }, [cfg]);
  useEffect(() => {
    preRollRef.current = preRollSec;
  }, [preRollSec]);

  // 패널이 사라질 때 타이머·소켓이 남으면 지워진 컴포넌트에 setState를 한다
  useEffect(() => () => {
    wantWsRef.current = false;
    clearTimers();
    stopRunTimers();
    clearTimeout(reconnectRef.current);
    clearInterval(healthRef.current);
    clearInterval(watchdogRef.current);
    wsRef.current?.close();
    abortRef.current?.abort();
  }, []);

  async function call(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return parsed;
  }

  function saveToken(value) {
    tokenRef.current = value;
    setToken(value);
  }

  async function login() {
    try {
      const r = await call("POST", "/auth/login", { email, password });
      saveToken(r.accessToken);
      setMyUserId(r.userId);
      log("ok", `로그인 — userId=${r.userId}`);
    } catch (e) {
      log("err", `로그인 실패 — ${e.message}`);
    }
  }

  function clearTimers() {
    clearTimeout(launchRef.current);
    clearInterval(tickRef.current);
    launchRef.current = null;
    tickRef.current = null;
    setCountdown(null);
  }

  // 서버가 준 남은 시간으로 발사 타이머를 건다.
  // 3-2-1은 그 타이머에서 파생한다 — 연출은 줄여도 발사 시각은 앞당기지 않는다(api-spec 5-C)
  function scheduleLaunch(ms) {
    clearTimers();
    const launchAt = Date.now() + ms;

    tickRef.current = setInterval(() => {
      const left = launchAt - Date.now();
      if (left <= 3000) setCountdown(Math.max(0, Math.ceil(left / 1000)));
      if (left <= 0) clearInterval(tickRef.current);
    }, 100);

    launchRef.current = setTimeout(() => {
      setCountdown(0);
      log("started", "🏃 발사 시각 도달 — RUNNING_START 전송");
      startedRef.current = true;
      if (wsRef.current?.readyState === WebSocket.OPEN) sendStart();
      else openWs();   // 아직 안 열렸으면 열리는 즉시 보낸다
    }, ms);
  }

  // RUNNING_READY — 이 이벤트만 RoomInfo가 아니다
  function onRunningReady(p) {
    const receivedAt = Date.now();
    // scheduledStartAt은 오프셋 없는 KST라 브라우저가 로컬 시각으로 파싱한다
    const startAtLocal = new Date(p.scheduledStartAt).getTime();
    // 서버 기준 '지금' = 시작 시각 - 남은 시간. 내 시계와의 차이가 곧 오차다
    const serverNow = startAtLocal - p.startsInMs;
    const skew = receivedAt - serverNow;

    setSkewMs(skew);
    setReady(p);
    roomIdRef.current = p.runningRoomId;
    setRoomIdInput(String(p.runningRoomId));

    const force = forceRef.current;
    const waitMs = force === "" ? p.startsInMs : Number(force);
    log(
      "ready",
      `RUNNING_READY — 남은 ${p.startsInMs}ms / 내 시계 오차 ${skew}ms` +
        (force === "" ? "" : ` / 테스트 강제 ${waitMs}ms`)
    );
    // 미리 붙어 둔다 — 정각에 붙으면 핸드셰이크 왕복만큼 출발이 밀린다(api-spec 5-C 1번)
    openWs();
    scheduleLaunch(waitMs);
  }

  // ── SSE ───────────────────────────────────────────────────────────────────
  // EventSource는 Authorization 헤더를 못 붙인다 — fetch 스트림으로 SSE를 직접 읽는다
  async function connect() {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setConnected(true);
    log("sys", "스트림 연결 시도");
    try {
      const res = await fetch(`${BASE}/running-matches/stream`, {
        headers: {
          Authorization: `Bearer ${tokenRef.current}`,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      log("ok", "스트림 연결됨");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        // SSE 프레임 구분자는 빈 줄이다
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          handleFrame(buffer.slice(0, i));
          buffer = buffer.slice(i + 2);
        }
      }
      log("sys", "스트림 종료(서버가 닫음)");
    } catch (e) {
      if (e.name !== "AbortError") log("err", `스트림 오류 — ${e.message}`);
    } finally {
      setConnected(false);
      abortRef.current = null;
    }
  }

  function handleFrame(raw) {
    let name = "message";
    const data = [];
    for (const line of raw.split("\n")) {
      // ": ping" — 프록시 유휴 타임아웃 방지용 주석
      if (line.startsWith(":")) {
        log("ping", line.slice(1).trim() || "ping");
        return;
      }
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    try {
      const parsed = JSON.parse(data.join("\n"));
      if (name === "RUNNING_READY") {
        // RoomInfo가 아니라 발사 기준값이다 — 방 화면을 덮어쓰면 안 된다
        onRunningReady(parsed);
        return;
      }
      setRoom(parsed);
      if (parsed.runningRoomId) {
        roomIdRef.current = parsed.runningRoomId;
        setRoomIdInput(String(parsed.runningRoomId));
      }
      log(name === "MATCH_STARTED" ? "started" : "event", `${name} — ${summarize(parsed)}`);
    } catch {
      log("event", `${name} — ${data.join("\n")}`);
    }
  }

  function disconnect() {
    abortRef.current?.abort();
    clearTimers();
    log("sys", "스트림 끊음(클라)");
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // 브라우저 WebSocket은 헤더를 못 붙인다 — vite.config.js의 프록시가 이 토큰을
    // Authorization 헤더로 옮겨 서버에 올린다. 서버 계약은 헤더 그대로다
    return `${proto}//${location.host}${WS_PATH}?token=${encodeURIComponent(tokenRef.current)}`;
  }

  function openWs() {
    if (!tokenRef.current) return log("err", "토큰이 없다 — 먼저 로그인");
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;
    clearTimeout(reconnectRef.current);
    wantWsRef.current = true;
    setWsState("연결중");

    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState("열림");
      setCloseInfo(null);
      retryRef.current = 0;
      setRetry(0);
      lastFrameRef.current = Date.now();
      log("ws", "WS 열림");
      startHealth();
      startWatchdog();
      // 발사 전에는 붙어만 있는다 — RUNNING_START는 정각에 나간다.
      // 재연결이면 이미 발사를 지났으니 여기서 바로 다시 보낸다(멱등, api-spec 5-C)
      if (startedRef.current) sendStart();
    };

    ws.onmessage = (event) => {
      lastFrameRef.current = Date.now();
      let envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch {
        return log("err", `WS 파싱 실패 — ${event.data}`);
      }
      onWsEvent(envelope.event, envelope.data ?? {});
    };

    ws.onerror = () => log("err", "WS 오류(브라우저는 이유를 안 알려준다 — 아래 close code를 본다)");

    ws.onclose = (e) => {
      stopHealth();
      stopWatchdog();
      // 좌표 수집은 멈추지 않는다 — 끊긴 동안에도 앱은 로컬 트랙을 쌓고,
      // 다시 붙으면 통째로 올린다. 여기서 멈추면 그 구간이 트랙에서 통으로 빈다
      wsRef.current = null;
      const why = closeReason(e.code);
      setCloseInfo({ code: e.code, reason: e.reason || why });
      setWsState("닫힘");
      log("err", `WS 닫힘 — code=${e.code} (${why}) ${e.reason || ""}`);

      if (e.code === SUPERSEDED) {
        // 다른 기기가 이어받았다 — 여기서 다시 붙으면 서로 상대를 끊는 싸움이 된다(api-spec 5-C)
        wantWsRef.current = false;
        stopRunTimers();
        return log("err", "4001 — 다른 연결이 이어받았다. 재연결하지 않는다");
      }
      if (!wantWsRef.current) return;

      const wait = BACKOFF_MS[Math.min(retryRef.current, BACKOFF_MS.length - 1)];
      retryRef.current += 1;
      setRetry(retryRef.current);
      setWsState(`재연결 대기 ${wait / 1000}초`);
      log("ws", `${wait}ms 뒤 재연결 (${retryRef.current}번째)`);
      // 트랙은 남겨둔다 — 다시 붙으면 처음 sequence부터 통째로 올린다
      resendRef.current = trackRef.current.length > 0;
      reconnectRef.current = setTimeout(openWs, wait);
    };
  }

  function closeWs(manual) {
    if (manual) {
      wantWsRef.current = false;
      stopRunTimers();   // 되돌아올 생각이 없으면 좌표도 그만 쌓는다
    }
    clearTimeout(reconnectRef.current);
    wsRef.current?.close(1000, "client");
  }

  function sendJson(eventName, data) {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ event: eventName, data: data ?? {} }));
    return true;
  }

  function sendStart() {
    const roomId = roomIdRef.current ?? Number(roomIdInput);
    if (!roomId) return log("err", "runningRoomId가 없다 — 방 번호를 넣거나 매칭부터");
    roomIdRef.current = Number(roomId);
    if (sendJson("RUNNING_START", { runningRoomId: Number(roomId) })) {
      log("ws", `RUNNING_START 전송 — 방 ${roomId}`);
    }
  }

  // 유휴로 끊기는 것을 막는 유일한 장치.
  // 서버 websocket.idle-timeout=2m 이고, 이 하네스는 20초마다 보낸다.
  // ⚠️ 탭이 백그라운드면 브라우저가 타이머를 분 단위로 늦춘다 — 20초 설정이 60초로 밀린다.
  //    2분 안에는 들어가 연결은 살지만, 좌표 배치도 같이 밀려 콤보 신선도(19초)를 넘긴다.
  //    콤보를 보려면 탭을 앞에 두거나 두 창을 나란히 띄운다
  function startHealth() {
    stopHealth();
    healthRef.current = setInterval(() => sendJson("HEALTH_CHECK", {}), HEALTH_MS);
  }

  function stopHealth() {
    clearInterval(healthRef.current);
    healthRef.current = null;
  }

  // 케이블이 뽑히거나 NAT가 끊으면 onclose가 안 온다 — 소켓은 열린 척 남는다.
  // HEALTH_CHECKED가 20초마다 오므로 45초 침묵은 죽은 연결이다. 직접 닫아 재연결을 깨운다
  function startWatchdog() {
    stopWatchdog();
    watchdogRef.current = setInterval(() => {
      if (Date.now() - lastFrameRef.current < DEAD_MS) return;
      log("err", `${DEAD_MS / 1000}초 동안 프레임 없음 — 죽은 연결로 보고 다시 붙는다`);
      wsRef.current?.close(4000, "watchdog");
    }, 5000);
  }

  function stopWatchdog() {
    clearInterval(watchdogRef.current);
    watchdogRef.current = null;
  }

  // 소켓 콜백에서는 state가 옛 값이다 — 트랙의 마지막 점에서 거리를 다시 낸다
  function trackMeters() {
    const last = trackRef.current.at(-1);
    return last ? Math.round((last.latitude - ORIGIN.lat) * M_PER_DEG_LAT) : 0;
  }

  function onWsEvent(name, data) {
    switch (name) {
      case "HEALTH_CHECKED":
        return;   // 로그를 더럽히지 않는다 — 살아 있다는 사실은 watchdog가 쓴다
      case "RUNNING_STARTED": {
        setSnapshot(data);
        setPeers(data.comboPeers ?? []);
        if (runStartRef.current == null) {
          const pre = Math.max(0, Number(preRollRef.current) || 0);
          runStartRef.current = Date.now() - pre * 1000;
          // 과거 시각으로 1초 간격 좌표를 채운다 — 미래 시각이 아니라 서버가 받아 준다
          for (let s = 0; s < pre; s++) pushPoint(runStartRef.current + s * 1000);
          if (pre > 0) log("ws", `선행 주행 ${pre}초 — ${trackRef.current.length}점 채움(약 ${trackMeters()}m)`);
        }
        log("started", `RUNNING_STARTED — 방 ${data.runningRoomId} / ${data.players?.length ?? 0}명 / 목표 ${data.targetDistanceMeters ?? "없음"}`);
        if (data.targetDistanceMeters == null) {
          log("err", "목표 없는 방(솔로)이다 — 자동 종료는 돌지 않는다. 매칭 방으로 테스트한다");
        }
        // ack를 받으면 SSE는 할 일이 끝났다(api-spec 5-C 5번)
        disconnect();
        if (resendRef.current) resendTrack();
        startRunTimers();
        return;
      }
      case "RUNNING_PROGRESS_UPDATED":
        setProgress((prev) => ({ ...prev, [data.userId]: data }));
        log("event", `진행 — ${short(data.userId)} ${data.distanceMeters}m / ${paceText(data.currentPaceSecondsPerKm)}`);
        return;
      case "RUNNING_COMBO_UPDATED":
        // 받는 사람의 상태 전체다 — 끊긴 상대는 목록에서 빠진다. 통째로 갈아끼운다
        setPeers(data.peers ?? []);
        log("combo", (data.peers ?? []).length === 0
          ? "콤보 없음(전부 끊김)"
          : data.peers.map((p) => `${short(p.userId)} 차${p.gapMeters}m 콤보${p.comboCount}(최고${p.maxComboCount})`).join(" · "));
        return;
      case "RUNNING_FINISHED": {
        stopRunTimers();
        // 로컬 트랙을 지우기 전에 거리를 남긴다
        const auto = !finishRequestedRef.current;
        const meters = trackMeters();
        setFinishedBy(auto ? "auto" : "ack");
        log("started", auto
          ? `🏁 RUNNING_FINISHED(자동 종료 — RUNNING_FINISH 안 보냄) — 내 거리 약 ${meters}m`
          : `RUNNING_FINISHED(ack) — 내 거리 약 ${meters}m`);
        // 로컬 트랙을 지운다(api-spec 5-D) — ack든 자동 종료든 같다.
        // 늦게 온 배치 때문에 한 번 더 와도 여기서 같은 처리를 반복할 뿐이다
        trackRef.current = [];
        sentIndexRef.current = 0;
        runStartRef.current = null;
        finishRequestedRef.current = false;
        startedRef.current = false;
        wantWsRef.current = false;
        log("sys", `결과 확인: GET ${BASE}/running-rooms/${roomIdRef.current}/results`);
        return;
      }
      case "ERROR":
        log("err", `ERROR — ${data.code} / ${data.message} (${data.sourceType ?? "-"})`);
        // 재연결 뒤 START가 밀렸다는 뜻이다 — 다시 보내면 이어진다
        if (data.code === "RUNNING_NOT_STARTED") sendStart();
        return;
      default:
        log("event", `${name} — ${JSON.stringify(data)}`);
    }
  }

  // ── 가상 좌표 송신 ─────────────────────────────────────────────────────────
  function startRunTimers() {
    stopRunTimers();
    if (goesBackward(cfgRef.current)) {
      return log("err", "설정이 뒤로 간다 — 흔들림이 속도를 이긴다. 서버 거리는 뒤로 가도 더해진다");
    }
    if (tooFast(cfgRef.current)) {
      return log("err", `너무 빠르다 — 평균 ${MAX_AVG_SPEED.toFixed(2)}m/s(120초/km)를 넘으면 기록이 안 남아 0m 판정이 된다`);
    }
    // 좌표는 벽시계 경과로 만든다 — 타이머가 밀려도 위치가 느려지지 않는다
    sampleRef.current = setInterval(sample, SAMPLE_MS);
    batchRef.current = setInterval(flush, BATCH_MS);
    sample();
    // 선행 주행으로 쌓인 좌표는 첫 배치를 기다리지 않고 바로 올린다
    if (trackRef.current.length > 1) flush();
  }

  function stopRunTimers() {
    clearInterval(sampleRef.current);
    clearInterval(batchRef.current);
    sampleRef.current = null;
    batchRef.current = null;
  }

  function sample() {
    if (runStartRef.current == null) return;
    pushPoint(Date.now());
  }

  function pushPoint(atMs) {
    const seconds = (atMs - runStartRef.current) / 1000;
    const point = runnerAt(cfgRef.current, seconds);
    trackRef.current.push({
      sequence: trackRef.current.length,
      latitude: Number(point.latitude.toFixed(7)),
      longitude: Number(point.longitude.toFixed(7)),
      altitudeMeters: 18.4,
      accuracyMeters: 5.0,
      speedMetersPerSecond: Number(point.speed.toFixed(2)),
      headingDegrees: 0.0,
      cadenceSpm: 165,
      currentPaceSecondsPerKm: Math.round(1000 / point.speed),
      recordedAt: toLocalIso(new Date(atMs)),
    });
    setMyMeters(Math.round(point.meters));
    setMySpeed(point.speed);
  }

  // 선행 주행이면 첫 배치가 수백 점이다 — 한 프레임에 담으면 64KB를 넘겨 1009로 끊긴다
  function flush() {
    const pending = trackRef.current.slice(sentIndexRef.current);
    if (!pending.length) return;
    for (let i = 0; i < pending.length; i += RESEND_CHUNK) {
      const chunk = pending.slice(i, i + RESEND_CHUNK);
      if (!sendJson("RUNNING_LOCATION_UPDATE", { locations: chunk })) return;
      sentIndexRef.current += chunk.length;
      setSent((prev) => ({ points: prev.points + chunk.length, batches: prev.batches + 1 }));
    }
  }

  // 재연결하면 처음 sequence부터 통째로 다시 올린다 — ack가 없어 성공 경계를 모른다.
  // 서버는 (방, 유저, sequence)가 같은 좌표를 무시한다(api-spec 5-D).
  // ⚠️ 한 프레임에 다 담으면 64KB 버퍼를 넘겨 연결이 끊긴다(1009) — 100점씩 쪼갠다
  function resendTrack() {
    resendRef.current = false;
    const all = trackRef.current;
    for (let i = 0; i < all.length; i += RESEND_CHUNK) {
      sendJson("RUNNING_LOCATION_UPDATE", { locations: all.slice(i, i + RESEND_CHUNK) });
    }
    sentIndexRef.current = all.length;
    log("ws", `재연결 — 트랙 ${all.length}점 재전송(${Math.ceil(all.length / RESEND_CHUNK)}프레임)`);
  }

  function finish(forced) {
    finishRequestedRef.current = true;
    if (sendJson("RUNNING_FINISH", { forced })) log("ws", `RUNNING_FINISH(forced=${forced}) 전송`);
  }

  // ── 매칭 REST ─────────────────────────────────────────────────────────────
  async function apply() {
    try {
      const r = await call("POST", "/running-matches", {
        scheduledStartAt: slot,
        targetDistanceMeters: distance,
      });
      log("ok", `신청 성공 — runningRoomId=${r.runningRoomId}`);
      // 스펙상 신청 성공 직후에 연다 — 활성 신청이 없으면 서버가 보낼 게 없다(api-spec 5-A)
      if (!abortRef.current) connect();
    } catch (e) {
      log("err", `신청 실패 — ${e.message}`);
    }
  }

  async function cancel() {
    try {
      await call("DELETE", "/running-matches");
      setRoom(null);
      setReady(null);
      setSkewMs(null);
      clearTimers();
      log("ok", "취소 성공 (204)");
      // 취소하면 클라가 스트림을 닫는다(api-spec 5-A)
      disconnect();
    } catch (e) {
      log("err", `취소 실패 — ${e.message}`);
    }
  }

  const backward = goesBackward(cfg);
  const fast = tooFast(cfg);
  const maxGap = 2 * cfg.swing;
  const swingSpeed = cfg.swing * (TWO_PI / cfg.periodSec);
  const target = snapshot?.targetDistanceMeters ?? distance;
  // 선행 없이 뛰면 목표까지 걸리는 시간, 1분 뒤 도달하려면 넣을 선행 초
  const secondsToTarget = cfg.speed > 0 ? Math.ceil(target / cfg.speed) : 0;
  const suggestedPreRoll = Math.max(0, secondsToTarget - 60);

  return (
    <div style={S.panel}>
      <h3 style={S.h3}>
        {label} {connected && <span style={S.dot} />}
        <span style={{ ...S.badge, ...badgeStyle(wsState) }}>WS {wsState}</span>
        {retry > 0 && <span style={S.small}> 재연결 {retry}회</span>}
        {finishedBy && (
          <span style={{ ...S.badge, ...(finishedBy === "auto" ? S.autoBadge : {}) }}>
            {finishedBy === "auto" ? "🏁 자동 종료" : "종료(ack)"}
          </span>
        )}
      </h3>

      <div style={S.row}>
        <input style={S.input} placeholder="이메일" value={email}
               onChange={(e) => setEmail(e.target.value)} />
        <input style={S.input} type="password" placeholder="비밀번호" value={password}
               onChange={(e) => setPassword(e.target.value)} />
        <button style={S.btn} onClick={login}>로그인</button>
      </div>
      <input style={{ ...S.input, width: "100%" }} placeholder="accessToken (직접 붙여넣기 가능)"
             value={token} onChange={(e) => saveToken(e.target.value)} />

      <div style={S.row}>
        <select style={S.input} value={slot} onChange={(e) => setSlot(e.target.value)}>
          {ALL_SLOTS.map((s) => <option key={s} value={s}>{s.replace("T", " ")}</option>)}
        </select>
        <select style={S.input} value={distance}
                onChange={(e) => setDistance(Number(e.target.value))}>
          {DISTANCES.map((d) => <option key={d} value={d}>{d / 1000}km</option>)}
        </select>
        <input style={{ ...S.input, maxWidth: 120 }} placeholder="타이머 강제(ms)"
               value={forceMs} onChange={(e) => setForceMs(e.target.value)} />
      </div>

      <div style={S.hint}>
        2분 뒤 마감: <code>match.close-offset={offsetFor(slot, 2)}</code>
        {" · "}4분 뒤 READY: <code>match.ready-offset={offsetFor(slot, 4)}</code>
        <br />
        3-2-1은 <b>{countdownAt(slot)}</b>에 뜬다 (슬롯 3초 전 — 오프셋으로 못 당김).
        지금 보려면 타이머 강제에 <code>3000</code>
      </div>

      <div style={S.row}>
        <button style={{ ...S.btn, ...S.primary }} onClick={apply} disabled={!token}>
          신청 + 연결
        </button>
        <button style={{ ...S.btn, ...S.danger }} onClick={cancel} disabled={!token}>
          취소
        </button>
        <button style={S.btn} onClick={connect} disabled={connected || !token}>SSE 재연결</button>
        <button style={S.btn} onClick={disconnect} disabled={!connected}>SSE 끊기</button>
      </div>

      <div style={S.row}>
        <input style={{ ...S.input, maxWidth: 90 }} placeholder="방 번호" value={roomIdInput}
               onChange={(e) => { setRoomIdInput(e.target.value); roomIdRef.current = Number(e.target.value) || null; }} />
        <button style={{ ...S.btn, ...S.primary }} disabled={!token}
                onClick={() => { setFinishedBy(null); startedRef.current = true; openWs(); if (wsRef.current?.readyState === WebSocket.OPEN) sendStart(); }}>
          WS + RUNNING_START
        </button>
        <button style={S.btn} onClick={() => wsRef.current?.close(4000, "kill")}
                disabled={wsState !== "열림"} title="자동 재연결이 도는지 본다">
          강제 끊기
        </button>
        <button style={S.btn} onClick={() => closeWs(true)} disabled={wsState === "닫힘"}>
          WS 끊기(재연결 안 함)
        </button>
      </div>

      <div style={S.row}>
        <label style={S.label}>속도<input style={S.num} value={cfg.speed}
          onChange={(e) => setCfg({ ...cfg, speed: Number(e.target.value) || 0 })} />m/s</label>
        <label style={S.label}>흔들림<input style={S.num} value={cfg.swing}
          onChange={(e) => setCfg({ ...cfg, swing: Number(e.target.value) || 0 })} />m</label>
        <label style={S.label}>주기<input style={S.num} value={cfg.periodSec}
          onChange={(e) => setCfg({ ...cfg, periodSec: Number(e.target.value) || 1 })} />초</label>
        <label style={S.label}>위상
          <select style={S.num} value={cfg.phase}
                  onChange={(e) => setCfg({ ...cfg, phase: Number(e.target.value) })}>
            <option value={1}>+</option>
            <option value={-1}>−</option>
          </select>
        </label>
        <label style={S.label}>선행<input style={S.num} value={preRollSec} placeholder="0"
          onChange={(e) => setPreRollSec(e.target.value)} />초</label>
        <button style={S.btn} onClick={() => finish(false)} disabled={wsState !== "열림"}>종료</button>
        <button style={{ ...S.btn, ...S.danger }} onClick={() => finish(true)} disabled={wsState !== "열림"}>
          강제 종료
        </button>
      </div>

      <div style={S.hint}>
        {backward
          ? <b style={{ color: "#d33" }}>⚠️ 뒤로 간다 — 흔들림({swingSpeed.toFixed(2)}m/s)이 속도를 이긴다. 서버 거리는 뒤로 가도 더해진다</b>
          : fast
          ? <b style={{ color: "#d33" }}>⚠️ 너무 빠르다 — 평균 {MAX_AVG_SPEED.toFixed(2)}m/s(120초/km) 이하여야 기록이 남는다</b>
          : <>두 패널 위상을 <b>+ / −</b>로 두면 거리차 최대 <b>{maxGap}m</b> (창 {COMBO_WINDOW_M}m) ·
             순간속도 {(cfg.speed - swingSpeed).toFixed(2)}~{(cfg.speed + swingSpeed).toFixed(2)}m/s ·
             콤보 1 = {COMBO_TICK_MS / 1000}초</>}
        <br />
        자동 종료: {target / 1000}km를 {cfg.speed}m/s로 <b>{Math.floor(secondsToTarget / 60)}분 {secondsToTarget % 60}초</b>
        {" · "}1분 안에 보려면 선행 <b>{suggestedPreRoll}</b>초 (RUNNING_STARTED 전에 넣는다)
        <br />
        keep-alive {HEALTH_MS / 1000}초 · 무응답 {DEAD_MS / 1000}초면 재접속 · 4001은 재접속 안 함
        {closeInfo && <> · 마지막 close <b>{closeInfo.code}</b> {closeInfo.reason}</>}
      </div>

      {countdown !== null && (
        <div style={S.countdown}>{countdown > 0 ? countdown : "START!"}</div>
      )}

      {ready && (
        <div style={S.ready}>
          <b>RUNNING_READY</b> · 방 {ready.runningRoomId}
          <div style={S.small}>
            시작 {ready.scheduledStartAt?.replace("T", " ")} / 남은 {ready.startsInMs}ms
            {skewMs !== null && ` / 내 시계 오차 ${skewMs}ms`}
          </div>
        </div>
      )}

      {snapshot && (
        <div style={S.run}>
          <b>러닝 방 {snapshot.runningRoomId}</b> · 목표 {snapshot.targetDistanceMeters ?? "-"}m ·
          {" "}내 거리 <b>{myMeters}m</b>({paceOf(mySpeed)}/km) ·
          {" "}보낸 좌표 {sent.points}점/{sent.batches}프레임
          <table style={S.table}>
            <tbody>
              {(snapshot.players ?? []).map((p) => {
                const live = progress[p.userId];
                const me = p.userId === myUserId;
                const peer = peers.find((x) => x.userId === p.userId);
                return (
                  <tr key={p.userId}>
                    <td style={S.td}>{me ? "나" : p.nickname}</td>
                    <td style={S.td}>{me ? myMeters : live?.distanceMeters ?? p.distanceMeters}m</td>
                    <td style={S.td}>
                      {me ? paceOf(mySpeed) : paceText(live?.currentPaceSecondsPerKm ?? p.currentPaceSecondsPerKm)}
                    </td>
                    <td style={{ ...S.td, ...S.comboCell }}>
                      {peer ? `콤보 ${peer.comboCount} (최고 ${peer.maxComboCount}) · 차 ${peer.gapMeters}m` : me ? "" : "콤보 없음"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {room && (
        <div style={S.room}>
          <b>방 {room.runningRoomId}</b> · <b style={S.status}>{room.status}</b> ·{" "}
          {room.players?.length ?? 0}명
          <div style={S.small}>
            시작 {room.scheduledStartAt?.replace("T", " ")} / 마감 {room.closeAt?.replace("T", " ")}
            {room.teamAveragePaceSecondsPerKm != null &&
              ` / 평균 ${room.teamAveragePaceSecondsPerKm}초per km`}
          </div>
          <div style={S.small}>{room.players?.map((p) => p.nickname).join(", ")}</div>
        </div>
      )}

      <div style={S.logs}>
        {logs.map((l, i) => (
          <div key={i} style={{ ...S.logLine, color: COLORS[l.kind] ?? "#333" }}>
            <span style={S.time}>{l.at}</span> {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function summarize(r) {
  return `방 ${r.runningRoomId} / ${r.status} / ${r.players?.length ?? 0}명`;
}

function short(userId) {
  return userId ? userId.slice(0, 8) : "-";
}

// 1000은 정상 종료, 1006은 브라우저가 이유를 못 받은 것(대개 네트워크·프록시),
// 1009는 프레임이 64KB 버퍼를 넘긴 것, 4001은 서버가 이어받기로 닫은 것이다
function closeReason(code) {
  if (code === 1000) return "정상";
  if (code === 1001) return "엔드포인트 종료";
  if (code === 1006) return "비정상 — 유휴 타임아웃·프록시·네트워크";
  if (code === 1009) return "프레임 너무 큼(64KB 버퍼)";
  if (code === 1011) return "서버 내부 오류";
  if (code === SUPERSEDED) return "다른 연결이 이어받음";
  if (code === 4000) return "테스트로 끊음";
  return "알 수 없음";
}

function badgeStyle(state) {
  if (state === "열림") return { background: "#e8f7ef", color: "#0a7", borderColor: "#bfe6d0" };
  if (state === "닫힘") return { background: "#fdeeee", color: "#d33", borderColor: "#f0c9c9" };
  return { background: "#fff6e6", color: "#b60", borderColor: "#f0dcb8" };
}

const COLORS = {
  ok: "#0a7", err: "#d33", event: "#06c", ws: "#57c",
  started: "#b60", ready: "#7a3", combo: "#7a3", ping: "#aaa", sys: "#666",
};

const S = {
  panel: { flex: 1, border: "1px solid #ddd", borderRadius: 8, padding: 12,
           fontFamily: "ui-monospace, monospace", fontSize: 13, minWidth: 380 },
  h3: { margin: "0 0 8px" },
  row: { display: "flex", gap: 6, margin: "6px 0", flexWrap: "wrap", alignItems: "center" },
  input: { flex: 1, minWidth: 90, padding: "5px 7px", border: "1px solid #ccc", borderRadius: 4 },
  num: { width: 52, padding: "3px 5px", border: "1px solid #ccc", borderRadius: 4, margin: "0 3px" },
  label: { color: "#666", fontSize: 11 },
  btn: { padding: "5px 10px", border: "1px solid #bbb", borderRadius: 4,
         background: "#fafafa", cursor: "pointer" },
  primary: { fontWeight: 700, borderColor: "#8ab", background: "#eef5ff" },
  danger: { color: "#d33", borderColor: "#e9b0b0" },
  dot: { display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "#0a7" },
  badge: { marginLeft: 8, fontSize: 11, fontWeight: 400, padding: "2px 6px",
           border: "1px solid", borderRadius: 10 },
  autoBadge: { background: "#fff1d6", color: "#b60", borderColor: "#f0cf8a", fontWeight: 700 },
  hint: { color: "#888", fontSize: 11, margin: "2px 0 6px", lineHeight: 1.6 },
  room: { background: "#f5f8ff", border: "1px solid #dbe6ff", borderRadius: 6,
          padding: 8, margin: "6px 0" },
  ready: { background: "#f3fbef", border: "1px solid #cfe8c2", borderRadius: 6,
           padding: 8, margin: "6px 0" },
  run: { background: "#fffaf2", border: "1px solid #f0dcb8", borderRadius: 6,
         padding: 8, margin: "6px 0" },
  table: { width: "100%", borderCollapse: "collapse", marginTop: 6, fontSize: 12 },
  td: { borderTop: "1px solid #eee", padding: "3px 4px" },
  comboCell: { color: "#7a3" },
  countdown: { fontSize: 48, fontWeight: 800, textAlign: "center", color: "#b60",
               padding: "8px 0", lineHeight: 1 },
  status: { color: "#b60" },
  small: { color: "#666", fontSize: 11, marginTop: 3 },
  logs: { height: 240, overflowY: "auto", background: "#fbfbfb",
          border: "1px solid #eee", borderRadius: 4, padding: 6, marginTop: 6 },
  logLine: { whiteSpace: "pre-wrap", lineHeight: 1.5 },
  time: { color: "#bbb", marginRight: 6 },
};

export default function App() {
  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ fontFamily: "system-ui" }}>매칭 · 러닝 테스트</h2>
      <div style={{ display: "flex", gap: 12 }}>
        <UserPanel label="유저 A" phase={1} />
        <UserPanel label="유저 B" phase={-1} />
      </div>
    </div>
  );
}
