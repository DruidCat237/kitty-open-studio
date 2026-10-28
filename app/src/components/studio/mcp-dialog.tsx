"use client";

// "Claude & ChatGPT": how to connect an assistant to this app's MCP server, with copy buttons.
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

type Info = { token: string; app: boolean; editor: boolean };

function Snippet({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium text-white/60">{label}</div>
      <div className="group relative">
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/60 p-3 pr-10 text-[11px] leading-relaxed text-emerald-200">
          {code}
        </pre>
        <button type="button" title="Copy"
          onClick={() => {
            navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="absolute right-2 top-2 rounded-md bg-white/10 p-1.5 hover:bg-white/20">
          {copied ? <CheckIcon className="w-3.5 h-3.5 text-emerald-300" /> : <CopyIcon className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

const TABS = [
  { id: "claude-code", title: "Claude Code" },
  { id: "claude-desktop", title: "Claude Desktop" },
  { id: "chatgpt", title: "ChatGPT" },
  { id: "other", title: "Other clients" },
] as const;

export function McpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("claude-code");
  const [info, setInfo] = useState<Info | null>(null);
  const [origin, setOrigin] = useState("http://127.0.0.1:19847");
  const [scriptPath, setScriptPath] = useState("/path/to/kitty-open-studio/app/mcp/kitty-mcp-stdio.mjs");

  useEffect(() => {
    if (!open) return;
    setOrigin(window.location.origin);
    fetch("/api/mcp/info").then((r) => (r.ok ? r.json() : null)).then(setInfo).catch(() => setInfo(null));
    const api = (window as any).electronAPI;
    api?.getMcpScriptPath?.().then((p: string) => p && setScriptPath(p)).catch(() => {});
  }, [open]);

  const url = `${origin}/api/mcp`;
  const port = new URL(origin).port || "80";
  const desktop = JSON.stringify({
    mcpServers: { "kitty-open-studio": { command: "node", args: [scriptPath], env: { KITTY_MCP_URL: url } } },
  }, null, 2);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Direct the studio from Claude or ChatGPT</DialogTitle>
          <DialogDescription>
            The app is an MCP server: an assistant can list the workflows, generate on your backend, read the project, analyse
            a song and cut the results on the timeline. Keep the app open while it works.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 text-[11px]">
          <span className={cn("h-2 w-2 rounded-full", info?.app ? "bg-emerald-400" : "bg-zinc-500")} />
          {info?.editor ? "Editor connected: project tools available." : info?.app
            ? "Studio connected. Open a project in the Editor for timeline tools." : "Waiting for the app window…"}
        </div>
        <div className="flex gap-1 border-b border-white/10">
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              className={cn("px-3 py-1.5 text-xs font-medium", tab === t.id ? "border-b-2 border-fuchsia-400 text-white" : "text-white/50 hover:text-white")}>
              {t.title}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-3">
          {tab === "claude-code" && (
            <>
              <Snippet label="Run once in a terminal" code={`claude mcp add --transport http kitty-open-studio ${url}`} />
              <p className="text-xs text-white/60">Then ask Claude: “Use the music-video prompt from kitty-open-studio with my song.”</p>
            </>
          )}
          {tab === "claude-desktop" && (
            <>
              <Snippet label="Settings → Developer → Edit Config (claude_desktop_config.json), needs Node 18+" code={desktop} />
              <Snippet label="Or, with npm, through mcp-remote" code={JSON.stringify({
                mcpServers: { "kitty-open-studio": { command: "npx", args: ["-y", "mcp-remote", url] } },
              }, null, 2)} />
              <p className="text-xs text-white/60">Restart Claude Desktop; the tools and the music-video prompt appear under the + menu.</p>
            </>
          )}
          {tab === "chatgpt" && (
            <>
              <p className="text-xs text-white/70">
                ChatGPT reaches MCP servers over HTTPS only. Open a tunnel to this app, then in ChatGPT: Settings → Apps &amp;
                Connectors → Advanced → Developer mode, and create a connector with the URL below (authentication: none; the key
                in the URL protects it).
              </p>
              <Snippet label="1. Tunnel (Cloudflare, no account needed)" code={`cloudflared tunnel --url http://127.0.0.1:${port}`} />
              <Snippet label="2. Connector URL (put your tunnel's address in front)"
                code={`https://<your-tunnel>.trycloudflare.com/api/mcp?key=${info?.token ?? "<token>"}`} />
              <p className="text-[11px] text-amber-200/80">
                Anyone with this URL can drive the app while the tunnel runs. Close the tunnel when you are done. The key changes
                when the app restarts unless KITTY_MCP_TOKEN is set.
              </p>
            </>
          )}
          {tab === "other" && (
            <>
              <Snippet label="Streamable HTTP endpoint (no token from this computer)" code={url} />
              <Snippet label="Inspect the tools (pick Streamable HTTP and paste the URL)" code="npx @modelcontextprotocol/inspector" />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
