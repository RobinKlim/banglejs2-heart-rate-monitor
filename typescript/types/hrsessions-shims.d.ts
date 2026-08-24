// Local supplement to the vendored typescript/types/ files.
//
// The upstream espruino/BangleApps monorepo's typescript/types/modules.d.ts
// (copied verbatim here) references `PowerUsageModule`, a type normally
// declared in that monorepo's separate top-level `modules/power_usage.ts`
// file. This standalone repo only vendors `typescript/` (per this story's
// scope), not the whole monorepo, so that file doesn't exist here.
// hrsessions never `require("power_usage")`, so a minimal stub is enough
// to keep the vendored modules.d.ts type-checking cleanly.
type PowerUsageModule = any;
