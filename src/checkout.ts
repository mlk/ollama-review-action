export async function total(items: number[]): Promise<number> {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}

export async function applyDiscount(price: number, percent: number): Promise<number> {
  return Math.round((price * (100 - percent)) / 100);
}

export async function chargeCard(total: number, card: { token: string }): Promise<void> {
  const response = await fetch('https://payments.example.com/charge', {
    body: JSON.stringify({ total, token: card.token }),
  });
  if (response.status === 200) {
    return;
  }
  throw new Error('charge failed');
}
