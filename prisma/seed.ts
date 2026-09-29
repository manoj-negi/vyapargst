import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("password123", 10);

  const user = await prisma.user.upsert({
    where: { email: "admin@billeasy.in" },
    create: { email: "admin@billeasy.in", passwordHash, name: "Rohan Mehta" },
    update: {},
  });

  let business = await prisma.business.findFirst({ where: { ownerId: user.id } });
  if (!business) {
    business = await prisma.business.create({
      data: {
        ownerId: user.id,
        name: "Mehta Stationery Mart",
        tradeName: "Mehta Stationers",
        gstin: "07AAACM1234F1Z5",
        pan: "AAACM1234F",
        businessType: "Retailer",
        phone: "9876543210",
        email: "contact@mehtastationers.in",
        address: "12, Nehru Market",
        city: "New Delhi",
        state: "Delhi",
        pincode: "110006",
        country: "India",
        gstRegistered: true,
        settings: { create: { invoicePrefix: "INV-", invoiceStartNumber: 1, roundOffMode: "AUTOMATIC", negativeStockPolicy: "ALLOW_WITH_WARNING" } },
      },
    });
  }

  const taxRates = [0, 5, 12, 18, 28];
  const taxByRate = new Map<number, string>();
  for (const rate of taxRates) {
    const tax = await prisma.taxMaster.upsert({
      where: { businessId_rate: { businessId: business.id, rate } },
      create: {
        businessId: business.id,
        name: `GST ${rate}%`,
        rate,
        cgstRate: rate / 2,
        sgstRate: rate / 2,
        igstRate: rate,
      },
      update: {},
    });
    taxByRate.set(rate, tax.id);
  }

  // HSN codes come from the shared stationery dataset (migration 20260929140000_seed_stationery_hsn).

  const unitNames = [
    { name: "Piece", shortName: "Pcs" },
    { name: "Box", shortName: "Box" },
    { name: "Pack", shortName: "Pack" },
    { name: "Dozen", shortName: "Dz" },
    { name: "Ream", shortName: "Ream" },
  ];
  const unitByName = new Map<string, string>();
  for (const u of unitNames) {
    const unit = await prisma.unit.upsert({
      where: { businessId_name: { businessId: business.id, name: u.name } },
      create: { businessId: business.id, name: u.name, shortName: u.shortName },
      update: {},
    });
    unitByName.set(u.name, unit.id);
  }

  const categoryNames = ["Paper", "Writing Instruments", "Notebooks", "Office Supplies", "Stationery Accessories"];
  const categoryByName = new Map<string, string>();
  for (const name of categoryNames) {
    const category = await prisma.category.upsert({
      where: { businessId_name: { businessId: business.id, name } },
      create: { businessId: business.id, name },
      update: {},
    });
    categoryByName.set(name, category.id);
  }

  interface DemoProduct {
    name: string;
    hsnCode: string;
    category: string;
    unit: string;
    salePrice: number;
    purchasePrice: number;
    gstRate: number;
    openingStock: number;
    minStock: number;
    defaultDiscount?: number;
  }

  const demoProducts: DemoProduct[] = [
    { name: "A4 Ream Century Plus - High Bright 75 GSM", hsnCode: "48025690", category: "Paper", unit: "Ream", salePrice: 320, purchasePrice: 260, gstRate: 18, openingStock: 150, minStock: 20, defaultDiscount: 5 },
    { name: "A4 Ream Satia - High Bright 75 GSM", hsnCode: "48025690", category: "Paper", unit: "Ream", salePrice: 305, purchasePrice: 245, gstRate: 18, openingStock: 120, minStock: 20 },
    { name: "Apsara Platinum Pencils", hsnCode: "96091000", category: "Writing Instruments", unit: "Box", salePrice: 60, purchasePrice: 42, gstRate: 12, openingStock: 80, minStock: 10 },
    { name: "Ball Pen", hsnCode: "96081010", category: "Writing Instruments", unit: "Box", salePrice: 90, purchasePrice: 65, gstRate: 18, openingStock: 200, minStock: 25 },
    { name: "Binder Clip 25MM", hsnCode: "83051000", category: "Office Supplies", unit: "Box", salePrice: 45, purchasePrice: 30, gstRate: 18, openingStock: 60, minStock: 10 },
    { name: "Binder Clip 41MM", hsnCode: "83051000", category: "Office Supplies", unit: "Box", salePrice: 65, purchasePrice: 44, gstRate: 18, openingStock: 55, minStock: 10 },
    { name: "Binder Clip 51MM", hsnCode: "83051000", category: "Office Supplies", unit: "Box", salePrice: 85, purchasePrice: 58, gstRate: 18, openingStock: 40, minStock: 8 },
    { name: "Camlin Lead Pencil", hsnCode: "96091000", category: "Writing Instruments", unit: "Box", salePrice: 55, purchasePrice: 38, gstRate: 12, openingStock: 90, minStock: 15 },
    { name: "Captain Tape 1 inch", hsnCode: "39191010", category: "Office Supplies", unit: "Piece", salePrice: 22, purchasePrice: 14, gstRate: 18, openingStock: 130, minStock: 20 },
    { name: "Carbon Paper", hsnCode: "48202090", category: "Paper", unit: "Pack", salePrice: 75, purchasePrice: 52, gstRate: 18, openingStock: 45, minStock: 10 },
    { name: "CD Marker Pen", hsnCode: "96082000", category: "Writing Instruments", unit: "Piece", salePrice: 30, purchasePrice: 19, gstRate: 18, openingStock: 70, minStock: 15 },
    { name: "Citizen Note Pad No 33", hsnCode: "48202000", category: "Notebooks", unit: "Piece", salePrice: 35, purchasePrice: 23, gstRate: 12, openingStock: 100, minStock: 20 },
    { name: "Cobra File 650", hsnCode: "39269080", category: "Office Supplies", unit: "Piece", salePrice: 48, purchasePrice: 32, gstRate: 18, openingStock: 65, minStock: 10 },
    { name: "Cobra File Steel", hsnCode: "39269080", category: "Office Supplies", unit: "Piece", salePrice: 65, purchasePrice: 45, gstRate: 18, openingStock: 50, minStock: 10 },
    { name: "Correction Pen", hsnCode: "39269080", category: "Writing Instruments", unit: "Piece", salePrice: 40, purchasePrice: 27, gstRate: 18, openingStock: 85, minStock: 15 },
    { name: "DOMS Ball Pen", hsnCode: "96081010", category: "Writing Instruments", unit: "Box", salePrice: 80, purchasePrice: 56, gstRate: 18, openingStock: 110, minStock: 20 },
    { name: "DOMS Eraser", hsnCode: "40169990", category: "Writing Instruments", unit: "Box", salePrice: 25, purchasePrice: 16, gstRate: 12, openingStock: 140, minStock: 20 },
    { name: "DOMS Lead Pencil", hsnCode: "96091000", category: "Writing Instruments", unit: "Box", salePrice: 50, purchasePrice: 34, gstRate: 12, openingStock: 95, minStock: 15 },
    { name: "DOMS Sharpener", hsnCode: "82142010", category: "Writing Instruments", unit: "Box", salePrice: 28, purchasePrice: 18, gstRate: 18, openingStock: 75, minStock: 15 },
    { name: "Drawing Kit", hsnCode: "96099090", category: "Stationery Accessories", unit: "Piece", salePrice: 120, purchasePrice: 85, gstRate: 12, openingStock: 40, minStock: 8 },
    { name: "Elkos Ball Pen", hsnCode: "96081010", category: "Writing Instruments", unit: "Box", salePrice: 70, purchasePrice: 48, gstRate: 18, openingStock: 60, minStock: 12 },
    { name: "Notebook", hsnCode: "48202000", category: "Notebooks", unit: "Piece", salePrice: 45, purchasePrice: 30, gstRate: 12, openingStock: 8, minStock: 20 },
    { name: "Stapler", hsnCode: "39269080", category: "Office Supplies", unit: "Piece", salePrice: 110, purchasePrice: 78, gstRate: 18, openingStock: 35, minStock: 8 },
    { name: "Paper Clips", hsnCode: "83051000", category: "Office Supplies", unit: "Pack", salePrice: 20, purchasePrice: 12, gstRate: 18, openingStock: 0, minStock: 15 },
    { name: "Whiteboard Marker", hsnCode: "96082000", category: "Writing Instruments", unit: "Box", salePrice: 95, purchasePrice: 66, gstRate: 18, openingStock: 55, minStock: 10 },
  ];

  for (const p of demoProducts) {
    const existing = await prisma.product.findFirst({ where: { businessId: business.id, name: p.name } });
    if (existing) continue;

    await prisma.product.create({
      data: {
        businessId: business.id,
        name: p.name,
        hsnCode: p.hsnCode,
        categoryId: categoryByName.get(p.category)!,
        unitId: unitByName.get(p.unit)!,
        salePrice: p.salePrice,
        purchasePrice: p.purchasePrice,
        priceType: "EXCLUSIVE",
        taxId: taxByRate.get(p.gstRate)!,
        defaultDiscount: p.defaultDiscount ?? 0,
        defaultDiscountType: "PERCENTAGE",
        openingStock: p.openingStock,
        minStock: p.minStock,
        currentStock: p.openingStock,
      },
    });
  }

  const demoCustomers = [
    { name: "Canara Bank", phone: "9811122233", state: "Delhi", customerType: "REGISTERED" as const, gstin: "07AAACC1234A1Z1", billingAddress: "Connaught Place Branch, New Delhi" },
    { name: "ABC Traders", phone: "9822233344", state: "Haryana", customerType: "REGISTERED" as const, gstin: "06AABCA5678B1Z2", billingAddress: "Industrial Area, Gurugram" },
    { name: "XYZ Enterprises", phone: "9833344455", state: "Delhi", customerType: "UNREGISTERED" as const, billingAddress: "Karol Bagh, New Delhi" },
    { name: "Walk-in Customer", phone: "", state: "Delhi", customerType: "CONSUMER" as const, billingAddress: "" },
  ];

  for (const c of demoCustomers) {
    const existing = await prisma.customer.findFirst({ where: { businessId: business.id, name: c.name } });
    if (!existing) {
      await prisma.customer.create({ data: { businessId: business.id, ...c } });
    }
  }

  console.log("Seed complete.");
  console.log("Login with: admin@billeasy.in / password123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
