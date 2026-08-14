const mongoose = require("mongoose");

const shippingSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    mobile: { type: String, required: true, trim: true, maxlength: 10 },
    addressLine1: { type: String, required: true, trim: true, maxlength: 200 },
    addressLine2: { type: String, default: "", trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 80 },
    state: { type: String, required: true, trim: true, maxlength: 80 },
    pincode: { type: String, required: true, trim: true, maxlength: 6 },
    email: { type: String, default: "", trim: true, maxlength: 120 },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    shopId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
      index: true,
    },
    shopSlug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productSlug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    productName: { type: String, required: true, trim: true, maxlength: 200 },
    size: { type: String, default: null, trim: true, maxlength: 20 },
    color: { type: String, default: null, trim: true, maxlength: 80 },
    unitPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, default: 1, min: 1, max: 1 },
    shipping: { type: shippingSchema, required: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "awaiting_confirmation", "paid", "failed"],
      default: "pending",
      index: true,
    },
    paymentGateway: {
      type: String,
      enum: ["paytm", "cashfree", "razorpay", "upi_manual"],
      default: "paytm",
    },
    customerMarkedPaidAt: { type: Date, default: null },
    paytmOrderId: { type: String, default: "", trim: true, index: true },
    paytmTxnId: { type: String, default: "", trim: true },
    paytmTxnToken: { type: String, default: "", trim: true },
    cashfreeOrderId: { type: String, default: "", trim: true, index: true },
    cashfreeCfOrderId: { type: String, default: "", trim: true },
    cashfreePaymentId: { type: String, default: "", trim: true },
    razorpayOrderId: { type: String, default: "", trim: true },
    razorpayPaymentId: { type: String, default: "", trim: true },
    razorpaySignature: { type: String, default: "", trim: true },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Order", orderSchema);
