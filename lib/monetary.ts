const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const MILLIUNITS_PER_UNIT = BigInt(1000);

/** Rounds an exact fraction to the nearest integer, with ties going to the even integer. */
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
    if (denominator <= ZERO) throw new RangeError("Denominator must be positive");

    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const twiceRemainder = TWO * (remainder < ZERO ? -remainder : remainder);
    if (twiceRemainder < denominator || (twiceRemainder === denominator && quotient % TWO === ZERO)) {
        return quotient;
    }
    return quotient + (numerator < ZERO ? -ONE : ONE);
}

export function recipeCostCents(ingredients: ReadonlyArray<{
    unitCost: bigint | number | null | undefined;
    quantityUsed: bigint | number | null | undefined;
}>): bigint {
    const numerator = ingredients.reduce(
        (cost, ingredient) => cost + BigInt(ingredient.unitCost ?? ZERO) * BigInt(ingredient.quantityUsed ?? ZERO),
        ZERO,
    );
    return roundHalfEven(numerator, MILLIUNITS_PER_UNIT);
}

/** Splits cents proportionally and corrects the largest rounding errors in input order on ties. */
export function allocateCents(totalCents: bigint, weights: readonly bigint[]): bigint[] {
    if (weights.some(weight => weight < ZERO)) throw new RangeError("Allocation weights must be nonnegative");
    if (totalCents === ZERO) return weights.map(() => ZERO);

    const totalWeight = weights.reduce((sum, weight) => sum + weight, ZERO);
    if (totalWeight === ZERO) throw new RangeError("Allocation requires a positive weight");

    const shares = weights.map(weight => {
        const numerator = totalCents * weight;
        return roundHalfEven(numerator, totalWeight);
    });
    const difference = totalCents - shares.reduce((sum, share) => sum + share, ZERO);
    if (difference === ZERO) return shares;

    const adjustment = difference > ZERO ? ONE : -ONE;
    const ranked = weights.map((weight, index) => ({
        index,
        residue: adjustment * (totalCents * weight - shares[index] * totalWeight),
    }));
    ranked.sort((a, b) => {
        if (a.residue === b.residue) return a.index - b.index;
        return a.residue > b.residue ? -1 : 1;
    });
    // Each share differs from its exact quota by at most half a cent.
    const remaining = Number(difference * adjustment);
    for (const { index } of ranked.slice(0, remaining)) shares[index] += adjustment;
    return shares;
}
