export interface Db {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  findCoupon(code: string): Promise<{ amount: number }>;
}

export const db: Db = {
  async query() {
    return [];
  },
  async findCoupon() {
    return { amount: 0 };
  },
};
