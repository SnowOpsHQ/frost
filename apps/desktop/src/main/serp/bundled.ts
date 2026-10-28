import PACK_TEXT from './packs/serp-selectors.json?raw';
import PACK_SIGNATURE from './packs/serp-selectors.json.sig?raw';
import type { PackFiles } from './pack-store';

// The selector pack bundled with the app (spec `serp-selector-pack.spec.ts`, trust model): the
// pack file and its `.sig` as raw text (Vite's `?raw`, bundled into main), so what is verified at
// startup is the file's exact bytes, never a re-serialised object. The pack is ASCII JSON without a
// BOM (`pnpm sign:selectors` signs nothing else), so encoding the text gives those bytes back
// (`bundled-pack-is-signed` compares them with the file); git keeps the files byte-exact
// (`.gitattributes`: `-text`).
export const BUNDLED_PACK: PackFiles = { bytes: new TextEncoder().encode(PACK_TEXT), signature: PACK_SIGNATURE };
