// Bundles the core (already built by tsup) into lib/ so a tarball install has no dependencies.
import { copyFileSync, existsSync } from "node:fs";
const src = new URL("../core/dist/index.cjs", import.meta.url);
if (!existsSync(src)) throw new Error("build packages/core first (npm run build -w open-comfort-engine)");
copyFileSync(src, new URL("./lib/core.cjs", import.meta.url));
copyFileSync(new URL("../../LICENSE", import.meta.url), new URL("./LICENSE", import.meta.url));
console.log("bundled core into lib/core.cjs");
