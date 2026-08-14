import fs from 'node:fs';

fs.mkdirSync('dist/web/public', { recursive: true });
fs.cpSync('src/web/public', 'dist/web/public', { recursive: true });
