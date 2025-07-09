import { Web3 } from "web3";
import { redis } from "../lib/redis.js";
import asyncHandler from "express-async-handler";
import { ethers } from "ethers";

/**
 * Middleware to validate cryptocurrency payment requests
 * Performs preliminary validation before the actual blockchain verification
 */
export const validateCryptoPayment = asyncHandler(async (req, res, next) => {
    const { products, paymentId, walletAddress, transactionHash, amount } = req.body;
    
    // Validate required fields
    if (!products || !Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ error: "Invalid products data" });
    }
    
    if (!paymentId) {
        return res.status(400).json({ error: "Payment ID is required" });
    }
    
    if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address is required" });
    }
    
    if (!transactionHash) {
        return res.status(400).json({ error: "Transaction hash is required" });
    }
    
    if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
    }
    
    // Validate wallet address format
    if (!ethers.isAddress(walletAddress)) {
        return res.status(400).json({ error: "Invalid wallet address format" });
    }
    
    // Check transaction hash format
    const txHashRegex = /^0x([A-Fa-f0-9]{64})$/;
    if (!txHashRegex.test(transactionHash)) {
        return res.status(400).json({ error: "Invalid transaction hash format" });
    }
    
    // Check if this transaction was already processed (using Redis)
    try {
        const cachedTx = await redis.get(`tx-processing:${transactionHash}`);
        if (cachedTx) {
            // Transaction is currently being processed
            return res.status(429).json({ 
                error: "Transaction is already being processed", 
                retryAfter: 5 
            });
        }
        
        // Mark this transaction as being processed (with 5 minute expiry)
        await redis.set(`tx-processing:${transactionHash}`, Date.now().toString(), 'EX', 300);
        
        // Set a rate limit for requests from this wallet (prevent DoS)
        const walletRequestCount = await redis.incr(`wallet-requests:${walletAddress}`);
        if (walletRequestCount === 1) {
            await redis.expire(`wallet-requests:${walletAddress}`, 60); // Expire after 1 minute
        }
        
        if (walletRequestCount > 10) {
            return res.status(429).json({ 
                error: "Too many payment verification requests", 
                retryAfter: 60 
            });
        }
    } catch (error) {
        console.error("Redis error in payment middleware:", error);
        // Continue even if Redis fails (fallback to blockchain verification)
    }
    
    next();
}); 