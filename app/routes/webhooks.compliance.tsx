import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} compliance webhook for ${shop}`);

  const normalizedTopic = String(topic).toUpperCase();

  switch (normalizedTopic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS/DATA_REQUEST": {
      // CadenceB2B does not store personal customer PII beyond Shopify B2B GIDs.
      break;
    }

    case "CUSTOMERS_REDACT":
    case "CUSTOMERS/REDACT": {
      // No personal customer PII stored to redact.
      break;
    }

    case "SHOP_REDACT":
    case "SHOP/REDACT": {
      // Remove all merchant data associated with this shop (schedules cascade to line items and logs).
      await prisma.$transaction([
        prisma.executionLog.deleteMany({ where: { shop } }),
        prisma.recurringSchedule.deleteMany({ where: { shop } }),
        prisma.shopSettings.deleteMany({ where: { shop } }),
        prisma.session.deleteMany({ where: { shop } }),
      ]);
      break;
    }

    default: {
      console.warn(`Unhandled compliance webhook topic: ${topic} for ${shop}`);
      break;
    }
  }

  return new Response(null, { status: 200 });
};
