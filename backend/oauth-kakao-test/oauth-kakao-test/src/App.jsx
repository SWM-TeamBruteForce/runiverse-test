import { useEffect, useRef, useState } from 'react';
const KAKAO_REST_API_KEY = import.meta.env.VITE_KAKAO_REST_API_KEY;
const REDIRECT_URI = 'http://localhost:5173';
const API_BASE = 'http://localhost:8080/api/v1';
const VERIFIER_KEY = 'kakao_code_verifier';
// base64url — PKCE는 '+' '/' '='를 쓰지 않는다
function base64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function createVerifier() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32))); // 43자
}
async function createChallenge(verifier) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64Url(digest);
}
export default function App() {
  const [login, setLogin] = useState({ status: 'idle' });
  const [verify, setVerify] = useState(null);
  const handled = useRef(false);
  // 인가 요청 — verifier를 만들어 보관하고 challenge만 카카오에 넘긴다
  const startLogin = async () => {
    const verifier = createVerifier();
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    const challenge = await createChallenge(verifier);
    window.location.href =
      'https://kauth.kakao.com/oauth/authorize' +
      `?client_id=${KAKAO_REST_API_KEY}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      '&response_type=code' +
      '&scope=account_email' +
      `&code_challenge=${challenge}` +
      '&code_challenge_method=S256';
  };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const kakaoError = params.get('error');
    if (kakaoError) {
      window.history.replaceState({}, '', '/');
      setLogin({ status: 'error', message: `카카오: ${kakaoError}` });
      return;
    }
    if (!code || handled.current) return;
    handled.current = true;
    window.history.replaceState({}, '', '/');
    // 리다이렉트로 페이지가 다시 뜨므로 verifier는 sessionStorage에서 꺼낸다
    const codeVerifier = sessionStorage.getItem(VERIFIER_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    if (!codeVerifier) {
      setLogin({ status: 'error', message: 'code_verifier가 없습니다. 로그인을 다시 시작하세요.' });
      return;
    }
    setLogin({ status: 'loading' });
    fetch(`${API_BASE}/auth/oauth/kakao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorizationCode: code, codeVerifier }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
        return body;
      })
      .then((data) => setLogin({ status: 'success', data }))
      .catch((e) => setLogin({ status: 'error', message: e.message }));
  }, []);
  const verifyToken = async () => {
    const res = await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.data.accessToken}` },
    });
    setVerify(res.status);
  };
  return (
    <div style={{ fontFamily: 'monospace', padding: 24, lineHeight: 1.8 }}>
      <h2>카카오 로그인 테스트</h2>
      <button onClick={startLogin}>카카오로 로그인</button>
      {login.status === 'loading' && <p>토큰 교환 중...</p>}
      {login.status === 'error' && (
        <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>
          실패: {login.message}
        </pre>
      )}
      {login.status === 'success' && (
        <>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {JSON.stringify(login.data, null, 2)}
          </pre>
          <button onClick={verifyToken}>access token으로 인증 확인</button>
          {verify !== null && (
            <p>
              응답 {verify} — {verify === 204 ? '인증 성공' : '인증 실패'}
            </p>
          )}
        </>
      )}
    </div>
  );
}