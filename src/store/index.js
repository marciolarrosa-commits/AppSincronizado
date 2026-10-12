'use strict';
const { createMemoryStore } = require('./memory');

// Sin REDIS_URL -> memoria (una sola instancia). Con REDIS_URL -> Redis/Valkey (varias instancias).
function createStore(config, logger) {
  if (config.redisUrl) return require('./redis').createRedisStore(config, logger);
  return createMemoryStore(config);
}

module.exports = { createStore };
