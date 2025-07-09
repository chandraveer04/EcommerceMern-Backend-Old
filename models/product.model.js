import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
	{
		name: {
			type: String,
			required: true,
		},
		description: {
			type: String,
			required: false,
			default: ""
		},
		price: {
			type: Number,
			min: 0,
			required: true,
		},
		image: {
			type: String,
			required: false,
			default: ""
		},
		category: {
			type: String,
			required: true,
		},
		isFeatured: {
			type: Boolean,
			default: false,
		},
	},
	{ timestamps: true }
);

const Product = mongoose.model("Product", productSchema);

export default Product;
