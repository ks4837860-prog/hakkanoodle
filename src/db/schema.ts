import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import type { ExtractionPayload } from "@/lib/types";

export const extractions = pgTable("extractions", {
  id: serial("id").primaryKey(),
  url: text("url").notNull(),
  title: text("title").notNull().default("Untitled PDF"),
  pageCount: integer("page_count").notNull().default(0),
  itemCount: integer("item_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  payload: jsonb("payload").$type<ExtractionPayload>().notNull(),
});

export type ExtractionRow = typeof extractions.$inferSelect;