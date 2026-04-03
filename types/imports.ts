// types/imports.ts
// TypeScript interfaces for the imports and import_items tables,
// and the restock calendar payload from /api/restock.

export type ImportStatus = 'ordered' | 'in_transit' | 'arrived' | 'cancelled';

export interface ImportItem {
  id: string;
  import_id: string;
  sku: string;
  product_name: string;
  quantity_ordered: number;
  unit_cost: number | null;
  currency: string;
}

export interface Import {
  id: string;
  created_at: string;           // ISO 8601 timestamp
  order_date: string;           // YYYY-MM-DD
  estimated_arrival_date: string; // YYYY-MM-DD  (order_date + 75 days by default)
  actual_arrival_date: string | null; // YYYY-MM-DD when arrived
  status: ImportStatus;
  notes: string | null;
  total_items: number;
  import_items?: ImportItem[];  // included when fetched with select('*, import_items(*)')
}

// Payload returned by GET /api/restock
export interface RestockProduct {
  sku: string;
  nombre: string;
  categoria: string;
  stock: number;
  total_sold_30d: number;       // units sold across ALL channels in last 30 days
  daily_velocity: number;       // total_sold_30d / 30
  days_coverage: number | null; // stock / daily_velocity  (null if velocity = 0)
  restock_date: string | null;  // YYYY-MM-DD: last day to place order (today + days_coverage - 75)
  stockout_date: string | null; // YYYY-MM-DD: day stock hits zero (today + days_coverage)
  already_ordered: boolean;     // true if SKU is in a non-arrived, non-cancelled import
  today: string;                // YYYY-MM-DD: server-side today for reference
}
