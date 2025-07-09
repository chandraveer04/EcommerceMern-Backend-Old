import { Web3 } from "web3";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ES Module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// Load PaymentProcessor.json using fs instead of import
const paymentProcessorPath = path.resolve(__dirname, "../../blockchain/build/contracts/PaymentProcessor.json");
let PaymentProcessor = { networks: {} }; // Default empty placeholder

// Check for and reload contract ABI if contract is redeployed
let lastContractLoadTime = 0;
const CONTRACT_RELOAD_INTERVAL = 30000; // 30 seconds

// Function to load contract ABI
const loadContractAbi = () => {
  try {
    if (fs.existsSync(paymentProcessorPath)) {
      const fileStats = fs.statSync(paymentProcessorPath);
      const lastModified = fileStats.mtimeMs;
      
      // Only reload if the file was modified since the last load
      if (lastModified > lastContractLoadTime) {
        const contractJson = fs.readFileSync(paymentProcessorPath, 'utf8');
        PaymentProcessor = JSON.parse(contractJson);
        lastContractLoadTime = Date.now();
        console.log("Successfully loaded PaymentProcessor contract at:", paymentProcessorPath);
      }
    } else {
      console.warn(`PaymentProcessor contract not found at: ${paymentProcessorPath}`);
    }
  } catch (error) {
    console.error(`Error loading PaymentProcessor contract JSON: ${error.message || error}`);
  }
};

// Initial load
loadContractAbi();

// Reload contract ABI periodically to detect redeployments
setInterval(loadContractAbi, CONTRACT_RELOAD_INTERVAL);

// Get providers from environment variables
const httpProvider = process.env.BLOCKCHAIN_PROVIDER_URL || "http://127.0.0.1:7545";

// Fix WebSocket URL if it's using https:// instead of wss://
let wsProvider = process.env.WS_BLOCKCHAIN_PROVIDER_URL || "ws://127.0.0.1:7545";
if (wsProvider.startsWith('https://')) {
  // Convert https://network.infura.io/v3/PROJECT_ID to wss://network.infura.io/ws/v3/PROJECT_ID
  wsProvider = wsProvider.replace('https://', 'wss://');
  
  // Add /ws/ before v3 if it's missing and this is an Infura URL
  if (wsProvider.includes('infura.io') && !wsProvider.includes('/ws/')) {
    wsProvider = wsProvider.replace('/v3/', '/ws/v3/');
  }
  
  console.log('Fixed WebSocket URL format:', wsProvider);
}

// Initialize Web3 instances
let web3;
let web3Ws; // Separate instance for WebSocket events
let isBlockchainAvailable = false;
let isWebSocketAvailable = false;
let blockchainRetryCount = 0;
let wsRetryCount = 0;
const MAX_BLOCKCHAIN_RETRIES = 5;
const MAX_WS_RETRIES = 10;

/**
 * Create a new HTTP provider for blockchain interactions
 */
const createHttpProvider = () => {
  try {
    const httpWebProvider = new Web3.providers.HttpProvider(httpProvider, {
      timeout: 5000, // shorter timeout for faster feedback
      keepAlive: true,
    });
    
    // Create main Web3 instance with HTTP provider
    web3 = new Web3(httpWebProvider);
    console.log('HTTP provider initialized for blockchain calls');
    
    // Check connection immediately
    web3.eth.getBlockNumber()
      .then(() => {
        isBlockchainAvailable = true;
        console.log('Successfully connected to blockchain at', httpProvider);
        blockchainRetryCount = 0; // Reset retry count on success
      })
      .catch(error => {
        console.error('Initial blockchain connection failed:', error.message || error);
        isBlockchainAvailable = false;
      });
      
  } catch (error) {
    console.error(`Failed to initialize HTTP Web3 provider:`, error.message || error);
    web3 = new Web3(); // Create minimal instance that will fail gracefully
    isBlockchainAvailable = false;
  }
};

/**
 * Create a new WebSocket provider for blockchain events
 * This is now independent of HTTP provider availability
 */
const createWebSocketProvider = () => {
  try {
    // Remove dependency on HTTP provider
    // if (!isBlockchainAvailable) {
    //   console.warn('Skipping WebSocket provider creation until blockchain is available');
    //   return;
    // }
    
    const webSocketProvider = new Web3.providers.WebsocketProvider(wsProvider, {
      timeout: 5000, // timeout for connection attempts
      // Enable auto reconnection with more aggressive settings
      reconnect: {
        auto: true,
        delay: 1000, // 1 second delay between reconnection attempts
        maxAttempts: 10, // more reconnection attempts
        onTimeout: true // reconnect on timeout too
      }
    });
    
    // Create separate Web3 instance for events
    web3Ws = new Web3(webSocketProvider);
    
    // Add provider event listeners
    webSocketProvider.on('error', e => {
      console.error('WebSocket provider error:', e.message || 'Connection failed');
      isWebSocketAvailable = false;
    });
    
    webSocketProvider.on('end', () => {
      console.warn('WebSocket connection ended');
      isWebSocketAvailable = false;
      
      // Try to reconnect after connection ends (outside of the auto-reconnect)
      if (wsRetryCount < MAX_WS_RETRIES) {
        wsRetryCount++;
        console.log(`WebSocket disconnected. Manual reconnection attempt ${wsRetryCount}/${MAX_WS_RETRIES} in 3 seconds...`);
        setTimeout(createWebSocketProvider, 3000);
      }
    });
    
    webSocketProvider.on('connect', () => {
      console.log('WebSocket provider connected successfully to', wsProvider);
      isWebSocketAvailable = true;
      wsRetryCount = 0; // Reset retry count on successful connection
    });
    
    // Test the connection immediately to confirm it's working
    setTimeout(() => {
      if (web3Ws) {
        web3Ws.eth.net.getId()
          .then(() => {
            console.log('WebSocket connection verified and working!');
            isWebSocketAvailable = true;
          })
          .catch(error => {
            console.error('WebSocket connection test failed:', error.message || error);
          });
      }
    }, 1000);
    
    console.log('WebSocket provider initialized for blockchain events');
  } catch (wsError) {
    console.error('Failed to initialize WebSocket provider:', wsError.message || wsError);
    isWebSocketAvailable = false;
    
    // Try again after a delay if within retry limits
    if (wsRetryCount < MAX_WS_RETRIES) {
      wsRetryCount++;
      console.log(`WebSocket initialization failed. Retry ${wsRetryCount}/${MAX_WS_RETRIES} in 5 seconds...`);
      setTimeout(createWebSocketProvider, 5000);
    } else {
      console.error('Max WebSocket retry attempts reached. Giving up on WebSocket connection.');
      // Only use HTTP as fallback when we've exhausted all WS connection attempts
      web3Ws = web3;
    }
  }
};

// Initial setup
createHttpProvider();
createWebSocketProvider(); // Now independent of HTTP provider

// Set up periodic reconnection for improved reliability
setInterval(() => {
  if (!isBlockchainAvailable && blockchainRetryCount < MAX_BLOCKCHAIN_RETRIES) {
    console.log(`Attempting to reconnect to blockchain HTTP (${++blockchainRetryCount}/${MAX_BLOCKCHAIN_RETRIES})...`);
    createHttpProvider();
  }
  
  if (!isWebSocketAvailable && wsRetryCount < MAX_WS_RETRIES) {
    console.log(`Periodic check: WebSocket unavailable. Reconnection attempt ${++wsRetryCount}/${MAX_WS_RETRIES}...`);
    createWebSocketProvider();
  }
}, 15000); // Check every 15 seconds

/**
 * Checks if the blockchain connection is healthy
 * @returns {Promise<boolean>} True if connected, false otherwise
 */
export const isBlockchainHealthy = async () => {
  try {
    // Try to get network ID as a simple health check
    await web3.eth.net.getId();
    isBlockchainAvailable = true;
    return true;
  } catch (error) {
    isBlockchainAvailable = false;
    console.error("Blockchain health check failed:", error.message || error);
    return false;
  }
};

/**
 * Checks if the WebSocket connection for events is healthy
 * @returns {Promise<boolean>} True if connected, false otherwise
 */
export const isEventSubscriptionHealthy = async () => {
  try {
    if (!isWebSocketAvailable) {
      // If we know it's not available, don't even try
      return false;
    }
    
    // Verify that web3Ws is defined and has a provider
    if (!web3Ws || !web3Ws.currentProvider) {
      console.warn("WebSocket provider not properly initialized");
      isWebSocketAvailable = false;
      return false;
    }
    
    await web3Ws.eth.net.getId();
    return true;
  } catch (error) {
    console.error("WebSocket event subscription check failed:", error.message || error);
    isWebSocketAvailable = false;
    return false;
  }
};

/**
 * Gets the contract instance with robust error handling
 * @param {boolean} forEvents - Whether to return a contract instance for event subscriptions
 * @returns {Promise<Contract|null>} Contract instance or null if unavailable
 */
export const getPaymentProcessorContract = async (forEvents = false) => {
  try {
    // If blockchain is not available, return null quickly
    if ((forEvents && !isWebSocketAvailable) || (!forEvents && !isBlockchainAvailable)) {
      return null;
    }
    
    // Reload contract ABI to ensure we have the latest version
    loadContractAbi();
    
    // Use the appropriate web3 instance based on the purpose
    const web3Instance = forEvents ? web3Ws : web3;
    
    // Check connection first
    const isHealthy = forEvents 
      ? await isEventSubscriptionHealthy() 
      : await isBlockchainHealthy();
      
    if (!isHealthy) {
      console.warn(`Blockchain connection not healthy for ${forEvents ? 'events' : 'calls'}`);
      return null;
    }
    
    const networkId = await web3Instance.eth.net.getId();
    const deployedNetwork = PaymentProcessor.networks[networkId];
    
    if (!deployedNetwork) {
      console.warn(`Contract not deployed on network ID: ${networkId}`);
      return null;
    }
    
    const contractInstance = new web3Instance.eth.Contract(
      PaymentProcessor.abi,
      deployedNetwork.address
    );
    
    return contractInstance;
  } catch (error) {
    console.error(`Failed to initialize contract for ${forEvents ? 'events' : 'calls'}:`, error.message || error);
    return null;
  }
};

// Export web3 instances
export { web3, web3Ws }; 