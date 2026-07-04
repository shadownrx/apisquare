const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.log('Uso: node scripts/generate-hash.js <contraseña>');
  process.exit(1);
}

bcrypt.hash(password, 10).then(hash => {
  console.log('\n✅ Hash generado:\n');
  console.log(hash);
  console.log('\nCopia esta línea en tu .env:\n');
  console.log(`ADMIN_PASSWORD=${hash}`);
});
