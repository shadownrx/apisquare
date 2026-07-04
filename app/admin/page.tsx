
import { createClient } from '@vercel/kv';

interface Reservation {
  servicio: string;
  nombre: string;
  fecha: string;
  hora: string;
  chatId: number;
}

// Función para obtener reservas directamente (sin fetch)
async function getReservations(): Promise<Reservation[]> {
  try {
    // Verificar si KV está disponible
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      // Si no hay KV (local), devolver datos de ejemplo
      return [];
    }

    const kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    // Obtener todas las claves de reservas
    const keys = await kv.keys('reserva:*');
    const reservations: Reservation[] = [];

    for (const key of keys) {
      const value = await kv.get(key);
      if (value) {
        const reservation = typeof value === 'string' ? JSON.parse(value) : value;
        reservations.push(reservation);
      }
    }

    return reservations;
  } catch (error) {
    console.error('Error fetching reservations:', error);
    return []; // Devolver array vacío en caso de error
  }
}

export default async function AdminPage() {
  const reservations = await getReservations();

  return (
    <div style={{
      minHeight: '100vh',
      padding: '24px',
      backgroundColor: '#f9fafb',
    }}>
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
      }}>
        <h1 style={{
          fontSize: '30px',
          fontWeight: 'bold',
          marginBottom: '32px',
          color: '#111827',
        }}>
          Panel de Administración
        </h1>

        <div style={{ marginBottom: '32px' }}>
          <h2 style={{
            fontSize: '24px',
            fontWeight: '600',
            marginBottom: '16px',
            color: '#1f2937',
          }}>
            Reservas
          </h2>

          {reservations.length === 0 ? (
            <p style={{ color: '#4b5563' }}>No hay reservas aún.</p>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: '16px',
            }}>
              {reservations.map((res, index) => (
                <div
                  key={index}
                  style={{
                    padding: '24px',
                    backgroundColor: '#ffffff',
                    borderRadius: '8px',
                    boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1)',
                  }}
                >
                  <h3 style={{
                    fontSize: '20px',
                    fontWeight: 'bold',
                    color: '#111827',
                    marginBottom: '8px',
                  }}>
                    {res.servicio}
                  </h3>
                  <p style={{ color: '#374151', marginBottom: '4px' }}>
                    <strong>Cliente:</strong> {res.nombre}
                  </p>
                  <p style={{ color: '#374151', marginBottom: '4px' }}>
                    <strong>Fecha:</strong> {res.fecha}
                  </p>
                  <p style={{ color: '#374151' }}>
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
