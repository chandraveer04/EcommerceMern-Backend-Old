import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
	{
		user: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "User",
			required: true,
		},
		products: [
			{
				product: {
					type: mongoose.Schema.Types.ObjectId,
					ref: "Product",
					required: true,
				},
				quantity: {
					type: Number,
					required: true,
					min: 1,
				},
				price: {
					type: Number,
					required: true,
				},
			},
		],
		totalAmount: {
			type: Number,
			required: true,
		},
		status: {
			type: String,
			enum: ["pending", "processing", "shipped", "delivered", "cancelled"],
			default: "pending",
		},
		stripeSessionId: {
			type: String,
		},
		paymentMethod: {
			type: String,
			enum: ["stripe", "crypto"],
			default: "stripe"
		},
		paymentId: {
			type: String,
		},
		transactionHash: {
			type: String,
		},
		walletAddress: {
			type: String,
		},
		tokenAddress: {
			type: String,
			default: null, // null means native ETH, otherwise ERC-20 token address
		},
		deliveryAddress: {
			type: String,
		},
		trackingNumber: {
			type: String,
		}
	},
	{ timestamps: true }
);

const Order = mongoose.model("Order", orderSchema);

export default Order;
