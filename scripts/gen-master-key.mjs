// Prints a fresh SLICELY_MASTER_KEY line for a hosted deployment: 32 random
// bytes, base64-encoded. Run once per deployment and hand the output to your
// secrets manager / platform env config — never commit it, never reuse it
// across deployments.
//
//   node scripts/gen-master-key.mjs
import { randomBytes } from "node:crypto";

console.log(`SLICELY_MASTER_KEY=${randomBytes(32).toString("base64")}`);
