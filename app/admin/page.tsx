
interface Reservation {
  servicio: string;
  nombre: string;
  fecha: string;
  hora: string;
  chatId: number;
}

async function getReservations() {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/api/admin/reservations`, {
      cache: 'no-store',
    });
    const data = await res.json();
    return data.reservations || [];
  } catch (error) {
    console.error('Error fetching reservations:', error);
    return [];
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
              gridTemplateColumns: 'repeat(1, 1fr)',
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
