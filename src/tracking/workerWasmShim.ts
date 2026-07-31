/**
 * MediaPipe WASM-loader shim for MODULE workers (quality round Phase 1).
 *
 * ROOT CAUSE THIS FIXES: MediaPipe Tasks' wasm loader
 * (vision_wasm_internal.js) is a CLASSIC script whose whole contract is a
 * top-level `var ModuleFactory = ...` global. MediaPipe loads it with
 * importScripts in workers, but our workers are MODULE workers (Vite's
 * `new Worker(url, { type: 'module' })`), where importScripts throws a
 * TypeError. MediaPipe then falls back to `self.import` (its documented
 * override hook) or native dynamic import(); native import() executes the
 * loader in MODULE scope, so the `var` never becomes a global and
 * createFromOptions dies with "ModuleFactory not set." -- which silently
 * disabled the pose worker (it fell back to main-thread pose) and would
 * disable the hand worker the same way.
 *
 * THE SHIM: provide the `self.import` hook with a fetch + INDIRECT eval,
 * which executes the loader source in GLOBAL scope, so `var ModuleFactory`
 * lands on the worker global exactly as importScripts would have put it.
 * The CDNs involved (jsdelivr for the loader, Google storage for models)
 * both serve permissive CORS, so fetch is equivalent to what importScripts
 * fetched. Main-thread MediaPipe use is untouched (there `document` exists
 * and MediaPipe injects a <script> tag, which works).
 *
 * Call installWorkerWasmShim() at worker-module top level, BEFORE any
 * createXLandmarker runs.
 */

export function installWorkerWasmShim(): void {
  // Main thread (script-tag path works) or an environment that already
  // provides the hook: leave it alone.
  if (typeof document !== 'undefined') return;
  const scope = self as unknown as { import?: (url: string) => Promise<unknown> };
  if (typeof scope.import === 'function') return;
  scope.import = async (url: string): Promise<unknown> => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`wasm loader fetch failed: ${res.status} ${url}`);
    }
    const src = await res.text();
    // Indirect eval = global scope execution (sets `var ModuleFactory`).
    (0, eval)(src);
    return undefined;
  };
}
