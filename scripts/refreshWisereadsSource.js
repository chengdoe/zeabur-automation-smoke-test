import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const feedUrl = process.env.WISEREADS_RSS_URL || "https://wise.readwise.io/feed/";
const outputFile = path.resolve(process.env.WISEREADS_MIRROR_FILE || "data-sources/wisereads/latest.xml");

const xml = process.env.WISEREADS_FEED_XML_FILE
  ? await readFile(process.env.WISEREADS_FEED_XML_FILE, "utf8")
  : await fetchFeed(feedUrl);
const item = xml.match(/<item>[\s\S]*?<\/item>/i)?.[0];
if (!item) throw new Error("Latest Wisereads RSS item was not found");

const mirror = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n<channel>\n${item}\n</channel>\n</rss>\n`;
await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, mirror, "utf8");
console.log(`Updated ${outputFile}`);

async function fetchFeed(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "KaneWisereadsSourceMirror/1.0" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Wisereads RSS mirror fetch failed: ${response.status}`);
  return response.text();
}
