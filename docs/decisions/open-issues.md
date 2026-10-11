# Open decisions for issues #127, #104, #106, #78, #77, #90, #118

Draft PR that carries the open questions. Close without merge once decided.

## #127 Link a project to an agent
1. Is MEMORY.md writable from the linked project?
2. How does this overlap with Understory?
3. Can the link be changed later?
4. Do skills, heartbeat and sidebar follow the link?
5. Which guard applies to agent files from the linked project?

## #104 Configurable taint rules
1. First slice: per-rule toggles only, or also the delegate fix (a subagent has its own guard instance)?
2. Scope precedence global > project > agent > routine > chat; defaults; boolean or per-rule map?
3. Trusted taint sources: regex allowlist or per-MCP-server flag?
4. Approval path for tainted sessions.
Suggested split: (a) config backend with global/project UI, (b) delegate rule and trusted sources, (c) approval path. Resolve PR #111 first (same area).

## #106 Lazy native tool sets
1. Opt-in per tool set, per chat, or both?
2. Gateway tool or cached MCP server (pi-mcp-adapter)?
3. Narrower first step: browser-only per-chat switch behind a gateway tool?

## #78 Gallery thumbnails
1. sharp (native dependency, LGPL libvips), browser thumbnails via PUT /api/images/:id/thumb (no dependency, first view loads the full file), or a WASM codec (new dependency)?
New dependencies need an explicit OK (CLAUDE.md).

## #77 Pin images
1. Digest pin per release with an Update action, or Chromium-only pin with a user-triggered Update?
2. Who maintains the weekly linuxserver Chromium bumps?
Separate small change possible: pin the Whisper download in deploy/voice/setup.sh (revision and SHA-256).

## #90 Scale images
1. Where does scaling happen: browser-only (Images page, edit_image refusal kept), a server image library (needs OK), or a tool already in the image?
2. Output format and quality of the re-encode (PNG alpha, masks)?
3. May a result be scaled back up?

## #118 Queued prompts
pi has no removal of a single queued message (session.clearQueue() clears all).
1. Merge: separator, images, merge on the page or in the server queue, steer and/or follow-up?
2. Container mode has no clearQueue in the RPC client, so delete and edit are impossible there. Accept the limitation?
3. "Send directly" = abort + send? What happens to the other waiting messages?
4. Delete and edit semantics.
Suggested split into separate issues.
