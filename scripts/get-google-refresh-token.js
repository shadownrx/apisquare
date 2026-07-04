const { google } = require('googleapis');
const readline = require('readline');

// Tus credenciales de Google (directamente para este paso)
const GOOGLE_CLIENT_ID = '393535950822-sbgvht6dona36rvk4vktsafddgcogbpb.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';
const GOOGLE_REDIRECT_URI = 'http://localhost:3000';

// Configure the OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Generate the authentication URL
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/calendar'],
  prompt: 'consent' // Force to get a refresh token
});

console.log('1. Abre esta URL en tu navegador:\n');
console.log(authUrl);
console.log('\n2. Autoriza la aplicación y copia el código que aparece en la URL de redirección.');

// Read the authorization code from the console
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('\nPega el código aquí: ', async (code) => {
  try {
    // Exchange the authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n3. ¡Éxito! Copia estos valores en tu archivo .env o en Vercel:\n');
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('\nNota: Guarda este refresh token en un lugar seguro, no lo compartas públicamente!');
  } catch (error) {
    console.error('\nError al obtener el refresh token:', error.message);
    if (error.response) {
      console.error('Detalles del error:', error.response.data);
    }
  }
  rl.close();
});
