import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { lookup } from "node:dns/promises";
import net from "node:net";

export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;
const DROP_REPO = process.env.DROP_REPO || "Xcluice/claude-drop";

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v = ip.toLowerCase();
  return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:");
}

async function assertSafeUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http/https URLs allowed");
  const addrs = await lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("Blocked: private/internal address");
  return u;
}

async function download(raw: string, headers?: Record<string, string>) {
  const u = await assertSafeUrl(raw);
  const res = await fetch(u, {
    headers: { "User-Agent": "fetch-mcp/1.0", ...(headers || {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Upstream returned HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`File too large (${buf.length} bytes, max ${MAX_BYTES})`);
  return { buf, contentType: res.headers.get("content-type") || "application/octet-stream" };
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
}

function guessExt(ct: string): string {
  if (ct.includes("png")) return ".png";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("json")) return ".json";
  if (ct.includes("zip")) return ".zip";
  if (ct.includes("pdf")) return ".pdf";
  if (ct.includes("text")) return ".txt";
  return ".bin";
}

async function pushToDrop(path: string, buf: Buffer) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not configured on server");
  const res = await fetch(`https://api.github.com/repos/${DROP_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "fetch-mcp",
    },
    body: JSON.stringify({ message: `drop ${path}`, content: buf.toString("base64") }),
  });
  if (!res.ok) throw new Error(`GitHub error ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function handler(req: Request, ctx: { params: Promise<{ secret: string }> }) {
  const { secret } = await ctx.params;
  if (!process.env.MCP_SECRET || secret !== process.env.MCP_SECRET) {
    return new Response("Not found", { status: 404 });
  }

  const mcp = createMcpHandler(
    (server) => {
      server.tool(
        "fetch_text",
        "Fetch a URL and return its text body (HTML, JSON, etc). Runs server-side, so it can reach domains the chat sandbox blocks.",
        { url: z.string().url(), max_chars: z.number().int().min(100).max(200000).optional() },
        async ({ url, max_chars }) => {
          try {
            const { buf, contentType } = await download(url);
            const text = buf.toString("utf8").slice(0, max_chars ?? 50000);
            return { content: [{ type: "text", text: `content-type: ${contentType}\n\n${text}` }] };
          } catch (e: any) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
          }
        }
      );

      server.tool(
        "fetch_to_drop",
        "Download any file from a URL (image, zip, etc, up to 10MB) and save it to a public GitHub drop repo. Returns a raw.githubusercontent.com URL the chat sandbox CAN download with curl. Files are public.",
        { url: z.string().url(), filename: z.string().optional() },
        async ({ url, filename }) => {
          try {
            const { buf, contentType } = await download(url);
            let name = safeName(filename || url.split("/").pop()?.split("?")[0] || "file");
            if (!/\.[a-zA-Z0-9]{2,5}$/.test(name)) name += guessExt(contentType);
            const path = `files/${Date.now()}-${name}`;
            await pushToDrop(path, buf);
            const raw = `https://raw.githubusercontent.com/${DROP_REPO}/main/${path}`;
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ raw_url: raw, bytes: buf.length, content_type: contentType, note: "raw.githubusercontent.com can lag a few seconds after commit" }),
              }],
            };
          } catch (e: any) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
          }
        }
      );
    },
    {},
    { basePath: `/${secret}`, maxDuration: 60, verboseLogs: false }
  );
  return mcp(req);
}

export { handler as GET, handler as POST, handler as DELETE };
