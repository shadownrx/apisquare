require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const { SquareClient, SquareEnvironment } = require('square');

// Configuración de clientes
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: {
    interval: 300,
    params: {
      timeout: 30 // segundos, bajado para evitar que el router/NAT corte la conexión de polling
    }
  }
});

const squareClient = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: SquareEnvironment.Sandbox, // tu token y location_id son de sandbox, no producción
});

// Comando: /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "¡Hola! Soy tu asistente de reservas de Square. Escribe /servicios para ver lo que ofrecemos.");
});

// Comando: /servicios
bot.onText(/\/servicios/, async (msg) => {
  try {
    bot.sendMessage(msg.chat.id, "Consultando servicios...");

    const pageableResponse = await squareClient.catalog.list({ types: 'ITEM' });

    const items = [];
    for await (const item of pageableResponse) {
      items.push(item);
    }

    if (!items || items.length === 0) {
      return bot.sendMessage(msg.chat.id, "No se encontraron servicios disponibles.");
    }

    let mensaje = "Nuestros servicios:\n";
    items.forEach(item => {
      if (item.itemData && item.itemData.name) {
        mensaje += `• ${item.itemData.name}\n`;
      }
    });

    bot.sendMessage(msg.chat.id, mensaje);
  } catch (error) {
    bot.sendMessage(msg.chat.id, "Hubo un error al cargar los servicios. Revisa la consola.");
    console.error("Error completo de Square:", error);
  }
});