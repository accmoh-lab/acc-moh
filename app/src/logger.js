'use strict';
// سجل تقني منفصل عن رسائل المستخدم. يُوجَّه إلى stdout بصيغة JSON (جاهز لأي Log Aggregator).
const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'error' : 'info');
const order = { debug: 0, info: 1, warn: 2, error: 3 };
const w = (l, msg, extra) => { if (order[l] >= order[level]) console.log(JSON.stringify({ t: new Date().toISOString(), l, msg, ...extra })); };
module.exports = { info: (m, e) => w('info', m, e), warn: (m, e) => w('warn', m, e), error: (m, e) => w('error', m, e), debug: (m, e) => w('debug', m, e) };
