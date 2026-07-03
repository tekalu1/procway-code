// Phase 4: the projection lives in core/projections/transcript.mjs. This
// file re-exports it so existing `src/tui/transcript.mjs` consumers keep
// working without changes.
export { transcriptFromMessages } from "../core/projections/transcript.mjs";
