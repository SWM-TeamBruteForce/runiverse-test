import { useState } from "react";
const API = "http://localhost:8080/api/v1";
export default function App() {
  const [email, setEmail] = useState("runner@runiverse.com");
  const [password, setPassword] = useState("Password123!");
  const [auth, setAuth] = useState(null);
  const [file, setFile] = useState(null);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const log = (msg) => setLogs((prev) => [...prev, msg]);
  // 서버 에러는 { code, message } 평면 구조로 온다
  async function callApi(path, options) {
    const res = await fetch(`${API}${path}`, options);
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`${res.status} ${body?.code ?? ""} ${body?.message ?? ""}`);
    }
    return body;
  }
  async function login() {
    setBusy(true);
    try {
      const body = await callApi("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      setAuth({ accessToken: body.accessToken, userId: body.userId });
      log(`로그인 성공 — userId=${body.userId}`);
    } catch (e) {
      log(`로그인 실패 — ${e.message}`);
    } finally {
      setBusy(false);
    }
  }
  async function uploadAndSave() {
    if (!auth || !file) return;
    setBusy(true);
    const headers = {
      Authorization: `Bearer ${auth.accessToken}`,
      "Content-Type": "application/json",
    };
    try {
      // 1) 발급 — 크기가 서명에 들어가므로 실제 file.size를 그대로 보낸다
      const issued = await callApi(`/users/${auth.userId}/profile-image/presigned-url`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mimeType: file.type, fileSizeBytes: file.size }),
      });
      log(`발급 성공 — ${issued.profileImageKey}`);
      // 2) S3 직접 업로드 — 서버를 거치지 않는다
      //    Content-Type이 발급 때와 다르면 403, Content-Length는 브라우저가 file.size로 채운다
      const put = await fetch(issued.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) {
        const detail = await put.text();               // S3는 XML로 원인을 준다
        console.log("S3 응답:", detail);
        const code = detail.match(/<Code>(.*?)<\/Code>/)?.[1] ?? "알 수 없음";
        throw new Error(`S3 업로드 실패 — ${put.status} ${code}`);
      }
      log("S3 업로드 성공");
      // 3) 서버에 key 반영 — 서버가 HeadObject로 실제 존재를 확인한 뒤 저장한다
      const saved = await callApi(`/users/${auth.userId}/profile-image`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ profileImageKey: issued.profileImageKey }),
      });
      log(`저장 완료 — ${saved.profileImageKey}`);
    } catch (e) {
      log(`실패 — ${e.message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ maxWidth: 560, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h2>프로필 이미지 업로드 테스트</h2>
      <section style={{ marginBottom: 24 }}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="이메일" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="비밀번호"
        />
        <button onClick={login} disabled={busy}>
          로그인
        </button>
        {auth && <p>userId: {auth.userId}</p>}
      </section>
      <section style={{ marginBottom: 24 }}>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {file && (
          <p>
            {file.name} — {file.type} — {file.size.toLocaleString()} bytes
            {file.size > 10 * 1024 * 1024 && " (10MB 초과)"}
          </p>
        )}
        <button onClick={uploadAndSave} disabled={busy || !auth || !file}>
          업로드하고 저장
        </button>
      </section>
      <pre style={{ background: "#f4f4f4", padding: 12, minHeight: 120 }}>
        {logs.join("\n")}
      </pre>
      {file && <img src={URL.createObjectURL(file)} alt="미리보기" width={160} />}
    </div>
  );
}