import { CALLED_TOOL_KEY, GATEWAY_TOOL } from "../../server/src/pi/tools-gateway-names";

/**
 * What a tool event of pi's carries, read one way. The name has been spelled
 * `toolName` and `name`, and the arguments `input`, `args` and `parameters`:
 * each reader asking for them in its own words is how a rename reaches all
 * but one.
 */

/** The tool's name; `fallback` for an event that carries none. */
export const toolNameOf = (payload: any, fallback = ""): string => String(payload?.toolName ?? payload?.name ?? fallback);

/** What the tool was called with, as the agent wrote it. */
export const toolArgsOf = (payload: any): any => payload?.input ?? payload?.args ?? payload?.parameters;

/**
 * The tool an event is of, for a call that may have gone through the `tools` tool to a lazy one. Its end
 * names the tool the portal saw it call (pi's end carries no arguments); its start, as unwrapCall reads it,
 * has the tool in them. Any other event is of the tool it names.
 */
export const calledToolOf = (payload: any): string => {
  const name = toolNameOf(payload);
  const called = name === GATEWAY_TOOL ? payload?.[CALLED_TOOL_KEY] : undefined;
  return typeof called === "string" && called ? called : name;
};
