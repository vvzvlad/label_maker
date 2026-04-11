// Shared mutable application state — imported by all modules that need canvas/stage access.
// Use appState.xxx = value to mutate; never reassign appState itself.

export const PX_PER_MM = 96 / 25.4;       // 96 DPI screen resolution
export const PDF_DPI = 600;               // Output resolution for PDF export
export const PREVIEW_PIXEL_RATIO = 3;     // Pixel ratio for preview strip rendering
export const PREVIEW_DEBOUNCE_MS = 10;    // Delay before re-rendering preview strip (ms)
export const DEFAULT_FONT_SIZE = 20;      // Default font size for newly added text nodes
export const HISTORY_MAX = 200;           // Maximum undo/redo history depth

export const appState = {
  stage: null,            // Konva.Stage instance
  layer: null,            // Konva.Layer instance
  transformer: null,      // Konva.Transformer instance
  bgRect: null,           // Background white Konva.Rect
  previewTimer: null,     // setTimeout handle for debounced preview rendering
  entityColumnCount: 3,   // Number of entity columns in the data table
  historyStack: [],       // Array of serialized layer snapshots
  historyIndex: -1,       // Current position in historyStack
  imageCache: new Map(),  // URL → HTMLImageElement cache for loaded images
};
