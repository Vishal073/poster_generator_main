/**
 * Seed a demo shop + products for local /shop/:shopSlug routes.
 * Usage: node my-backend/scripts/seedShop.js
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const Shop = require("../models/Shop");
const Product = require("../models/Product");

const DEMO_SHOP = {
  name: "GCR Readywear",
  slug: "gcr-readywear",
  description: "Premium ready-to-wear collection by GCR Graphix.",
  isActive: true,
};

const DEMO_PRODUCTS = [
  {
    productId: "classic-kurta",
    name: "Classic Kurta",
    description:
      "Comfortable cotton kurta for daily wear. Soft fabric, regular fit. Machine wash friendly.",
    images: [
      "https://images.unsplash.com/photo-1594938298603-c8148c4dae35?w=800&q=80",
    ],
    category: "readywear",
    sizes: ["S", "M", "L", "XL"],
    price: 1299,
    stockBySize: { S: 5, M: 8, L: 6, XL: 3 },
    isActive: true,
  },
  {
    productId: "party-suit",
    name: "Party Suit Set",
    description:
      "Elegant party wear suit set with premium finish. Perfect for festivals and celebrations.",
    images: [
      "https://images.unsplash.com/photo-1507679799987-c73779587ccf?w=800&q=80",
    ],
    category: "readywear",
    sizes: ["M", "L", "XL"],
    price: 2499,
    stockBySize: { M: 4, L: 5, XL: 2 },
    isActive: true,
  },
  {
    productId: "designer-poster-frame",
    name: "Designer Poster Frame",
    description: "Premium wall frame for shop posters. No size required.",
    images: [
      "https://images.unsplash.com/photo-1513519245088-0e12902e5a38?w=800&q=80",
    ],
    category: "other",
    sizes: [],
    price: 899,
    stock: 20,
    isActive: true,
  },
];

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not set");
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  let shop = await Shop.findOne({ slug: DEMO_SHOP.slug });
  if (!shop) {
    shop = await Shop.create(DEMO_SHOP);
    console.log("Created shop:", shop.slug);
  } else {
    await Shop.updateOne({ _id: shop._id }, { $set: DEMO_SHOP });
    console.log("Updated shop:", shop.slug);
  }

  for (const item of DEMO_PRODUCTS) {
    const payload = {
      ...item,
      shopId: shop._id,
      shopSlug: shop.slug,
    };

    if (item.stockBySize) {
      payload.stockBySize = new Map(Object.entries(item.stockBySize));
    }

    await Product.findOneAndUpdate(
      { shopSlug: shop.slug, productId: item.productId },
      { $set: payload },
      { upsert: true, new: true },
    );
    console.log("Upserted product:", item.productId);
  }

  console.log("\nShop URL paths:");
  console.log(`  /shop/${shop.slug}`);
  console.log(`  /shop/${shop.slug}/classic-kurta`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
