import prisma from "@/lib/prisma";

/** One statement snapshots every domain that the fuzz adapters can mutate. */
export async function domainSnapshot() {
    return prisma.$queryRaw`
        SELECT jsonb_build_object(
            'users', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t),
            'customers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM customer t),
            'jornadas', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM jornada t),
            'counts', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM cash_count t),
            'sales', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sales t),
            'items', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sale_items t),
            'consumptions', (SELECT jsonb_agg(to_jsonb(t) ORDER BY "saleItemID", "supplyID") FROM sale_item_consumptions t),
            'debts', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM debtors t),
            'supplies', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM supplies t),
            'products', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM products t),
            'recipes', (SELECT jsonb_agg(to_jsonb(t) ORDER BY "productID", "supplyID") FROM recipes t),
            'expenses', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM bill t),
            'salaries', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM salary t),
            'savings', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM savings_movement t),
            'settings', (SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM setting t)
        ) AS state
    `;
}
