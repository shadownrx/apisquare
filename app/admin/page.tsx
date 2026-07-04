'use client';

import { useEffect, useState } from 'react';

interface Reservation {
  servicio: string;
  nombre: string;
  fecha: string;
  hora: string;
  chatId: number;
}

export default function AdminPage() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchReservations() {
      try {
        const res = await fetch('/api/admin/reservations');
        const data = await res.json();
        setReservations(data.reservations || []);
      } catch (error) {
        console.error('Error fetching reservations:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchReservations();
  }, []);

  return (
    <div className="min-h-screen p-6 bg-gray-50 dark:bg-gray-900">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8 text-gray-900 dark:text-white">
          Panel de Administración
        </h1>

        <div className="mb-8">
          <h2 className="text-2xl font-semibold mb-4 text-gray-800 dark:text-gray-100">
            Reservas
          </h2>
          
          {loading ? (
            <p className="text-gray-600 dark:text-gray-400">Cargando reservas...</p>
          ) : reservations.length === 0 ? (
            <p className="text-gray-600 dark:text-gray-400">No hay reservas aún.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {reservations.map((res, index) => (
                <div
                  key={index}
                  className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow"
                >
                  <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                    {res.servicio}
                  </h3>
                  <p className="text-gray-700 dark:text-gray-300 mb-1">
                    <strong>Cliente:</strong> {res.nombre}
                  </p>
                  <p className="text-gray-700 dark:text-gray-300 mb-1">
                    <strong>Fecha:</strong> {res.fecha}
                  </p>
                  <p className="text-gray-700 dark:text-gray-300">
                    <strong>Hora:</strong> {res.hora}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
