export async function total(items: number[]): Promise<number> {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}

export async function applyDiscount(price: number, percent: number): Promise<number> {
  return (price * (100 - percent)) / 100;
}
