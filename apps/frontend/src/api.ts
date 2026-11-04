import type { NewOrder } from "@skail-saga/contracts";

export interface PlaceOutcome {
  status: number;
  orderId?: string;
  taskId?: string;
  error?: string;
}

/** The scenario buttons call the real endpoint, like any client of the order API would. */
export async function placeOrder(order: NewOrder): Promise<PlaceOutcome> {
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(order),
  });
  const body = (await res.json().catch(() => ({}))) as Omit<PlaceOutcome, "status">;
  return { status: res.status, ...body };
}

export async function resetDemo(): Promise<void> {
  await fetch("/api/reset", { method: "POST" });
}
