import express from "express";
import dotenv from "dotenv";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import { isBlockchainHealthy } from "./lib/blockchain.js";
import { isRedisHealthy } from "./lib/redis.js";
import path from "path";

import authRoutes from "./routes/auth.route.js";
import productRoutes from "./routes/product.route.js";
import cartRoutes from "./routes/cart.route.js";
import couponRoutes from "./routes/coupon.route.js";
import paymentRoutes from "./routes/payment.route.js";
import analyticsRoutes from "./routes/analytics.route.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const __dirname = path.resolve();

app.use(express.json({ limit: "10mb" })); // allows you to parse the body of the request
app.use(cookieParser());

app.use((req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", process.env.CLIENT_URL);
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
	res.setHeader("Access-Control-Allow-Credentials", "true");
	next();
});

app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/analytics", analyticsRoutes);

// Health check endpoint
app.get("/api/health", async (req, res) => {
	const blockchainStatus = await isBlockchainHealthy();
	const redisStatus = await isRedisHealthy();
	
	res.json({
		status: "up",
		database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
		blockchain: blockchainStatus ? "connected" : "disconnected",
		redis: redisStatus ? "connected" : "disconnected"
	});
});

// Error handling middleware
app.use((err, req, res, next) => {
	console.error(err.stack);
	res.status(500).json({ message: "An unexpected error occurred", error: err.message });
});

if (process.env.NODE_ENV === "production") {
	app.use(express.static(path.join(__dirname, "/frontend/dist")));

	app.get("*", (req, res) => {
		res.sendFile(path.resolve(__dirname, "frontend", "dist", "index.html"));
	});
}

mongoose.connect(process.env.MONGO_URI)
	.then(() => {
		console.log("Connected to MongoDB");
		
		app.listen(PORT, async () => {
			console.log(`Server is running on http://localhost:${PORT}`);
			
			// Check service health
			try {
				const blockchainHealth = await isBlockchainHealthy();
				if (blockchainHealth) {
					console.log("🟢 Blockchain connection successful");
				} else {
					console.warn("🟠 Blockchain connection unavailable - some features will be disabled");
				}
				
				const redisHealth = await isRedisHealthy();
				if (redisHealth) {
					console.log("🟢 Redis connection successful");
				} else {
					console.warn("🟠 Redis connection unavailable - some features will be degraded");
				}
			} catch (error) {
				console.error("Error checking service health:", error);
			}
		});
	})
	.catch((err) => {
		console.error("MongoDB connection error:", err);
		process.exit(1);
	});
