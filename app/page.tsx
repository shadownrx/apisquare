export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <h1 className="text-4xl font-bold mb-4">ApiSquare</h1>
      <p className="text-lg mb-6">Sistema de Reservas con Bot de Telegram</p>
      <div className="flex gap-4">
        <a href="/admin" className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
          Panel de Administración
        </a>
      </div>
    </div>
  );
}
