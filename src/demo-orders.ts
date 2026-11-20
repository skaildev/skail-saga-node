import { SagaResults } from "./model.js";

/** One order per path of the saga, set up for the rules of the simulated services. */
export interface DemoOrder {
  path: string;
  product: string;
  quantity: number;
  amount: number;
  card: string;
  expected: string;
}

export const demoOrders: readonly DemoOrder[] = [
  {
    path: "confirmed",
    product: "Monitor",
    quantity: 1,
    amount: 1200,
    card: "4111111111111111",
    expected: SagaResults.confirmed,
  },
  {
    path: "declined",
    product: "Monitor",
    quantity: 1,
    amount: 1200,
    card: "4000000000000002",
    expected: SagaResults.paymentDeclined,
  },
  {
    path: "invoice",
    product: "Cabo HDMI",
    quantity: 2,
    amount: 80,
    card: "4111111111111111",
    expected: SagaResults.cancelledWithRefund,
  },
  {
    path: "stock",
    product: "Monitor",
    quantity: 6,
    amount: 7200,
    card: "4111111111111111",
    expected: SagaResults.outOfStock,
  },
];
