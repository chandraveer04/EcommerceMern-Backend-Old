import express from "express";
import { protectedRoute } from "../middleware/auth.middleware.js";
import { createCheckoutSession, checkoutSuccess, processPayment, verifyCryptoPayment } from "../controllers/payment.controller.js";
import { validateCryptoPayment } from "../middleware/payment.middleware.js";

const router = express.Router();

// Original Stripe routes
router.post('/create-checkout-session', protectedRoute, createCheckoutSession);
router.post('/checkout-success', protectedRoute, checkoutSuccess);

// New direct payment route
router.post('/process-payment', protectedRoute, processPayment);

// Crypto payment verification
router.post('/verify-crypto-payment', protectedRoute, validateCryptoPayment, verifyCryptoPayment);

export default router;
