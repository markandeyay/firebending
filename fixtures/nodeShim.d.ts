/**
 * Minimal ambient typings for the Node builtins used by the fixture generator
 * and the test harness. The repo tsconfig pins "types" to ["vite/client"] and
 * @types/node is not installed, so we declare exactly the surface we use.
 * If @types/node is ever added to the repo, delete this file.
 */
declare module 'node:fs' {
  export function mkdirSync(
    path: string | URL,
    options?: { recursive?: boolean },
  ): string | undefined;
  export function writeFileSync(path: string | URL, data: string): void;
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function existsSync(path: string | URL): boolean;
  export function readdirSync(path: string | URL): string[];
  export function statSync(path: string | URL): { mtimeMs: number };
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

/** Minimal process surface for tools/analyze.ts (tsx entry + tests). */
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
};
