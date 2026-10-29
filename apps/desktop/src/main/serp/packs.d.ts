// The bundled selector pack and its signature as strings (Vite's `?raw` import, bundled into main):
// verified at startup like any other pack (`bundled.ts`, `pack-store.ts`).
declare module '*/serp-selectors.json?raw' {
  const text: string;
  export default text;
}
declare module '*/serp-selectors.json.sig?raw' {
  const text: string;
  export default text;
}
