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

interface TimeSlot {
  inicio: string;
  fin: string;
}

interface ProfessionalSchedule {
  [day: number]: TimeSlot[];
}

interface Config {
  profesionales: {
    [name: string]: ProfessionalSchedule;
  };
  feriados: string[];
  servicios: Array<{ nombre: string; duracionMinutos: number; precio: number }>;
}

const SERVICE_ICONS: Record<string, string> = {
  'Sesión de Quiropraxia': '🦴',
  'Masaje Relajante': '💆',
  'Traumatología': '🩺',
};

const DAYS = [
  { id: 0, name: 'Domingo' },
  { id: 1, name: 'Lunes' },
  { id: 2, name: 'Martes' },
  { id: 3, name: 'Miércoles' },
  { id: 4, name: 'Jueves' },
  { id: 5, name: 'Viernes' },
  { id: 6, name: 'Sábado' },
];

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
  const [activeTab, setActiveTab] = useState<'reservas' | 'config'>('reservas');
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Reservation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [mounted, setMounted] = useState(false);
  
  // Config state
  const [config, setConfig] = useState<Config | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [collapsedProfessionals, setCollapsedProfessionals] = useState<Set<string>>(new Set());
  const [collapsedDays, setCollapsedDays] = useState<{ [prof: string]: Set<number> }>({});

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

  const fetchConfig = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoadingConfig(true);

    try {
      const res = await fetch('/api/admin/config', { cache: 'no-store' });
      if (res.status === 401) {
        router.push('/login');
        return;
      }
      const data = await res.json();
      setConfig(data.config);
    } catch {
      showToast('Error al cargar la configuración', 'error');
    } finally {
      setLoadingConfig(false);
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    if (activeTab === 'reservas') {
      fetchReservations();
    } else {
      fetchConfig();
    }
  }, [activeTab, fetchReservations, fetchConfig]);

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

  async function handleSaveConfig() {
    if (!config) return;
    setSavingConfig(true);
    try {
      const res = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        showToast('Configuración guardada correctamente ✓', 'success');
      } else {
        showToast('Error al guardar la configuración', 'error');
      }
    } catch {
      showToast('Error de conexión', 'error');
    } finally {
      setSavingConfig(false);
    }
  }

  function addFeriado() {
    const inputElement = document.getElementById('feriadoInput') as HTMLInputElement | null;
    if (!config || !inputElement?.value) return;
    const fecha = inputElement.value;
    if (!config.feriados.includes(fecha)) {
      setConfig({
        ...config,
        feriados: [...config.feriados, fecha].sort(),
      });
      inputElement.value = '';
    }
  }

  function removeFeriado(feriado: string) {
    if (!config) return;
    setConfig({
      ...config,
      feriados: config.feriados.filter(f => f !== feriado),
    });
  }

  function toggleProfessionalCollapse(name: string) {
    const newCollapsed = new Set(collapsedProfessionals);
    if (newCollapsed.has(name)) {
      newCollapsed.delete(name);
    } else {
      newCollapsed.add(name);
    }
    setCollapsedProfessionals(newCollapsed);
  }

  function toggleDayCollapse(prof: string, day: number) {
    const newCollapsed = { ...collapsedDays };
    if (!newCollapsed[prof]) {
      newCollapsed[prof] = new Set();
    }
    if (newCollapsed[prof].has(day)) {
      newCollapsed[prof].delete(day);
    } else {
      newCollapsed[prof].add(day);
    }
    setCollapsedDays(newCollapsed);
  }

  function updateProfSchedule(prof: string, day: number, slots: TimeSlot[]) {
    if (!config) return;
    setConfig({
      ...config,
      profesionales: {
        ...config.profesionales,
        [prof]: {
          ...config.profesionales[prof],
          [day]: slots,
        },
      },
    });
  }

  function addSlot(prof: string, day: number) {
    if (!config) return;
    const currentSlots = config.profesionales[prof]?.[day] || [];
    updateProfSchedule(prof, day, [...currentSlots, { inicio: '09:00', fin: '10:00' }]);
  }

  function removeSlot(prof: string, day: number, index: number) {
    if (!config) return;
    const currentSlots = config.profesionales[prof]?.[day] || [];
    updateProfSchedule(prof, day, currentSlots.filter((_, i) => i !== index));
  }

  function updateSlot(prof: string, day: number, index: number, field: 'inicio' | 'fin', value: string) {
    if (!config) return;
    const currentSlots = config.profesionales[prof]?.[day] || [];
    const updatedSlots = [...currentSlots];
    updatedSlots[index] = { ...updatedSlots[index], [field]: value };
    updateProfSchedule(prof, day, updatedSlots);
  }

  function addService() {
    if (!config) return;
    setConfig({
      ...config,
      servicios: [...config.servicios, { nombre: 'Nuevo servicio', duracionMinutos: 30, precio: 5000 }],
    });
  }

  function removeService(index: number) {
    if (!config) return;
    setConfig({
      ...config,
      servicios: config.servicios.filter((_, i) => i !== index),
    });
  }

  function updateService(index: number, field: keyof Config['servicios'][0], value: any) {
    if (!config) return;
    const updatedServices = [...config.servicios];
    updatedServices[index] = { ...updatedServices[index], [field]: value };
    setConfig({
      ...config,
      servicios: updatedServices,
    });
  }

  const todayCount = reservations.filter(r => isToday(r.fecha)).length;
  const upcomingCount = reservations.filter(r => isFuture(r.fecha)).length;

  return (
    <>
      <style jsx>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        .admin-root {
          min-height: 100vh;
          font-family: 'Inter', sans-serif;
          background: #0f172a;
          color: #e2e8f0;
        }

        /* Header */
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

        .btn {
          display: flex; align-items: center; justify-content: center; gap: 7px;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 600;
          font-family: 'Inter', sans-serif;
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s ease;
          border: 1px solid transparent;
        }

        .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; }

        .btn-refresh {
          background: rgba(99,102,241,0.15);
          color: #a5b4fc;
          border-color: rgba(99,102,241,0.3);
        }

        .btn-refresh:hover:not(:disabled) {
          background: rgba(99,102,241,0.25);
          border-color: rgba(99,102,241,0.5);
          color: #c7d2fe;
          transform: translateY(-1px);
        }

        .btn-logout {
          background: rgba(239,68,68,0.1);
          color: #fca5a5;
          border-color: rgba(239,68,68,0.25);
        }

        .btn-logout:hover:not(:disabled) {
          background: rgba(239,68,68,0.2);
          border-color: rgba(239,68,68,0.4);
          transform: translateY(-1px);
        }

        .refresh-icon {
          font-size: 14px;
          display: inline-block;
          transition: transform 0.6s ease;
        }

        .refresh-icon.spinning {
          animation: spin 0.8s linear infinite;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        /* Tabs */
        .tabs {
          display: flex;
          gap: 8px;
          padding: 0 32px;
          margin-top: 24px;
          border-bottom: 1px solid rgba(255,255,255,0.07);
        }

        .tab {
          padding: 14px 24px;
          font-size: 14px;
          font-weight: 600;
          color: rgba(148,163,184,0.7);
          cursor: pointer;
          border-bottom: 2px solid transparent;
          transition: all 0.2s ease;
        }

        .tab:hover {
          color: #cbd5e1;
          background: rgba(255,255,255,0.03);
        }

        .tab.active {
          color: #818cf8;
          border-bottom-color: #818cf8;
          background: rgba(129,140,248,0.05);
        }

        /* Main content */
        .admin-main {
          max-width: 1200px;
          margin: 0 auto;
          padding: 32px;
        }

        .section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 28px;
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

        /* Stats */
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

        /* Reservations Grid */
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
          width: 70px;
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
          background: rgba(239,68,68,0.1);
          color: #fca5a5;
          border: 1px solid rgba(239,68,68,0.25);
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s ease;
          letter-spacing: 0.2px;
        }

        .btn-delete:hover:not(:disabled) {
          background: rgba(239,68,68,0.2);
          border-color: rgba(239,68,68,0.4);
          color: #fecaca;
          transform: translateY(-1px);
        }

        /* Empty State */
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

        /* Loading */
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

        /* Modal */
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

        .btn-spinner {
          width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
        }

        /* Toast */
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

        /* Config Section */
        .config-section {
          margin-bottom: 32px;
        }

        .config-card {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 18px;
          padding: 28px;
          margin-bottom: 24px;
          transition: all 0.2s ease;
        }

        .config-card:hover {
          border-color: rgba(99,102,241,0.2);
          box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        }

        .config-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .config-title {
          font-size: 20px;
          font-weight: 700;
          color: #f8fafc;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .config-subtitle {
          font-size: 14px;
          color: rgba(148,163,184,0.7);
          margin-bottom: 20px;
        }

        .input {
          width: 100%;
          padding: 12px 16px;
          font-size: 14px;
          font-family: 'Inter', sans-serif;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px;
          color: #e2e8f0;
          outline: none;
          transition: all 0.2s ease;
        }

        .input:focus {
          border-color: #818cf8;
          box-shadow: 0 0 0 3px rgba(129,140,248,0.15);
          background: rgba(255,255,255,0.07);
        }

        .input::placeholder {
          color: rgba(148,163,184,0.5);
        }

        .btn-primary {
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: #fff;
          border: none;
          font-weight: 600;
          box-shadow: 0 4px 12px rgba(99,102,241,0.3);
        }

        .btn-primary:hover:not(:disabled) {
          opacity: 0.9;
          transform: translateY(-1px);
          box-shadow: 0 6px 16px rgba(99,102,241,0.4);
        }

        .btn-secondary {
          background: rgba(99,102,241,0.1);
          color: #a5b4fc;
          border-color: rgba(99,102,241,0.3);
        }

        .btn-secondary:hover:not(:disabled) {
          background: rgba(99,102,241,0.2);
          color: #c7d2fe;
          transform: translateY(-1px);
        }

        .btn-danger {
          background: rgba(239,68,68,0.1);
          color: #fca5a5;
          border-color: rgba(239,68,68,0.3);
        }

        .btn-danger:hover:not(:disabled) {
          background: rgba(239,68,68,0.2);
          color: #fecaca;
          transform: translateY(-1px);
        }

        .btn-small {
          padding: 8px 14px;
          font-size: 13px;
          font-weight: 600;
        }

        .btn-icon {
          padding: 8px;
          width: 36px;
          height: 36px;
        }

        .add-feriado-row {
          display: flex;
          gap: 12px;
        }

        .feriados-list {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-top: 20px;
        }

        .feriado-badge {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 16px;
          background: rgba(245,158,11,0.1);
          border: 1px solid rgba(245,158,11,0.3);
          border-radius: 10px;
          color: #fbbf24;
          font-size: 13px;
          font-weight: 500;
        }

        .feriado-badge button {
          background: transparent;
          border: none;
          color: #fca5a5;
          cursor: pointer;
          font-size: 18px;
          padding: 0;
          transition: transform 0.1s ease;
        }

        .feriado-badge button:hover {
          transform: scale(1.2);
        }

        .prof-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 14px;
          padding: 20px;
          margin-bottom: 16px;
          transition: all 0.2s ease;
        }

        .prof-card:hover {
          border-color: rgba(129,140,248,0.2);
        }

        .prof-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: pointer;
        }

        .prof-name {
          font-size: 17px;
          font-weight: 700;
          color: #f1f5f9;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .prof-avatar {
          width: 36px;
          height: 36px;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          font-weight: 700;
        }

        .collapse-icon {
          font-size: 18px;
          transition: transform 0.3s ease;
        }

        .collapse-icon.open {
          transform: rotate(180deg);
        }

        .prof-content {
          margin-top: 20px;
          animation: slideDown 0.2s ease;
        }

        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .day-section {
          margin-bottom: 18px;
          padding-bottom: 18px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }

        .day-section:last-child {
          border-bottom: none;
          margin-bottom: 0;
          padding-bottom: 0;
        }

        .day-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          font-size: 15px;
          font-weight: 600;
          color: #94a3b8;
          cursor: pointer;
        }

        .day-header:hover {
          color: #cbd5e1;
        }

        .slots-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .slot-row {
          display: flex;
          gap: 12px;
          align-items: center;
        }

        .slot-label {
          width: 60px;
          font-size: 13px;
          color: rgba(148,163,184,0.7);
        }

        .slot-input {
          flex: 1;
          padding: 10px 14px;
          font-size: 14px;
        }

        .service-row {
          display: grid;
          grid-template-columns: 2fr 1fr 1fr auto;
          gap: 14px;
          align-items: center;
          padding: 12px 0;
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }

        .service-row:last-child {
          border-bottom: none;
        }

        .service-row .input {
          padding: 10px 14px;
          font-size: 13px;
        }

        .action-row {
          display: flex;
          gap: 12px;
          margin-top: 24px;
          padding-top: 24px;
          border-top: 1px solid rgba(255,255,255,0.06);
        }

        .action-row.fixed-bottom {
          position: sticky;
          bottom: 24px;
          left: 0;
          right: 0;
          z-index: 50;
          background: linear-gradient(to top, #0f172a 60%, transparent);
          padding: 24px 0 0 0;
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
            {activeTab === 'reservas' && (
              <button
                id="btn-refresh"
                className="btn btn-refresh"
                onClick={() => fetchReservations(true)}
                disabled={refreshing || loading}
              >
                <span className={`refresh-icon ${refreshing ? 'spinning' : ''}`}>↻</span>
                {refreshing ? 'Actualizando...' : 'Refrescar'}
              </button>
            )}
            {activeTab === 'config' && (
              <button
                id="btn-refresh-config"
                className="btn btn-refresh"
                onClick={() => fetchConfig(true)}
                disabled={refreshing || loadingConfig}
              >
                <span className={`refresh-icon ${refreshing ? 'spinning' : ''}`}>↻</span>
                {refreshing ? 'Actualizando...' : 'Refrescar'}
              </button>
            )}
            <button id="btn-logout" className="btn btn-logout" onClick={handleLogout}>
              ⎋ Cerrar sesión
            </button>
          </div>
        </header>

        {/* Tabs */}
        <div className="tabs">
          <div
            className={`tab ${activeTab === 'reservas' ? 'active' : ''}`}
            onClick={() => setActiveTab('reservas')}
          >
            📋 Reservas
          </div>
          <div
            className={`tab ${activeTab === 'config' ? 'active' : ''}`}
            onClick={() => setActiveTab('config')}
          >
            ⚙️ Configuración
          </div>
        </div>

        {/* Main */}
        <main className="admin-main">
          {activeTab === 'reservas' && (
            <>
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
                          <span className="info-icon">👨‍⚕️</span>
                          <span className="info-label">Profesional</span>
                          <span className="info-value">{res.profesional}</span>
                        </div>
                        <div className="card-info-row">
                          <span className="info-icon">👤</span>
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
                            className="btn btn-delete"
                            onClick={() => setDeleteTarget(res)}
                          >
                            🗑️ Eliminar cita
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          )}

          {activeTab === 'config' && (
            <>
              <div className="section-header">
                <div>
                  <h1 className="section-title">Configuración</h1>
                  <p className="section-subtitle">
                    {loadingConfig ? 'Cargando...' : 'Gestiona horarios, feriados y servicios'}
                  </p>
                </div>
              </div>

              {loadingConfig ? (
                <div className="loading-grid">
                  <div className="skeleton-card" style={{ gridColumn: '1 / -1', padding: '32px' }}>
                    <div className="skeleton-line" style={{ width: '30%', height: 20, marginBottom: 24 }} />
                    <div className="skeleton-line" style={{ width: '80%' }} />
                    <div className="skeleton-line" style={{ width: '60%' }} />
                  </div>
                </div>
              ) : config ? (
                <>
                  {/* Feriados */}
                  <div className="config-card">
                    <div className="config-card-header">
                      <h2 className="config-title">🎉 Feriados</h2>
                    </div>
                    <p className="config-subtitle">
                      Agrega días feriados en los que no habrá atenciones
                    </p>
                    <div className="add-feriado-row">
                      <input
                        id="feriadoInput"
                        type="date"
                        className="input"
                      />
                      <button className="btn btn-secondary btn-small" onClick={addFeriado}>
                        ➕ Agregar feriado
                      </button>
                    </div>
                    <div className="feriados-list">
                      {config.feriados.length === 0 ? (
                        <span style={{ color: 'rgba(148,163,184,0.5)', fontSize: 14 }}>
                          No hay feriados configurados
                        </span>
                      ) : (
                        config.feriados.map(feriado => (
                          <div key={feriado} className="feriado-badge">
                            📅 {formatDate(feriado)}
                            <button onClick={() => removeFeriado(feriado)}>×</button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Servicios */}
                  <div className="config-card">
                    <div className="config-card-header">
                      <h2 className="config-title">🩺 Servicios</h2>
                      <button className="btn btn-secondary btn-small" onClick={addService}>
                        ➕ Agregar servicio
                      </button>
                    </div>
                    <p className="config-subtitle">
                      Configura los servicios disponibles, su duración y precio
                    </p>
                    {config.servicios.map((servicio, index) => (
                      <div key={index} className="service-row">
                        <input
                          type="text"
                          className="input"
                          placeholder="Nombre del servicio"
                          value={servicio.nombre}
                          onChange={(e) => updateService(index, 'nombre', e.target.value)}
                        />
                        <input
                          type="number"
                          className="input"
                          placeholder="Duración (min)"
                          value={servicio.duracionMinutos}
                          onChange={(e) => updateService(index, 'duracionMinutos', parseInt(e.target.value) || 30)}
                        />
                        <input
                          type="number"
                          className="input"
                          placeholder="Precio"
                          value={servicio.precio}
                          onChange={(e) => updateService(index, 'precio', parseInt(e.target.value) || 0)}
                        />
                        <button
                          className="btn btn-danger btn-icon"
                          onClick={() => removeService(index)}
                        >
                          🗑️
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Profesionales */}
                  <div className="config-card">
                    <div className="config-card-header">
                      <h2 className="config-title">👨‍⚕️ Horarios de profesionales</h2>
                    </div>
                    <p className="config-subtitle">
                      Configura los horarios de atención de cada profesional
                    </p>
                    {Object.entries(config.profesionales).map(([prof, schedule]) => (
                      <div key={prof} className="prof-card">
                        <div
                          className="prof-header"
                          onClick={() => toggleProfessionalCollapse(prof)}
                        >
                          <div className="prof-name">
                            <div className="prof-avatar">{prof.charAt(0)}</div>
                            {prof}
                          </div>
                          <span className={`collapse-icon ${collapsedProfessionals.has(prof) ? '' : 'open'}`}>
                            ▼
                          </span>
                        </div>
                        {!collapsedProfessionals.has(prof) && (
                          <div className="prof-content">
                            {DAYS.map(day => (
                              <div key={day.id} className="day-section">
                                <div
                                  className="day-header"
                                  onClick={() => toggleDayCollapse(prof, day.id)}
                                >
                                  <span>{day.name}</span>
                                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <span className={`collapse-icon ${collapsedDays[prof]?.has(day.id) ? '' : 'open'}`} style={{ fontSize: '14px' }}>
                                      ▼
                                    </span>
                                    <button
                                      className="btn btn-secondary btn-small"
                                      onClick={(e) => { e.stopPropagation(); addSlot(prof, day.id); }}
                                    >
                                      ➕ Agregar horario
                                    </button>
                                  </div>
                                </div>
                                {!collapsedDays[prof]?.has(day.id) && (
                                  <div className="slots-list">
                                    {(schedule[day.id] || []).map((slot, slotIndex) => (
                                      <div key={slotIndex} className="slot-row">
                                        <span className="slot-label">Horario {slotIndex + 1}</span>
                                        <input
                                          type="time"
                                          className="input slot-input"
                                          value={slot.inicio}
                                          onChange={(e) => updateSlot(prof, day.id, slotIndex, 'inicio', e.target.value)}
                                        />
                                        <span style={{ color: '#94a3b8', fontSize: '14px' }}>a</span>
                                        <input
                                          type="time"
                                          className="input slot-input"
                                          value={slot.fin}
                                          onChange={(e) => updateSlot(prof, day.id, slotIndex, 'fin', e.target.value)}
                                        />
                                        <button
                                          className="btn btn-danger btn-icon"
                                          onClick={() => removeSlot(prof, day.id, slotIndex)}
                                        >
                                          🗑️
                                        </button>
                                      </div>
                                    ))}
                                    {(!schedule[day.id] || schedule[day.id].length === 0) && (
                                      <span style={{ color: 'rgba(148,163,184,0.5)', fontSize: 13, padding: '8px 0' }}>
                                        No hay horarios configurados para este día
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}

                    <div className="action-row fixed-bottom">
                      <button
                        className="btn btn-primary"
                        style={{ flex: 1, padding: '14px', fontSize: '15px' }}
                        onClick={handleSaveConfig}
                        disabled={savingConfig}
                      >
                        {savingConfig ? (
                          <>
                            <div className="btn-spinner" />
                            Guardando...
                          </>
                        ) : (
                          '💾 Guardar configuración'
                        )}
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
            </>
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
