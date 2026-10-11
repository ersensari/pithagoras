/**
 * The name the gateway to a conversation's lazy tools is known by, in a module of its own:
 * the guard reads it as it loads, and must not wait on everything the gateway needs.
 */

/** The tool that searches, describes and calls the tools a conversation has as lazy. */
export const GATEWAY_TOOL = "tools";
