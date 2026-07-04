'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      router.push('/admin');
    } else {
      setError('Credenciales incorrectas');
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      backgroundColor: '#f9fafb',
    }}>
      <div style={{
        width: '100%',
        maxWidth: '400px',
        padding: '32px',
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1)',
      }}>
        <h1 style={{
          fontSize: '28px',
          fontWeight: 'bold',
          textAlign: 'center',
          marginBottom: '24px',
          color: '#111827',
        }}>
          Iniciar Sesión
        </h1>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {error && (
            <p style={{ color: '#dc2626', textAlign: 'center' }}>{error}</p>
          )}

          <div>
            <label style={{
              display: 'block',
              fontSize: '14px',
              fontWeight: '500',
              marginBottom: '4px',
              color: '#111827',
            }}>
              Usuario
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: '16px',
                border: '1px solid #d1d5db',
                borderRadius: '6px',
              }}
            />
          </div>

          <div>
            <label style={{
              display: 'block',
              fontSize: '14px',
              fontWeight: '500',
              marginBottom: '4px',
              color: '#111827',
            }}>
              Contraseña
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: '16px',
                border: '1px solid #d1d5db',
                borderRadius: '6px',
              }}
            />
          </div>

          <button
            type="submit"
            style={{
              width: '100%',
              padding: '12px',
              fontSize: '16px',
              fontWeight: '500',
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Entrar
          </button>
        </form>
      </div>
    </div>
  );
}
