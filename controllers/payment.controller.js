import Coupon from "../models/coupon.model.js";
import Order from "../models/order.model.js";
import { stripe } from "../lib/stripe.js";
import { redis } from "../lib/redis.js";
import { web3, getPaymentProcessorContract, isBlockchainHealthy, isEventSubscriptionHealthy } from "../lib/blockchain.js";
import dotenv from "dotenv";

dotenv.config();

// Cache for transaction receipt (to avoid duplicate orders)
const transactionCache = new Map();

export const createCheckoutSession = async (req, res) => {
	try {
		const { products, couponCode } = req.body;

		if (!Array.isArray(products) || products.length === 0) {
			return res.status(400).json({ error: "Invalid or empty products array" });
		}

		let totalAmount = 0;

		const lineItems = products.map((product) => {
			const amount = Math.round(product.price * 100); // stripe wants u to send in the format of cents
			totalAmount += amount * product.quantity;

			return {
				price_data: {
					currency: "usd",
					product_data: {
						name: product.name,
						images: [product.image],
					},
					unit_amount: amount,
				},
				quantity: product.quantity || 1,
			};
		});

		let coupon = null;
		if (couponCode) {
			coupon = await Coupon.findOne({ code: couponCode, userId: req.user._id, isActive: true });
			if (coupon) {
				totalAmount -= Math.round((totalAmount * coupon.discountPercentage) / 100);
			}
		}

		const session = await stripe.checkout.sessions.create({
			payment_method_types: ["card"],
			line_items: lineItems,
			mode: "payment",
			success_url: `${process.env.CLIENT_URL}/purchase-success?session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${process.env.CLIENT_URL}/purchase-cancel`,
			discounts: coupon
				? [
						{
							coupon: await createStripeCoupon(coupon.discountPercentage),
						},
				  ]
				: [],
			metadata: {
				userId: req.user._id.toString(),
				couponCode: couponCode || "",
				products: JSON.stringify(
					products.map((p) => ({
						id: p._id,
						quantity: p.quantity,
						price: p.price,
					}))
				),
			},
		});

		if (totalAmount >= 20000) {
			await createNewCoupon(req.user._id);
		}
		res.status(200).json({ id: session.id, totalAmount: totalAmount / 100 });
	} catch (error) {
		console.error("Error processing checkout:", error);
		res.status(500).json({ message: "Error processing checkout", error: error.message });
	}
};

export const checkoutSuccess = async (req, res) => {
	try {
		const { sessionId } = req.body;
		const session = await stripe.checkout.sessions.retrieve(sessionId);

		if (session.payment_status === "paid") {
			// Check if order already exists with this sessionId
			const existingOrder = await Order.findOne({ stripeSessionId: sessionId });
			
			if (existingOrder) {
				return res.status(200).json({
					success: true,
					message: "Order already processed",
					orderId: existingOrder._id,
				});
			}
			
			if (session.metadata.couponCode) {
				await Coupon.findOneAndUpdate(
					{
						code: session.metadata.couponCode,
						userId: session.metadata.userId,
					},
					{
						isActive: false,
					}
				);
			}

			// create a new Order
			const products = JSON.parse(session.metadata.products);
			const newOrder = new Order({
				user: session.metadata.userId,
				products: products.map((product) => ({
					product: product.id,
					quantity: product.quantity,
					price: product.price,
				})),
				totalAmount: session.amount_total / 100, // convert from cents to dollars,
				stripeSessionId: sessionId,
			});

			await newOrder.save();

			res.status(200).json({
				success: true,
				message: "Payment successful, order created, and coupon deactivated if used.",
				orderId: newOrder._id,
			});
		}
	} catch (error) {
		console.error("Error processing successful checkout:", error);
		res.status(500).json({ message: "Error processing successful checkout", error: error.message });
	}
};

export const verifyCryptoPayment = async (req, res) => {
	try {
		const { products, paymentId, walletAddress, transactionHash, amount } = req.body;
		
		if (!products || !Array.isArray(products) || products.length === 0) {
			return res.status(400).json({ error: "Invalid or empty products array" });
		}
		
		if (!paymentId || !walletAddress || !transactionHash) {
			return res.status(400).json({ error: "Missing required parameters" });
		}
		
		// Check if this transaction was already processed (prevent double-spending)
		const cachedTransaction = await redis.get(`tx:${transactionHash}`);
		if (cachedTransaction) {
			return res.status(400).json({ error: "Transaction already processed" });
		}
		
		// First check if blockchain is available
		const isHealthy = await isBlockchainHealthy();
		if (!isHealthy) {
			return res.status(503).json({ 
				error: "Blockchain services temporarily unavailable",
				retryAfter: 60,
				retryable: true
			});
		}
		
		// Verify the transaction on the blockchain
		try {
			const receipt = await web3.eth.getTransactionReceipt(transactionHash);
			if (!receipt || !receipt.status) {
				return res.status(400).json({ error: "Invalid transaction or transaction failed" });
			}
			
			// Get contract instance
			const contract = await getPaymentProcessorContract();
			
			if (!contract) {
				return res.status(503).json({ 
					error: "Blockchain services temporarily unavailable",
					retryAfter: 60,
					retryable: true
				});
			}
			
			// Verify payment using the contract
			try {
				const paymentStatus = await contract.methods.getPaymentStatus(paymentId).call();
				if (!paymentStatus) {
					return res.status(400).json({ error: "Payment not found or not processed on blockchain" });
				}
			} catch (contractError) {
				console.error("Contract call error:", contractError.message || contractError);
				return res.status(500).json({ 
					error: "Error verifying payment status on blockchain",
					retryable: true
				});
			}
			
			// Get transaction details for additional verification
			const transaction = await web3.eth.getTransaction(transactionHash);
			if (!transaction || transaction.to.toLowerCase() !== contract.options.address.toLowerCase()) {
				return res.status(400).json({ error: "Transaction not sent to payment processor contract" });
			}
			
			// At this point, the payment verification is successful
			
			// Create an order in the database
			const order = new Order({
				products: products.map(product => ({
					productId: product._id,
					name: product.name,
					price: product.price,
					quantity: product.quantity
				})),
				paymentMethod: 'crypto',
				paymentId: paymentId,
				transactionHash: transactionHash,
				walletAddress: walletAddress,
				amount: amount,
				user: req.user ? req.user._id : null,
				status: 'completed'
			});
			
			await order.save();
			
			// Store transaction hash in Redis to prevent double processing
			await redis.set(`tx:${transactionHash}`, JSON.stringify({
				orderId: order._id.toString(),
				timestamp: Date.now()
			}), 'EX', 60 * 60 * 24 * 7); // Store for 7 days
			
			return res.status(200).json({
				success: true,
				order: {
					id: order._id,
					amount,
					status: 'completed',
					paymentMethod: 'crypto'
				}
			});
		} catch (blockchainError) {
			console.error('Blockchain verification error:', blockchainError.message || blockchainError);
			return res.status(500).json({
				error: "Error verifying blockchain transaction",
				retryable: true,
				details: blockchainError.message
			});
		}
	} catch (error) {
		console.error('Crypto payment verification error:', error.message || error);
		return res.status(500).json({
			error: 'An error occurred while verifying crypto payment',
			details: error.message
		});
	}
};

// Set up blockchain event listeners with better error handling
const setupBlockchainEventListeners = async () => {
	try {
		const isHealthy = await isEventSubscriptionHealthy();
		if (!isHealthy) {
			console.warn("Blockchain WebSocket connection not available, skipping event listener setup");
			return;
		}
		
		// Get a contract instance specifically for events using WebSocket provider
		const contract = await getPaymentProcessorContract(true);
		
		if (!contract) {
			console.warn("Skipping event listener setup - contract not initialized");
			return;
		}
		
		// Make sure the events property exists before accessing it
		if (!contract.events || typeof contract.events.PaymentProcessed !== 'function') {
			console.error("Contract events API not available");
			return;
		}
		
		// Listen for PaymentProcessed events with better error handling
		try {
			// First create the event subscription
			const subscription = contract.events.PaymentProcessed({});
			
			// Check if subscription is valid before adding listeners
			if (!subscription) {
				console.error("Failed to create event subscription - returned undefined");
				return;
			}
			
			// Add event handlers separately to better handle errors
			subscription.on('data', async (event) => {
				try {
					const { payer, amount, paymentId, date, tokenAddress } = event.returnValues;
					
					console.log(`Payment processed on blockchain: ${paymentId}`);
					
					// Store event in Redis for later verification
					await redis.set(`payment:${paymentId}`, JSON.stringify({
						payer,
						amount: amount.toString(),
						date: date.toString(),
						tokenAddress,
						blockNumber: event.blockNumber,
						transactionHash: event.transactionHash
					}), 'EX', 60 * 60 * 24 * 3); // Store for 3 days
				} catch (dataError) {
					console.error('Error processing payment event data:', dataError.message || dataError);
				}
			});
			
			subscription.on('error', (error) => {
				console.error('Error in payment event listener:', error.message || error);
			});
			
			// Also handle connected event to confirm subscription is working
			subscription.on('connected', (subscriptionId) => {
				console.log(`Payment event listener connected with ID: ${subscriptionId}`);
			});
			
			console.log("Blockchain event listeners set up successfully");
		} catch (subscriptionError) {
			console.error('Failed to subscribe to blockchain events:', subscriptionError.message || subscriptionError);
		}
	} catch (error) {
		console.error('Failed to setup blockchain event listeners:', error.message || error);
	}
};

// Initialize event listeners with a better retry mechanism
let retryCount = 0;
const maxRetries = 3;
const retryDelay = 10000; // 10 seconds between retries

const initializeEventListeners = () => {
	setupBlockchainEventListeners().catch(error => {
		console.error('Blockchain event listener setup failed:', error.message || error);
		if (retryCount < maxRetries) {
			retryCount++;
			console.log(`Retrying blockchain event listener setup (${retryCount}/${maxRetries}) in ${retryDelay/1000} seconds...`);
			setTimeout(initializeEventListeners, retryDelay);
		} else {
			console.warn('Maximum retries exceeded for blockchain event listeners. Blockchain event functionality will be limited.');
		}
	});
};

// Start the initialization with an initial delay to allow system to fully start
setTimeout(initializeEventListeners, 5000);

export const processPayment = async (req, res) => {
	try {
		const { paymentMethodId, amount, currency = 'usd' } = req.body;

		// Validate required fields
		if (!paymentMethodId) {
			return res.status(400).json({ error: "Payment method ID is required" });
		}

		// Validate amount
		if (!amount || isNaN(amount) || amount <= 0) {
			return res.status(400).json({ error: "Invalid amount provided" });
		}

		// Calculate amount in cents
		const amountInCents = Math.round(amount * 100);

		try {
			// Create a payment intent
			const paymentIntent = await stripe.paymentIntents.create({
				amount: amountInCents,
				currency,
				payment_method: paymentMethodId,
				confirmation_method: 'manual',
				confirm: true,
				return_url: `${req.headers.origin}/checkout-success`, // Add return URL for 3D Secure
				automatic_payment_methods: {
					enabled: true,
					allow_redirects: 'always'
				}
			});

			// Handle different payment intent statuses
			switch (paymentIntent.status) {
				case 'succeeded':
					return res.json({
						success: true,
						clientSecret: paymentIntent.client_secret,
						status: paymentIntent.status
					});
				case 'requires_action':
					return res.json({
						requiresAction: true,
						clientSecret: paymentIntent.client_secret,
						status: paymentIntent.status
					});
				default:
					return res.json({
						error: 'Invalid PaymentIntent status',
						status: paymentIntent.status
					});
			}
		} catch (stripeError) {
			console.error('Stripe API error:', stripeError);
			return res.status(400).json({
				error: stripeError.message,
				code: stripeError.code
			});
		}
	} catch (error) {
		console.error('Payment processing error:', error);
		return res.status(500).json({
			error: 'An error occurred while processing your payment',
			details: error.message
		});
	}
};

async function createStripeCoupon(discountPercentage) {
	const coupon = await stripe.coupons.create({
		percent_off: discountPercentage,
		duration: "once",
	});

	return coupon.id;
}

async function createNewCoupon(userId) {
	await Coupon.findOneAndDelete({ userId });

	const newCoupon = new Coupon({
		code: "GIFT" + Math.random().toString(36).substring(2, 8).toUpperCase(),
		discountPercentage: 10,
		expirationDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
		userId: userId,
	});

	await newCoupon.save();

	return newCoupon;
}
