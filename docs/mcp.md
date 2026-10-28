# MCP: let Claude or ChatGPT direct the studio

The app is an [MCP](https://modelcontextprotocol.io) server. A connected assistant can list the workflows, start
generations on your backend, read and edit the open project, take your song's file, analyse it with its own tools and
write the result back, then cut the shots on the beat. Keep the app open while it works: the tools run in the app
window, where your backend settings and projects live.

In the app, **Studio → Claude & ChatGPT** shows these snippets with the right address and key filled in.

## Addresses

| App | MCP endpoint (Streamable HTTP) |
|---|---|
| Desktop app | `http://127.0.0.1:19847/api/mcp` |
| `npm run dev` / `npm start` | `http://localhost:3000/api/mcp` |

Calls from your own computer need no key. Calls through a tunnel need `?key=<token>` (or `Authorization: Bearer
<token>`); the token is in the dialog. It changes when the app restarts unless you set `KITTY_MCP_TOKEN` in
`app/.env.local` (or the desktop app's environment).

## Claude Code

```bash
claude mcp add --transport http kitty-open-studio http://127.0.0.1:19847/api/mcp
```

## Claude Desktop

Settings → Developer → Edit Config, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "kitty-open-studio": {
      "command": "node",
      "args": ["/path/to/kitty-open-studio/app/mcp/kitty-mcp-stdio.mjs"],
      "env": { "KITTY_MCP_URL": "http://127.0.0.1:19847/api/mcp" }
    }
  }
}
```

The desktop app ships the script next to itself; the dialog shows its path. `npx -y mcp-remote <url>` works too.

## ChatGPT

ChatGPT reaches MCP servers over HTTPS only:

1. Open a tunnel to the app, for example `cloudflared tunnel --url http://127.0.0.1:19847`.
2. ChatGPT → Settings → Apps & Connectors → Advanced → Developer mode; create a connector with
   `https://<your-tunnel>/api/mcp?key=<token>` (authentication: none, the key protects it).
3. Close the tunnel when you are done: anyone with the URL can drive the app while it runs.

## Tools

| Tool | Where | What |
|---|---|---|
| `list_workflows`, `get_workflow` | server | the cards, every input, prompt syntax (`<Picture 1>`, `<image1>`), licence notes |
| `get_backend_status` | app | pod / serverless / local, and whether it answers |
| `generate`, `job_status`, `cancel_job`, `list_jobs` | app | run a card; media inputs take `media:<id>`, an https URL or a data: URI |
| `open_in_studio` | app | open a card with the form filled in, for the user to press Generate |
| `get_media_library`, `get_timeline_state` | editor | the project's media and tracks/clips (ids, ms) |
| `place_on_timeline`, `move_clip`, `trim_clip`, `delete_clip`, `set_project_duration`, `set_track_volume` | editor | cut |
| `add_captions` | editor | captions on the timeline: the assistant transcribes or writes the lines (word timings for karaoke/highlight), picks the style |
| `get_media_file` | editor | a download URL (30 min) and the path on disk of a media file, e.g. the song |
| `set_music_analysis` | editor | the assistant's tempo, beats and sections: coloured over the timeline, used by Snap to Beat |

"editor" tools need a project open in the Editor.

**Music analysis is the assistant's job.** The app has no built-in analyser: the assistant gets the song with
`get_media_file`, works out the tempo, beats and sections with its own tools (Claude Code or a code interpreter can run
librosa or ffmpeg; a chat assistant can ask you for the bpm and where the choruses start) and saves them with
`set_music_analysis`. The **Music Analyze** button in the editor says so.

**Captions work the same way.** The assistant transcribes the song or voice itself (Whisper on the file from
`get_media_file`) or writes the lines, then calls `add_captions`; the caption track in the editor shows them, and each
caption stays editable in Properties.

## Prompts and resources

- Prompt `music-video`: the playbook from song to finished cut (look, listen, shot list, generate, cut, hand over).
- Prompt `workflow-guide` (argument `workflow`): one card's guide.
- Resources: `kitty://workflows`, `kitty://workflow/<id>`, `kitty://playbook/music-video`.

Try it: *"Use the music-video prompt from kitty-open-studio with the song in my project."*

## How it works

`app/src/app/api/mcp/route.ts` answers JSON-RPC (stateless, no sessions). Catalog tools are answered there; the rest
go through a bridge: the app window long-polls `/api/mcp/bridge`, runs the tool (`app/src/lib/mcp/bridge-client.ts`)
and posts the result back. The bridge and the file hand-off answer requests from this computer only.
Inspect the tools with `npx @modelcontextprotocol/inspector` (Streamable HTTP, the URL above).
