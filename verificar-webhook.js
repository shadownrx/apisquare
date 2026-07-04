require('dotenv').config();
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

async function verificarWebhook() {
  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`;

  try {
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data.ok) {
      console.log('✅ Estado del webhook:');
      console.log(`   URL configurada: ${data.result.url || 'Ninguna'}`);
      console.log(`   Último error: ${data.result.last_error_message || 'Ninguno'}`);
      console.log(`   Actualizaciones pendientes: ${data.result.pending_update_count}`);
    } else {
      console.error('❌ Error al verificar webhook:', data.description);
    }
  } catch (error) {
    console.error('❌ Error de red:', error.message);
  }
}

verificarWebhook();
