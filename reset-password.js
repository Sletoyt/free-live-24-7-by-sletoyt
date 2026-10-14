const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('================================================================');
console.log('  🔒 SLETO SKY 24/7 — VPS MASTER PASSWORD MANAGER');
console.log('================================================================');

function setPassword(pwd) {
  if (!pwd || pwd.length < 4) {
    console.log('❌ Password must be at least 4 characters long.');
    process.exit(1);
  }

  if (pwd.toUpperCase() === 'CLEAR') {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE);
    }
    console.log('✅ Admin password removed successfully.');
    console.log('👉 Open your web link to set up a new password via the Web Wizard.\n');
    process.exit(0);
  }

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(pwd, salt);

  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify({ passwordHash, salt, configured: true, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );

  console.log('================================================================');
  console.log('✅ Master admin password successfully updated on this VPS!');
  console.log('👉 You can now log in on your public web domain with your new password.');
  console.log('================================================================\n');
  process.exit(0);
}

if (process.argv.includes('--clear')) {
  if (fs.existsSync(AUTH_FILE)) {
    fs.unlinkSync(AUTH_FILE);
  }
  console.log('✅ Admin password removed successfully.');
  console.log('👉 Next time you open the web link, the First-Time Setup Wizard will appear.\n');
  process.exit(0);
}

const directArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (directArg) {
  setPassword(directArg.trim());
} else {
  rl.question('Enter new master admin password (or type "CLEAR" to reset): ', (input) => {
    setPassword(input.trim());
  });
}
