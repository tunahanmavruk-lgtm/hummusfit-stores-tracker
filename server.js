const express = require("express");
const path = require("path");

const app = express();
const PORT = 3000;

const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. myhummusfit.myshopify.com
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API_VERSION = "2025-01";

async function shopifyGraphQL(query, variables) {
  if (!SHOP_DOMAIN || !ACCESS_TOKEN) {
    throw new Error(
      "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN env vars"
    );
  }
  const res = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await res.json();
  if (!res.ok || data.errors) {
    throw new Error(
      `Shopify API error (${res.status}): ${JSON.stringify(data.errors || data)}`
    );
  }
  return data.data;
}


// Get all active locations (physical stores)
async function getLocations() {
  const query = `
    query {
      locations(first: 50) {
        edges {
          node {
            id
            name
            isActive
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query);
  return data.locations.edges
    .map((e) => e.node)
    .filter((loc) => loc.isActive)
    .filter((loc) => {
      const n = loc.name.toLowerCase();
      return (
        !n.includes("fulfillment kitchen") &&
        !n.includes("shipping") &&
        !n.includes("warehouse")
      );
    });
}

// Compute the real UTC instant corresponding to midnight in America/New_York
// (handles EST/EDT automatically). This is independent of whatever timezone
// the server itself happens to run in — Railway containers default to UTC.
function getStartOfDayEastern(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(now).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = parseInt(parts.hour, 10) % 24; // "24" means midnight in some locales
  const msSinceMidnightEastern =
    (hour * 3600 + parseInt(parts.minute, 10) * 60 + parseInt(parts.second, 10)) *
      1000 +
    now.getMilliseconds();
  return new Date(now.getTime() - msSinceMidnightEastern);
}

// Get today's orders (paginated) with their location + total price
async function getTodaysOrders() {
  const now = new Date();
  const startOfDay = getStartOfDayEastern(now);
  const isoStart = startOfDay.toISOString();

  let orders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query($cursor: String, $queryString: String!) {
        orders(first: 100, after: $cursor, query: $queryString) {
          edges {
            cursor
            node {
              id
              currentTotalPriceSet {
                shopMoney {
                  amount
                }
              }
              physicalLocation {
                id
                name
              }
              sourceName
              customer {
                tags
              }
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `;
    const data = await shopifyGraphQL(query, {
      cursor,
      queryString: `created_at:>='${isoStart}' status:any -status:cancelled`,
    });
    const edges = data.orders.edges;
    orders = orders.concat(edges.map((e) => e.node));
    hasNextPage = data.orders.pageInfo.hasNextPage;
    cursor = edges.length ? edges[edges.length - 1].cursor : null;
    if (!edges.length) break;
  }

  return orders;
}

app.get("/api/store-sales", async (req, res) => {
  try {
    const [locations, orders] = await Promise.all([
      getLocations(),
      getTodaysOrders(),
    ]);

    // Seed every active location at $0 so stores with no sales yet still show
    const totals = {};
    locations.forEach((loc) => {
      totals[loc.name] = { name: loc.name, sales: 0, orders: 0, isOnline: false };
    });
    totals["Online"] = { name: "Online", sales: 0, orders: 0, isOnline: true };
    totals["Wholesale"] = { name: "Wholesale", sales: 0, orders: 0, isOnline: true, isWholesale: true };

    orders.forEach((order) => {
      const amount = parseFloat(
        order.currentTotalPriceSet?.shopMoney?.amount || "0"
      );
      const locName = order.physicalLocation?.name;
      const customerTags = (order.customer?.tags || []).map((t) => t.toLowerCase());
      const isWholesale = !locName && customerTags.includes("wholesale");
      const bucket = locName
        ? (totals[locName] || totals["Online"])
        : isWholesale
        ? totals["Wholesale"]
        : totals["Online"];
      bucket.sales += amount;
      bucket.orders += 1;
    });

    const result = Object.values(totals).sort((a, b) => b.sales - a.sales);
    res.json({ updatedAt: new Date().toISOString(), stores: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/status", (req, res) => {
  res.json({ configured: Boolean(SHOP_DOMAIN && ACCESS_TOKEN) });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stores tracker running on port ${PORT}`);
});
