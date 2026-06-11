// Re-export of the canonical list — the single source of truth lives in
// server/material-attributes.ts (node-free, pure data) so the server-side
// agent write gate validates against exactly the pins the web renders/exports.
export { MATERIAL_ATTRIBUTE_PINS, MATERIAL_OUTPUT_PINS } from '../../server/material-attributes';
