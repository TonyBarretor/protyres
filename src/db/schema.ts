import { boolean, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const prices = pgTable("prices", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull().default("provider"),
  code: text("code"),
  description: text("description").notNull().default(""),
  brand: text("brand").notNull().default(""),
  model: text("model").notNull().default(""),
  size: text("size").notNull().default(""),
  sizeDisplay: text("size_display").notNull().default(""),
  sizeRaw: text("size_raw").notNull().default(""),
  isTyre: boolean("is_tyre").notNull().default(true),
  loadIndex: text("load_index"),
  speedIndex: text("speed_index"),
  ply: integer("ply"),
  position: text("position"),
  tube: text("tube"),
  cost: numeric("cost", { precision: 12, scale: 2 }),
  priceIncludesTax: boolean("price_includes_tax").notNull().default(false),
  maxDiscountPct: numeric("max_discount_pct", { precision: 5, scale: 2 }),
  currency: text("currency").notNull().default("USD"),
  stock: integer("stock"),
  priceDate: text("price_date").notNull(),
  source: text("source").notNull(),
  sourceRef: text("source_ref").notNull().default(""),
  notes: text("notes"),
  photoUrl: text("photo_url"),
  sheetUrl: text("sheet_url"),
  raw: text("raw"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Product photos keyed by brand+model (from provider catalogues, WhatsApp uploads or approved web results). */
export const photos = pgTable("photos", {
  key: text("key").primaryKey(),
  brand: text("brand").notNull().default(""),
  model: text("model").notNull().default(""),
  url: text("url"),
  /** base64 image bytes when the photo was uploaded (WhatsApp). */
  data: text("data"),
  mimeType: text("mime_type"),
  sheetUrl: text("sheet_url"),
  /** base64 bytes of the technical sheet image, when downloaded. */
  sheetData: text("sheet_data"),
  source: text("source").notNull().default("manual"),
  /** provider / web site the photo came from ("JCH", "Steel", "jchllantas.com.pe"). */
  origin: text("origin"),
  /** provider SKU the photo was matched by, when any. */
  code: text("code"),
  addedBy: text("added_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const quotes = pgTable("quotes", {
  number: text("number").primaryKey(),
  status: text("status").notNull().default("draft"),
  customerEmail: text("customer_email"),
  total: numeric("total", { precision: 12, scale: 2 }),
  currency: text("currency"),
  requestedBy: text("requested_by"),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export const conversations = pgTable("conversations", {
  phone: text("phone").primaryKey(),
  state: jsonb("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const counters = pgTable("counters", {
  name: text("name").primaryKey(),
  value: integer("value").notNull().default(0),
});

export const processedMessages = pgTable("processed_messages", {
  id: text("id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const syncMarks = pgTable("sync_marks", {
  fileId: text("file_id").primaryKey(),
  modifiedTime: text("modified_time").notNull(),
  ok: boolean("ok").notNull().default(true),
});

export const _pk = primaryKey;
