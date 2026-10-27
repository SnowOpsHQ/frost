// `axe-core`'s minified build as a string (Vite's `?raw` import, bundled into main): injected into a
// tab's accessibility world only (`a11y.ts`).
declare module 'axe-core/axe.min.js?raw' {
  const source: string;
  export default source;
}
