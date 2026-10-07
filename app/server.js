'use strict';
const http = require('node:http');
process.env.TZ = process.env.TZ || 'Africa/Cairo';
const db = require('./src/db');
const logger = require('./src/logger');
db.open();
require('./src/routes');
const { handle } = require('./src/http');
const automation = require('./src/automation');

const PORT = Number(process.env.PORT || 3000);
const server = http.createServer(handle);
if (require.main === module) {
  if (!db.get('SELECT 1 x FROM org_units LIMIT 1') && process.env.AUTO_SEED !== '0') { require('./src/seed').seed(); logger.info('seeded demo data'); }
  automation.start();
  server.listen(PORT, () => logger.info('listening', { port: PORT, demo: process.env.DEMO_MODE === '1' }));
}
module.exports = { server };
