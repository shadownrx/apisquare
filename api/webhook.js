require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const { SquareClient, SquareEnvironment } = require('square');

// Instanciar bot SIN polling (modo webhook)
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

// Instanciar cliente de Square (igual que bot.js)
const squareClient = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: SquareEnvironment.Sandbox,
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

// Handler serverless para Vercel
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(200).json({ status: 'Bot webhook activo. Esperando POSTs de Telegram.' });
    }

    bot.processUpdate(req.body);
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error procesando update de Telegram:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};
