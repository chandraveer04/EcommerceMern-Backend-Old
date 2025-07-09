import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

// Initialize Stripe with the secret key
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
    throw new Error("Missing Stripe secret key in environment variables");
}

export const stripe = new Stripe(stripeSecretKey, {
    apiVersion: "2023-10-16" // Use the latest stable API version
});
