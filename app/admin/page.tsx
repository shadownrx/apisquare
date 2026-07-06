'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface Reservation {
  id: string;
  profesional: string;
  servicio: string;
  nombre: string;
  fecha: string;
  hora: string;
  chatId: number;
}

const SERVICE_ICONS: Record<string, string> = {
  'Sesión de Quiropráctica': '🦴',
  'Masaje Relajante': '💆',
  'Traumatología': '🩺',
};

function formatDate(fechaStr: string): string {
  const fecha = new Date(fechaStr + 'T12:00:00');
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  return fecha.toLocaleDateString('es-ES', options);
}

function isToday(fechaStr: string): boolean {
  const today = new Date().toISOString().split('T')[0];
  return fechaStr === today;
}

function isFuture(fechaStr: string): boolean {
  const today = new Date().toISOString().split('T')[0];
  return fechaStr >= today;
}

export default function AdminPage() {
  const router = useRouter();
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Reservation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchReservations = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const res = await fetch('/api/admin/reservations', { cache: 'no-store' });
      if (res.status === 401) {
        router.push('/login');
        return;
      }
      const data = await res.json();
      setReservations(data.reservations || []);
    } catch {
      showToast('Error al cargar las reservas', 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    fetchReservations();
  }, [fetchReservations]);

  function showToast(msg: string, type: 'success' | 'error') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/admin/reservations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteTarget.id }),
      });
      if (res.ok) {
        setReservations(prev => prev.filter(r => r.id !== deleteTarget.id));
        showToast('Cita eliminada correctamente ✓', 'success');
      } else {
        showToast('Error al eliminar la cita', 'error');
      }
    } catch {
      showToast('Error de conexión', 'error');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  async function handleLogout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    router.push('/login');
  }

  const todayCount = reservations.filter(r => isToday(r.fecha)).length;
  const upcomingCount = reservations.filter(r => isFuture(r.fecha)).length;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        .admin-root {
          min-height: 100vh;
          font-family: 'Inter', sans-serif;
          background: #0f172a;
          color: #e2e8f0;
        }

        /* ── Header ───────────────────────────────── */
        .admin-header {
          background: rgba(15,23,42,0.95);
          backdrop-filter: blur(20px);
          border-bottom: 1px solid rgba(255,255,255,0.07);
          padding: 0 32px;
          height: 68px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          position: sticky;
          top: 0;
          z-index: 100;
        }

        .header-brand {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .header-icon {
          width: 38px; height: 38px;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          border-radius: 10px;
          display: flex; align-items: center; justify-content: center;
          font-size: 18px;
          box-shadow: 0 4px 12px rgba(99,102,241,0.4);
        }

        .header-title {
          font-size: 17px;
          font-weight: 700;
          color: #f8fafc;
          letter-spacing: -0.3px;
        }

        .header-subtitle {
          font-size: 12px;
          color: rgba(148,163,184,0.7);
          margin-top: 1px;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .btn-refresh {
          display: flex; align-items: center; gap: 7px;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 500;
          font-family: 'Inter', sans-serif;
          background: rgba(99,102,241,0.15);
          color: #a5b4fc;
          border: 1px solid rgba(99,102,241,0.3);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-refresh:hover:not(:disabled) {
          background: rgba(99,102,241,0.25);
          border-color: rgba(99,102,241,0.5);
          color: #c7d2fe;
        }

        .btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }

        .refresh-icon {
          font-size: 14px;
          display: inline-block;
          transition: transform 0.6s ease;
        }

        .refresh-icon.spinning {
          animation: spin 0.8s linear infinite;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        .btn-logout {
          display: flex; align-items: center; gap: 7px;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 500;
          font-family: 'Inter', sans-serif;
          background: rgba(239,68,68,0.1);
          color: #fca5a5;
          border: 1px solid rgba(239,68,68,0.25);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-logout:hover {
          background: rgba(239,68,68,0.2);
          border-color: rgba(239,68,68,0.4);
        }

        /* ── Main content ─────────────────────────── */
        .admin-main {
          max-width: 1280px;
          margin: 0 auto;
          padding: 40px 32px;
        }

        .section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 32px;
        }

        .section-title {
          font-size: 28px;
          font-weight: 800;
          color: #f8fafc;
          letter-spacing: -0.8px;
        }

        .section-subtitle {
          font-size: 14px;
          color: rgba(148,163,184,0.7);
          margin-top: 4px;
        }

        /* ── Stats ────────────────────────────────── */
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 16px;
          margin-bottom: 40px;
        }

        .stat-card {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 14px;
          padding: 20px 22px;
          opacity: 0;
          transform: translateY(10px);
          transition: opacity 0.4s ease, transform 0.4s ease;
        }

        .stat-card.visible {
          opacity: 1;
          transform: translateY(0);
        }

        .stat-label {
          font-size: 12px;
          font-weight: 500;
          color: rgba(148,163,184,0.7);
          text-transform: uppercase;
          letter-spacing: 0.8px;
          margin-bottom: 8px;
        }

        .stat-value {
          font-size: 32px;
          font-weight: 800;
          color: #f8fafc;
          line-height: 1;
          letter-spacing: -1px;
        }

        .stat-value.accent { color: #818cf8; }
        .stat-value.green { color: #4ade80; }

        .stat-icon {
          font-size: 22px;
          margin-bottom: 10px;
        }

        /* ── Reservations Grid ────────────────────── */
        .reservations-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 20px;
        }

        .reservation-card {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          padding: 22px 24px;
          position: relative;
          overflow: hidden;
          opacity: 0;
          transform: translateY(16px);
          transition: opacity 0.4s ease, transform 0.4s ease, border-color 0.2s, box-shadow 0.2s;
        }

        .reservation-card.visible {
          opacity: 1;
          transform: translateY(0);
        }

        .reservation-card:hover {
          border-color: rgba(99,102,241,0.3);
          box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }

        .reservation-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 3px;
          background: linear-gradient(90deg, #6366f1, #8b5cf6);
          opacity: 0;
          transition: opacity 0.2s;
        }

        .reservation-card:hover::before { opacity: 1; }

        .card-today-badge {
          position: absolute;
          top: 14px; right: 14px;
          background: rgba(74,222,128,0.15);
          border: 1px solid rgba(74,222,128,0.3);
          color: #4ade80;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          padding: 3px 8px;
          border-radius: 6px;
        }

        .card-service-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 18px;
        }

        .service-icon {
          width: 44px; height: 44px;
          background: rgba(99,102,241,0.15);
          border: 1px solid rgba(99,102,241,0.2);
          border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
          font-size: 22px;
          flex-shrink: 0;
        }

        .service-name {
          font-size: 15px;
          font-weight: 700;
          color: #f1f5f9;
          letter-spacing: -0.2px;
        }

        .card-divider {
          height: 1px;
          background: rgba(255,255,255,0.06);
          margin: 16px 0;
        }

        .card-info-row {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }

        .card-info-row:last-of-type { margin-bottom: 0; }

        .info-icon {
          font-size: 15px;
          width: 20px;
          text-align: center;
          flex-shrink: 0;
        }

        .info-label {
          font-size: 11px;
          color: rgba(148,163,184,0.6);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          width: 56px;
          flex-shrink: 0;
        }

        .info-value {
          font-size: 13px;
          color: #cbd5e1;
          font-weight: 500;
          flex: 1;
        }

        .card-footer {
          margin-top: 20px;
          display: flex;
          justify-content: flex-end;
        }

        .btn-delete {
          display: flex; align-items: center; gap: 6px;
          padding: 8px 14px;
          font-size: 12px;
          font-weight: 600;
          font-family: 'Inter', sans-serif;
          background: rgba(239,68,68,0.08);
          color: #fca5a5;
          border: 1px solid rgba(239,68,68,0.2);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
          letter-spacing: 0.2px;
        }

        .btn-delete:hover {
          background: rgba(239,68,68,0.18);
          border-color: rgba(239,68,68,0.4);
          color: #fecaca;
        }

        /* ── Empty State ──────────────────────────── */
        .empty-state {
          text-align: center;
          padding: 80px 20px;
          grid-column: 1 / -1;
        }

        .empty-icon {
          font-size: 60px;
          margin-bottom: 20px;
          opacity: 0.5;
        }

        .empty-title {
          font-size: 20px;
          font-weight: 600;
          color: rgba(148,163,184,0.8);
          margin-bottom: 8px;
        }

        .empty-subtitle {
          font-size: 14px;
          color: rgba(100,116,139,0.7);
        }

        /* ── Loading ──────────────────────────────── */
        .loading-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 20px;
        }

        .skeleton-card {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 16px;
          padding: 22px 24px;
          animation: pulse 1.5s ease-in-out infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }

        .skeleton-line {
          background: rgba(255,255,255,0.1);
          border-radius: 6px;
          height: 14px;
          margin-bottom: 10px;
        }

        /* ── Modal ────────────────────────────────── */
        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.7);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 20px;
          animation: fadeIn 0.2s ease;
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .modal-card {
          background: #1e293b;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 20px;
          padding: 32px;
          max-width: 420px;
          width: 100%;
          box-shadow: 0 25px 50px rgba(0,0,0,0.6);
          animation: slideUp 0.25s ease;
        }

        @keyframes slideUp {
          from { transform: translateY(16px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }

        .modal-icon {
          width: 52px; height: 52px;
          background: rgba(239,68,68,0.15);
          border: 1px solid rgba(239,68,68,0.3);
          border-radius: 14px;
          display: flex; align-items: center; justify-content: center;
          font-size: 26px;
          margin-bottom: 20px;
        }

        .modal-title {
          font-size: 19px;
          font-weight: 700;
          color: #f1f5f9;
          margin-bottom: 8px;
        }

        .modal-description {
          font-size: 14px;
          color: rgba(148,163,184,0.8);
          line-height: 1.6;
          margin-bottom: 24px;
        }

        .modal-detail {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 10px;
          padding: 14px 16px;
          margin-bottom: 24px;
        }

        .modal-detail-item {
          font-size: 13px;
          color: #94a3b8;
          margin-bottom: 4px;
        }

        .modal-detail-item:last-child { margin-bottom: 0; }

        .modal-detail-item strong {
          color: #cbd5e1;
        }

        .modal-actions {
          display: flex;
          gap: 10px;
        }

        .modal-btn-cancel {
          flex: 1;
          padding: 11px;
          font-size: 14px;
          font-weight: 500;
          font-family: 'Inter', sans-serif;
          background: rgba(255,255,255,0.06);
          color: #94a3b8;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .modal-btn-cancel:hover {
          background: rgba(255,255,255,0.1);
          color: #cbd5e1;
        }

        .modal-btn-confirm {
          flex: 1;
          padding: 11px;
          font-size: 14px;
          font-weight: 600;
          font-family: 'Inter', sans-serif;
          background: linear-gradient(135deg, #ef4444, #dc2626);
          color: #fff;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s;
          display: flex; align-items: center; justify-content: center; gap: 7px;
          box-shadow: 0 4px 12px rgba(239,68,68,0.3);
        }

        .modal-btn-confirm:hover:not(:disabled) {
          opacity: 0.9;
          transform: translateY(-1px);
        }

        .modal-btn-confirm:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .btn-spinner {
          width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
        }

        /* ── Toast ────────────────────────────────── */
        .toast {
          position: fixed;
          bottom: 28px;
          right: 28px;
          padding: 14px 20px;
          border-radius: 12px;
          font-size: 14px;
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 10px;
          z-index: 2000;
          animation: toastIn 0.3s ease;
          box-shadow: 0 8px 24px rgba(0,0,0,0.4);
          max-width: 340px;
        }

        .toast.success {
          background: rgba(22,163,74,0.95);
          border: 1px solid rgba(74,222,128,0.3);
          color: #fff;
        }

        .toast.error {
          background: rgba(220,38,38,0.95);
          border: 1px solid rgba(252,165,165,0.3);
          color: #fff;
        }

        @keyframes toastIn {
          from { opacity: 0; transform: translateY(12px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>

      <div className="admin-root">
        {/* Header */}
        <header className="admin-header">
          <div className="header-brand">
            <div className="header-icon">🗓️</div>
            <div>
              <div className="header-title">ApiSquare Admin</div>
              <div className="header-subtitle">Panel de gestión de citas</div>
            </div>
          </div>
          <div className="header-actions">
            <button
              id="btn-refresh"
              className="btn-refresh"
              onClick={() => fetchReservations(true)}
              disabled={refreshing || loading}
            >
              <span className={`refresh-icon ${refreshing ? 'spinning' : ''}`}>↻</span>
              {refreshing ? 'Actualizando...' : 'Refrescar'}
            </button>
            <button id="btn-logout" className="btn-logout" onClick={handleLogout}>
              ⎋ Cerrar sesión
            </button>
          </div>
        </header>

        {/* Main */}
        <main className="admin-main">
          <div className="section-header">
            <div>
              <h1 className="section-title">Reservas</h1>
              <p className="section-subtitle">
                {loading ? 'Cargando...' : `${reservations.length} cita${reservations.length !== 1 ? 's' : ''} en total`}
              </p>
            </div>
          </div>

          {/* Stats */}
          <div className="stats-grid">
            {[
              { label: 'Total', value: reservations.length, icon: '📋', cls: 'accent' },
              { label: 'Hoy', value: todayCount, icon: '📅', cls: 'green' },
              { label: 'Próximas', value: upcomingCount, icon: '⏳', cls: '' },
            ].map((stat, i) => (
              <div
                key={stat.label}
                className={`stat-card ${mounted ? 'visible' : ''}`}
                style={{ transitionDelay: `${i * 80}ms` }}
              >
                <div className="stat-icon">{stat.icon}</div>
                <div className="stat-label">{stat.label}</div>
                <div className={`stat-value ${stat.cls}`}>{stat.value}</div>
              </div>
            ))}
          </div>

          {/* Reservations */}
          {loading ? (
            <div className="loading-grid">
              {[1, 2, 3].map(i => (
                <div key={i} className="skeleton-card">
                  <div className="skeleton-line" style={{ width: '40%', height: 18, marginBottom: 18 }} />
                  <div className="skeleton-line" style={{ width: '70%' }} />
                  <div className="skeleton-line" style={{ width: '55%' }} />
                  <div className="skeleton-line" style={{ width: '45%' }} />
                </div>
              ))}
            </div>
          ) : (
            <div className="reservations-grid">
              {reservations.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">📭</div>
                  <p className="empty-title">No hay reservas aún</p>
                  <p className="empty-subtitle">Las nuevas citas aparecerán aquí automáticamente</p>
                </div>
              ) : (
                reservations.map((res, index) => (
                  <div
                    key={res.id}
                    className={`reservation-card ${mounted ? 'visible' : ''}`}
                    style={{ transitionDelay: `${index * 60}ms` }}
                  >
                    {isToday(res.fecha) && (
                      <div className="card-today-badge">HOY</div>
                    )}

                    <div className="card-service-header">
                      <div className="service-icon">
                        {SERVICE_ICONS[res.servicio] || '🩺'}
                      </div>
                      <div className="service-name">{res.servicio}</div>
                    </div>

                    <div className="card-divider" />

                    <div className="card-info-row">
                      <span className="info-icon">�‍⚕️</span>
                      <span className="info-label">Profesional</span>
                      <span className="info-value">{res.profesional}</span>
                    </div>
                    <div className="card-info-row">
                      <span className="info-icon">�👤</span>
                      <span className="info-label">Cliente</span>
                      <span className="info-value">{res.nombre}</span>
                    </div>
                    <div className="card-info-row">
                      <span className="info-icon">📅</span>
                      <span className="info-label">Fecha</span>
                      <span className="info-value">{formatDate(res.fecha)}</span>
                    </div>
                    <div className="card-info-row">
                      <span className="info-icon">🕐</span>
                      <span className="info-label">Hora</span>
                      <span className="info-value">{res.hora}</span>
                    </div>

                    <div className="card-footer">
                      <button
                        id={`btn-delete-${res.id}`}
                        className="btn-delete"
                        onClick={() => setDeleteTarget(res)}
                      >
                        🗑 Eliminar cita
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </main>

        {/* Modal de confirmación */}
        {deleteTarget && (
          <div className="modal-overlay" onClick={() => !deleting && setDeleteTarget(null)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-icon">🗑️</div>
              <h2 className="modal-title">Eliminar cita</h2>
              <p className="modal-description">
                ¿Estás seguro de que quieres eliminar esta cita? Esta acción no se puede deshacer.
              </p>
              <div className="modal-detail">
                <div className="modal-detail-item"><strong>Profesional:</strong> {deleteTarget.profesional}</div>
                <div className="modal-detail-item"><strong>Servicio:</strong> {deleteTarget.servicio}</div>
                <div className="modal-detail-item"><strong>Cliente:</strong> {deleteTarget.nombre}</div>
                <div className="modal-detail-item"><strong>Fecha:</strong> {formatDate(deleteTarget.fecha)}</div>
                <div className="modal-detail-item"><strong>Hora:</strong> {deleteTarget.hora}</div>
              </div>
              <div className="modal-actions">
                <button
                  id="modal-btn-cancel"
                  className="modal-btn-cancel"
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleting}
                >
                  Cancelar
                </button>
                <button
                  id="modal-btn-confirm"
                  className="modal-btn-confirm"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? (
                    <>
                      <div className="btn-spinner" />
                      Eliminando...
                    </>
                  ) : (
                    'Eliminar'
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Toast */}
        {toast && (
          <div className={`toast ${toast.type}`}>
            {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
          </div>
        )}
      </div>
    </>
  );
}
