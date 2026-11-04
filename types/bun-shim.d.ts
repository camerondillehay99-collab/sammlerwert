// Minimal Bun typings used for `tsc --noEmit` in environments without bun-types.
// In a normal setup install bun-types (`bun add -d bun-types`) and delete this file from tsconfig.typecheck.json.
declare module "bun:sqlite" {
  export class Statement<R = unknown, P extends unknown[] = unknown[]> {
    get(...params: P): R | null;
    all(...params: P): R[];
    run(...params: P): { changes: number; lastInsertRowid: number | bigint };
  }
  export class Database {
    constructor(path: string, options?: { create?: boolean; readonly?: boolean });
    exec(sql: string): void;
    query<R = unknown, P extends unknown[] = unknown[]>(sql: string): Statement<R, P>;
    prepare<R = unknown, P extends unknown[] = unknown[]>(sql: string): Statement<R, P>;
    transaction<F extends (...args: never[]) => unknown>(fn: F): F;
    close(): void;
  }
}
declare module "bun:test" {
  export const describe: (name: string, fn: () => void) => void;
  export const test: (name: string, fn: () => void | Promise<void>) => void;
  export const beforeAll: (fn: () => void | Promise<void>) => void;
  export const afterAll: (fn: () => void | Promise<void>) => void;
  export function expect(value: unknown): {
    toBe(v: unknown): void; toEqual(v: unknown): void; toBeNull(): void; toBeCloseTo(v: number, d?: number): void;
    toBeGreaterThan(v: number): void; toBeLessThan(v: number): void; toBeGreaterThanOrEqual(v: number): void; toBeLessThanOrEqual(v: number): void;
    toContain(v: unknown): void; toBeTruthy(): void; toBeUndefined(): void; toMatch(re: RegExp | string): void; toMatchObject(v: unknown): void; toThrow(): void; not: { toContain(v: unknown): void; toBe(v: unknown): void };
  };
}
interface BunFile extends Blob { readonly size: number; text(): Promise<string>; json(): Promise<unknown>; exists(): Promise<boolean> }
interface BunServer { port: number; hostname: string; stop(): void }
declare const Bun: {
  file(path: string | URL): BunFile;
  write(path: string, data: string | Blob | Response | ArrayBuffer | Uint8Array): Promise<number>;
  serve(opts: { port?: number; hostname?: string; idleTimeout?: number; maxRequestBodySize?: number; fetch(req: Request): Response | Promise<Response> }): BunServer;
  password: { hash(pw: string, opts?: { algorithm?: string; memoryCost?: number; timeCost?: number }): Promise<string>; verify(pw: string, hash: string): Promise<boolean> };
  hash(data: string | ArrayBuffer): number | bigint;
  build(opts: Record<string, unknown>): Promise<{ success: boolean; logs: unknown[]; outputs: Array<{ path: string; size: number }> }>;
};
