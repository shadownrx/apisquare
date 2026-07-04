require('dotenv').config();
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (!TELEGRAM_TOKEN) {
  console.error('❌ Error: TELEGRAM_TOKEN no encontrado en .env');
  console.error('   Crea un archivo .env con tu token.');
  process.exit(1);
}

// Tu URL de producción en Vercel
const WEBHOOK_URL = 'https://apisquare.vercel.app/api/webhook';

async function setupWebhook() {
  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`;

  console.log(`Configurando webhook en: ${WEBHOOK_URL}`);
  console.log('Usando token:', TELEGRAM_TOKEN.substring(0, 10) + '...');

  try {
    const response = await axios.post(apiUrl, null, {
      params: { url: WEBHOOK_URL }
    });
    
    const data = response.data;

    if (data.ok) {
      console.log('✅ Webhook configurado exitosamente!');
      console.log('   Ahora puedes probar el bot enviando /start');
    } else {
      console.error('❌ Error al configurar el webhook:');
      console.error('   Código:', data.error_code);
      console.error('   Descripción:', data.description);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error de red al configurar el webhook:', error.message);
    if (error.response) {
      console.error('   Respuesta de Telegram:', error.response.data);
    }
    process.exit(1);
  }
}

setupWebhook();
