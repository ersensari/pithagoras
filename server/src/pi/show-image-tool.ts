import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { FileError, baseDir, openPicture } from "../workspace-files.js";
import { pathBelow } from "../within.js";
import { pictureExt } from "../prompt-images.js";

/**
 * Putting a picture in front of the person: a chart the agent drew, a
 * screenshot it saved, a photo it found.
 *
 * The agent has always been able to make pictures — it has a shell — but not
 * to show one: in voice mode there is nothing on the screen but the orb, and in
 * the chat a file name is all that appears. This names a picture in the chat's
 * folder; the page sees the call, and shows it (the picture window in voice
 * mode, a thumbnail under the tool line in the chat).
 *
 * Only the chat's folder, for the same reason the Files panel keeps to it: the
 * page fetches the picture back through /sessions/:id/picture, which serves
 * nothing outside it. A picture anywhere else is copied in first.
 */

/** Where `p` is below `root`, relative to it; null when it is not below it, or is `root` itself. */
const under = (root: string, p: string): string | null => pathBelow(root, p) || null;

/** Where `given` is inside `folder`, relative to it, or an explanation why it is not. `action` is what is to be done with the picture, for that. */
export function pictureIn(folder: string, given: string, action = "shown"): string {
  const base = baseDir(folder);
  // The folder as the agent names it may reach the real one through a link:
  // an absolute path is taken inside either. openPicture then checks what the
  // path really leads to.
  const rel = under(base, path.resolve(base, given)) ?? under(path.resolve(folder), path.resolve(folder, given));
  if (!rel) {
    throw new FileError("invalid", `Only a picture in the chat's folder can be ${action}. Copy it there first.`);
  }
  // Checked as the page will fetch it, so a call that succeeds is one that shows.
  closeSync(openPicture(base, rel).fd);
  return rel;
}

/**
 * A picture from the web, by what it shows: an image search (SearXNG, the one the web_search tool uses), the first
 * result that downloads as a real picture saved under `photos/<topic>/`, its path in the chat's folder returned.
 * Before this the agent was told a recipe (search with curl, download, check the bytes, show_image) and the current
 * model skipped it and said it could not show pictures (2026-10-20); one call it cannot get wrong replaces it.
 * A picture already saved for the same query is not shown again, so asking twice shows a second one.
 */
const SEARXNG = (process.env.PORTAL_SEARXNG_URL || "https://taichi-ryzen9.goblin-nominal.ts.net/search").replace(/\/+$/, "");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const MIN_BYTES = 2_000;   // a flag or a logo can be a few KB; an error page or a 1x1 tracker is less
const MAX_BYTES = 20 * 1024 * 1024;

type Fetch = typeof fetch;

/** Wikimedia's SVGs (flags, emblems) are not pictures a page can show as one: its own PNG rendering of them is asked for. */
export function rasterUrl(src: string): string {
  const m = src.match(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/(\w+)\/([0-9a-f])\/([0-9a-f]{2})\/([^/?#]+\.svg)(?:[?#].*)?$/i);
  return m ? `https://upload.wikimedia.org/wikipedia/${m[1]}/thumb/${m[2]}/${m[3]}/${m[4]}/800px-${m[4]}.png` : src;
}

export async function webPicture(folder: string, query: string, fetcher: Fetch = fetch): Promise<{ rel: string; source: string }> {
  const base = baseDir(folder);
  const topic = query.toLowerCase().replace(/ı/g, "i").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "pictures";
  const dir = path.join(base, "photos", topic);
  const url = `${SEARXNG}/search?q=${encodeURIComponent(query)}&format=json&categories=images`;
  const r = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new FileError("invalid", `The picture search answered ${r.status}`);
  const found = ((await r.json()) as { results?: { img_src?: string }[] }).results ?? [];
  const sources = [...new Set(found.map((x) => x.img_src).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).map(rasterUrl))];
  // In the search's own order: putting Wikimedia first (free, plain downloads) traded relevance away - "teal color" showed a
  // jellyfish.
  for (const src of sources.slice(0, 15)) {
    const name = createHash("sha1").update(src).digest("hex").slice(0, 12);
    if (["jpg", "png", "gif", "webp"].some((e) => existsSync(path.join(dir, `${name}.${e}`)))) continue;
    try {
      const d = await fetcher(src, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (!d.ok) continue;
      const bytes = Buffer.from(await d.arrayBuffer());
      const ext = pictureExt(bytes.subarray(0, 12));
      if (!ext || bytes.length < MIN_BYTES || bytes.length > MAX_BYTES) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${name}.${ext}`), bytes);
      return { rel: pictureIn(folder, path.join(dir, `${name}.${ext}`)), source: src };
    } catch {
      // the next one
    }
  }
  throw new FileError("missing", `No picture for "${query}" could be downloaded. Try other words (English often finds more).`);
}

/** An ExtensionFactory — see pi's InlineExtension. */
export function showImageTool(folder: string, fetcher: Fetch = fetch) {
  return (pi: any) => {
    pi.registerTool({
      name: "show_image",
      label: "show image",
      description:
        "Show the user a picture on their screen. Two ways: " +
        "(1) query: a picture from the web - say what it should show (e.g. \"samurai warrior photo\", \"Göktürk flag\") and it is " +
        "searched, downloaded into the chat's folder and shown in one step; use this whenever the user asks to see or find a " +
        "picture or photo of something, never say you cannot show pictures. Call it again for another picture. " +
        "(2) path: a picture file already in the chat's folder (a chart you made, a screenshot): PNG, JPEG, GIF or WebP. " +
        "In voice mode this is the only way the user sees a picture. Give a short title. Say in a sentence what it shows.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "What the picture from the web should show. Use this or path." })),
        path: Type.Optional(Type.String({ description: "A picture in the chat's folder, relative to it or absolute inside it." })),
        title: Type.Optional(Type.String({ description: "A few words shown above the picture." })),
      }),
      execute: async (_id: string, p: { path?: string; query?: string; title?: string }) => {
        const query = typeof p.query === "string" ? p.query.trim().slice(0, 200) : "";
        const given = typeof p.path === "string" ? p.path.trim() : "";
        if (!query && !given) throw new FileError("invalid", "Give query (a picture from the web) or path (a picture in the chat's folder).");
        const web = given ? undefined : await webPicture(folder, query, fetcher);
        const rel = web ? web.rel : pictureIn(folder, given);
        const title = (typeof p.title === "string" ? p.title.trim() : "") || query;
        const details = { path: rel, ...(title ? { title: title.slice(0, 120) } : {}) };
        const text = web ? `Shown to the user: ${rel} (from ${web.source})` : `Shown to the user: ${rel}`;
        return { content: [{ type: "text", text }], details };
      },
    });
  };
}
