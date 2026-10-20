/**
 * The names of the background tool, in a module with no imports: db.ts files the
 * tool's switch by them, and the tool's own module imports the guard, which
 * imports db.ts.
 */

/** The source name the tool's switch is filed under in the settings (see db.ts). */
export const BACKGROUND_SOURCE = "background";
/** The tool's name, as the model calls it. */
export const BACKGROUND_TOOL = "run_in_background";
