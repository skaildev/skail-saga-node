import { randomUUID } from "node:crypto";
import { demoOrders } from "./demo-orders.js";
import { money, type SimulatedServices } from "./simulated-services.js";
import type { SkailApiClient } from "./skail-api.js";
import type { Timeline } from "./timeline.js";

/** Places the demo orders for the page and starts one CloseOrder run for each. */
export class OrderDesk {
  constructor(
    private readonly services: SimulatedServices,
    private readonly skail: SkailApiClient,
    private readonly timeline: Timeline,
  ) {}

  async place(path: string): Promise<boolean> {
    const demos = path === "all" ? demoOrders : demoOrders.filter((o) => o.path === path);
    for (const demo of demos) {
      const order = this.services.placeOrder(demo.product, demo.quantity, demo.amount, demo.card, demo.expected);
      await this.skail.trigger(randomUUID(), order);
      this.timeline.add(
        order.id,
        `order placed: ${order.quantity} × ${order.product}, ${money(order.amount)}, card …${demo.card.slice(-4)}`,
        "placed",
      );
    }
    return demos.length > 0;
  }

  reset(): void {
    this.services.reset();
  }

  /** What the page shows: the stock, the orders with their result, and the timeline. */
  view() {
    const { stock, orders } = this.services.snapshot();
    const entries = this.timeline.all();
    return {
      stock: Object.entries(stock).map(([product, available]) => ({ product, available })),
      orders: orders
        .map((o) => ({
          ...o,
          result: [...entries].reverse().find((e) => e.runId === o.id && e.step?.startsWith("end:"))?.step?.slice(4),
        }))
        .reverse(),
      timeline: entries.map((e) => ({ at: e.at, order: e.runId, text: e.text })),
    };
  }
}
