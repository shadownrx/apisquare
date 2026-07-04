'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [resetIn, setResetIn] = useState(0);
  const [shake, setShake] = useState(false);
  const [mounted, setMounted] = useState(false);
  const router = useRouter();

  useEffect(() => {
    setMounted(true);
  }, []);

  // Countdown timer cuando está bloqueado
  useEffect(() => {
    if (!blocked || resetIn <= 0) return;
    const interval = setInterval(() => {
      setResetIn(prev => {
        if (prev <= 1) {
          setBlocked(false);
          setError('');
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [blocked, resetIn]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading || blocked) return;
    setError('');
    setLoading(true);
    setShake(false);

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (res.ok) {
        router.push('/admin');
      } else if (res.status === 429) {
        setBlocked(true);
        setResetIn(data.resetIn || 900);
        setError(data.error);
        triggerShake();
      } else {
        setRemaining(data.remaining ?? null);
        setError(data.error || 'Credenciales incorrectas');
        if (data.blocked) {
          setBlocked(true);
          setResetIn(data.resetIn || 900);
        }
        triggerShake();
      }
    } catch {
      setError('Error de conexión. Intenta nuevamente.');
      triggerShake();
    } finally {
      setLoading(false);
    }
  }

  function triggerShake() {
    setShake(true);
    setTimeout(() => setShake(false), 600);
  }

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        .login-root {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Inter', sans-serif;
          background: radial-gradient(ellipse at 60% 20%, #1e1b4b 0%, #0f172a 40%, #020617 100%);
          padding: 24px;
          position: relative;
          overflow: hidden;
        }

        .login-root::before {
          content: '';
          position: absolute;
          width: 600px; height: 600px;
          background: radial-gradient(circle, rgba(99,102,241,0.15) 0%, transparent 70%);
          top: -200px; left: -200px;
          pointer-events: none;
        }

        .login-root::after {
          content: '';
          position: absolute;
          width: 500px; height: 500px;
          background: radial-gradient(circle, rgba(139,92,246,0.12) 0%, transparent 70%);
          bottom: -150px; right: -100px;
          pointer-events: none;
        }

        .login-card {
          width: 100%;
          max-width: 420px;
          background: rgba(255,255,255,0.05);
          backdrop-filter: blur(24px);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 20px;
          padding: 48px 40px;
          box-shadow: 0 25px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1);
          position: relative;
          z-index: 1;
          opacity: 0;
          transform: translateY(20px);
          transition: opacity 0.5s ease, transform 0.5s ease;
        }

        .login-card.mounted {
          opacity: 1;
          transform: translateY(0);
        }

        .login-card.shake {
          animation: shake 0.5s cubic-bezier(0.36, 0.07, 0.19, 0.97);
        }

        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          15% { transform: translateX(-8px); }
          30% { transform: translateX(8px); }
          45% { transform: translateX(-6px); }
          60% { transform: translateX(6px); }
          75% { transform: translateX(-4px); }
          90% { transform: translateX(4px); }
        }

        .login-logo {
          width: 56px; height: 56px;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          border-radius: 16px;
          display: flex; align-items: center; justify-content: center;
          margin: 0 auto 24px;
          box-shadow: 0 8px 24px rgba(99,102,241,0.4);
          font-size: 26px;
        }

        .login-title {
          font-size: 26px;
          font-weight: 700;
          color: #f8fafc;
          text-align: center;
          margin-bottom: 6px;
          letter-spacing: -0.5px;
        }

        .login-subtitle {
          font-size: 14px;
          color: rgba(148,163,184,0.8);
          text-align: center;
          margin-bottom: 36px;
        }

        .error-box {
          background: rgba(239,68,68,0.1);
          border: 1px solid rgba(239,68,68,0.3);
          border-radius: 10px;
          padding: 12px 16px;
          margin-bottom: 20px;
          display: flex;
          align-items: flex-start;
          gap: 10px;
          animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .error-icon { font-size: 16px; flex-shrink: 0; }

        .error-text {
          font-size: 13px;
          color: #fca5a5;
          line-height: 1.4;
        }

        .attempts-badge {
          display: inline-block;
          margin-top: 4px;
          font-size: 12px;
          color: rgba(252,165,165,0.7);
        }

        .form-group {
          margin-bottom: 18px;
        }

        .form-label {
          display: block;
          font-size: 13px;
          font-weight: 500;
          color: rgba(203,213,225,0.9);
          margin-bottom: 8px;
          letter-spacing: 0.3px;
        }

        .form-input {
          width: 100%;
          padding: 12px 16px;
          font-size: 15px;
          font-family: 'Inter', sans-serif;
          background: rgba(255,255,255,0.07);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 10px;
          color: #f1f5f9;
          outline: none;
          transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
        }

        .form-input::placeholder { color: rgba(148,163,184,0.5); }

        .form-input:focus {
          border-color: rgba(99,102,241,0.7);
          background: rgba(99,102,241,0.08);
          box-shadow: 0 0 0 3px rgba(99,102,241,0.15);
        }

        .form-input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .submit-btn {
          width: 100%;
          padding: 13px;
          margin-top: 8px;
          font-size: 15px;
          font-weight: 600;
          font-family: 'Inter', sans-serif;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: #ffffff;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: opacity 0.2s, transform 0.2s, box-shadow 0.2s;
          box-shadow: 0 4px 15px rgba(99,102,241,0.4);
          letter-spacing: 0.2px;
        }

        .submit-btn:hover:not(:disabled) {
          opacity: 0.92;
          transform: translateY(-1px);
          box-shadow: 0 8px 25px rgba(99,102,241,0.5);
        }

        .submit-btn:active:not(:disabled) {
          transform: translateY(0);
        }

        .submit-btn:disabled {
          cursor: not-allowed;
          opacity: 0.6;
        }

        .spinner {
          width: 16px; height: 16px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .timer-display {
          text-align: center;
          margin-top: 16px;
          font-size: 13px;
          color: rgba(148,163,184,0.7);
        }

        .timer-count {
          font-size: 22px;
          font-weight: 700;
          color: #f87171;
          display: block;
          margin-top: 4px;
          letter-spacing: 1px;
        }
      `}</style>

      <div className="login-root">
        <div className={`login-card ${mounted ? 'mounted' : ''} ${shake ? 'shake' : ''}`}>
          <div className="login-logo">🔐</div>
          <h1 className="login-title">Panel Admin</h1>
          <p className="login-subtitle">Acceso exclusivo para administradores</p>

          <form onSubmit={handleSubmit}>
            {error && (
              <div className="error-box">
                <span className="error-icon">⚠️</span>
                <div>
                  <span className="error-text">{error}</span>
                  {remaining !== null && remaining > 0 && !blocked && (
                    <span className="attempts-badge">
                      {remaining} intento{remaining !== 1 ? 's' : ''} restante{remaining !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="username">Usuario</label>
              <input
                id="username"
                type="text"
                className="form-input"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Ingresa tu usuario"
                required
                autoComplete="username"
                disabled={loading || blocked}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="password">Contraseña</label>
              <input
                id="password"
                type="password"
                className="form-input"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
                disabled={loading || blocked}
              />
            </div>

            <button type="submit" className="submit-btn" disabled={loading || blocked}>
              {loading ? (
                <>
                  <div className="spinner" />
                  Verificando...
                </>
              ) : blocked ? (
                '🔒 Bloqueado temporalmente'
              ) : (
                'Iniciar Sesión →'
              )}
            </button>

            {blocked && resetIn > 0 && (
              <div className="timer-display">
                Podrás intentarlo en:
                <span className="timer-count">{formatTime(resetIn)}</span>
              </div>
            )}
          </form>
        </div>
      </div>
    </>
  );
}
