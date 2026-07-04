require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.argv[2];

if (!TELEGRAM_TOKEN) {
  console.error('❌ Error: TELEGRAM_TOKEN no encontrado en .env');
  process.exit(1);
}

if (!WEBHOOK_URL) {
  console.error('❌ Error: Debes pasar la URL del webhook como argumento.');
  console.error('   Uso: node setup-webhook.js https://tu-proyecto.vercel.app/api/webhook');
  process.exit(1);
}

async function setupWebhook() {
  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_URL)}`;

  try {
    const response = await fetch(apiUrl);
    const data = await response.json();

    if (data.ok) {
      console.log('✅ Webhook configurado exitosamente.');
      console.log(`   URL: ${WEBHOOK_URL}`);
      console.log(`   Respuesta de Telegram:`, data.description);
    } else {
      console.error('❌ Error al configurar el webhook:', data.description);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error de red al configurar el webhook:', error.message);
    process.exit(1);
  }
}

setupWebhook();
