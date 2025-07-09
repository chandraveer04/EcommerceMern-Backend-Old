import Redis from "ioredis"
import dotenv from "dotenv"
import fetch from "node-fetch"
dotenv.config();

// Constants for Upstash REST API
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Check if we have REST API credentials
const hasRestCredentials = UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN;

// REST API client for Upstash Redis
class UpstashRedisRestClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.isConnected = true;
    console.log('Using Upstash Redis REST API client');
  }

  // Helper method to make API requests
  async _request(command, args = []) {
    try {
      const response = await fetch(`${this.url}/${command}/${args.map(encodeURIComponent).join('/')}`, {
        headers: {
          Authorization: `Bearer ${this.token}`
        }
      });

      if (!response.ok) {
        throw new Error(`Redis REST API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.result;
    } catch (error) {
      console.error(`Redis REST API error in ${command}:`, error);
      throw error;
    }
  }

  // Redis-compatible methods
  async get(key) {
    return this._request('get', [key]);
  }

  async set(key, value, ...args) {
    // Handle EX argument for expiration
    if (args.includes('EX') && args.length > args.indexOf('EX') + 1) {
      const exIndex = args.indexOf('EX');
      const seconds = args[exIndex + 1];
      return this._request('set', [key, value, 'ex', seconds]);
    }
    return this._request('set', [key, value]);
  }

  async del(key) {
    return this._request('del', [key]);
  }

  async ping() {
    return this._request('ping');
  }

  // Event emitter methods (no-op for REST API)
  on(event, callback) {
    if (event === 'connect') {
      // Simulate connect event
      setTimeout(callback, 0);
    }
    return this;
  }
}

// Create Redis client based on available credentials
let redisClient;

if (hasRestCredentials) {
  // Use REST API client
  redisClient = new UpstashRedisRestClient(
    UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN
  );
  console.log('Initialized Upstash Redis REST API client');
} else {
  // Fall back to traditional Redis client
  try {
    redisClient = new Redis(process.env.UPSTASH_REDIS_URL);
    console.log('Initialized traditional Redis client');

// Handle Redis connection events
redisClient.on('connect', () => {
    console.log('Redis client connected');
});

redisClient.on('error', (err) => {
    console.error('Redis connection error:', err);
});

redisClient.on('reconnecting', () => {
    console.log('Redis client reconnecting');
});
  } catch (error) {
    console.error('Failed to initialize Redis client:', error);
    // Create a simple in-memory mock if Redis is unavailable
    redisClient = {
      cache: new Map(),
      get: async (key) => redisClient.cache.get(key),
      set: async (key, value) => redisClient.cache.set(key, value),
      del: async (key) => {
        redisClient.cache.delete(key);
        return 1;
      },
      ping: async () => 'PONG',
      on: () => redisClient
    };
    console.log('Using in-memory Redis mock due to connection error');
  }
}

// Export Redis client
export const redis = redisClient;

// Health check method
export const isRedisHealthy = async () => {
    try {
        const result = await redis.ping();
        return result === 'PONG';
    } catch (error) {
        console.error('Redis health check failed:', error);
        return false;
    }
};

// Cache wrapper function
export const getOrSetCache = async (key, callback, expiryInSeconds = 3600) => {
    try {
        const cachedData = await redis.get(key);
        
        if (cachedData) {
            return JSON.parse(cachedData);
        }
        
        const freshData = await callback();
        
        if (freshData) {
            await redis.set(key, JSON.stringify(freshData), 'EX', expiryInSeconds);
        }
        
        return freshData;
    } catch (error) {
        console.error('Cache operation failed:', error);
        // Fallback to original callback on cache error
        return callback();
    }
};

//redis is a key-value store in json format

