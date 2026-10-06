import { useCallback, useEffect, useRef, useState } from "react";

const BASE = "/api/v1";
const DISTANCES = [3000, 5000, 10000];

// 18:00~22:00 30분 간격 — 서버 ApplyMatchRequest 검증과 같은 규칙
function slots(dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
  const out = [];
  for (let h = 18; h <= 22; h++) {
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

function UserPanel({ label }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [slot, setSlot] = useState(ALL_SLOTS[0]);
  const [distance, setDistance] = useState(5000);
  const [room, setRoom] = useState(null);
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);

  // RUNNING_READY 관련
  const [ready, setReady] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [skewMs, setSkewMs] = useState(null);
  // 테스트용 — startsInMs를 무시하고 이 값(ms)으로 발사 타이머를 건다
  const [forceMs, setForceMs] = useState("");

  const abortRef = useRef(null);
  const tokenRef = useRef("");
  const forceRef = useRef("");
  const launchRef = useRef(null);
  const tickRef = useRef(null);

  const log = useCallback((kind, text) => {
    const at = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    setLogs((prev) => [{ at, kind, text }, ...prev].slice(0, 200));
  }, []);

  // 스트림 콜백은 최초 렌더의 클로저에 갇힌다 — 최신 값을 ref로 미러한다
  useEffect(() => {
    forceRef.current = forceMs;
  }, [forceMs]);

  // 패널이 사라질 때 타이머가 남으면 지워진 컴포넌트에 setState를 한다
  useEffect(() => clearTimers, []);

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
      // 여기서 WS로 RUNNING_START를 보내야 하지만 브라우저 WebSocket은
      // Authorization 헤더를 못 붙인다 — 시각 도달만 남긴다
      log("started", "🏃 발사 시각 도달 — 여기서 WS RUNNING_START (실제 전송은 앱 몫)");
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

    const force = forceRef.current;
    const waitMs = force === "" ? p.startsInMs : Number(force);
    log(
      "ready",
      `RUNNING_READY — 남은 ${p.startsInMs}ms / 내 시계 오차 ${skew}ms` +
        (force === "" ? "" : ` / 테스트 강제 ${waitMs}ms`)
    );
    scheduleLaunch(waitMs);
  }

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

  return (
    <div style={S.panel}>
      <h3 style={S.h3}>
        {label} {connected && <span style={S.dot} />}
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
        <button style={S.btn} onClick={connect} disabled={connected || !token}>재연결</button>
        <button style={S.btn} onClick={disconnect} disabled={!connected}>연결 끊기</button>
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

const COLORS = {
  ok: "#0a7", err: "#d33", event: "#06c",
  started: "#b60", ready: "#7a3", ping: "#aaa", sys: "#666",
};

const S = {
  panel: { flex: 1, border: "1px solid #ddd", borderRadius: 8, padding: 12,
           fontFamily: "ui-monospace, monospace", fontSize: 13, minWidth: 380 },
  h3: { margin: "0 0 8px" },
  row: { display: "flex", gap: 6, margin: "6px 0", flexWrap: "wrap" },
  input: { flex: 1, minWidth: 90, padding: "5px 7px", border: "1px solid #ccc", borderRadius: 4 },
  btn: { padding: "5px 10px", border: "1px solid #bbb", borderRadius: 4,
         background: "#fafafa", cursor: "pointer" },
  primary: { fontWeight: 700, borderColor: "#8ab", background: "#eef5ff" },
  danger: { color: "#d33", borderColor: "#e9b0b0" },
  dot: { display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "#0a7" },
  hint: { color: "#888", fontSize: 11, margin: "2px 0 6px", lineHeight: 1.6 },
  room: { background: "#f5f8ff", border: "1px solid #dbe6ff", borderRadius: 6,
          padding: 8, margin: "6px 0" },
  ready: { background: "#f3fbef", border: "1px solid #cfe8c2", borderRadius: 6,
           padding: 8, margin: "6px 0" },
  countdown: { fontSize: 48, fontWeight: 800, textAlign: "center", color: "#b60",
               padding: "8px 0", lineHeight: 1 },
  status: { color: "#b60" },
  small: { color: "#666", fontSize: 11, marginTop: 3 },
  logs: { height: 260, overflowY: "auto", background: "#fbfbfb",
          border: "1px solid #eee", borderRadius: 4, padding: 6, marginTop: 6 },
  logLine: { whiteSpace: "pre-wrap", lineHeight: 1.5 },
  time: { color: "#bbb", marginRight: 6 },
};

export default function App() {
  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ fontFamily: "system-ui" }}>매칭 테스트</h2>
      <div style={{ display: "flex", gap: 12 }}>
        <UserPanel label="유저 A" />
        <UserPanel label="유저 B" />
      </div>
    </div>
  );
}
