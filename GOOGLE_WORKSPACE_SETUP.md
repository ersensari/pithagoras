# Google Workspace (Gmail, Calendar, Tasks) — finishing the connection

Everything that could be prepared without you being physically present is
done. Two steps are left, and they genuinely require you — the account
owner — logged into a browser as **ersensari@gmail.com** (not the Kmart work
account `gcloud` on this machine already happens to be signed in as; that
account must not be used for this).

The MCP server (`taylorwilsdon/google_workspace_mcp`, PyPI `workspace-mcp`)
is already wired into Voxa's `mcp.json` as `google-workspace`, launched on
demand via `uvx workspace-mcp --tool-tier core` (`uv`/`uvx` are already
installed in the Pithagoras container — nothing to install). It covers
Gmail, Calendar, and Tasks (Google Tasks is the real substitute for
notes/reminders/shopping lists — Google Keep has no API a personal account
can use at all, confirmed via research, not something this setup can add).

It currently has empty credentials, so Voxa's workspace tools simply do
nothing until you finish these two steps.

## Step 1 — Google Cloud project + OAuth client (you, in a browser)

1. Open <https://console.cloud.google.com/> and make sure you're signed in
   as **ersensari@gmail.com** (check the account switcher top-right).
2. Create a new project (any name, e.g. "voxa-workspace").
3. Enable these three APIs for that project (search each by name in
   "APIs & Services → Library", or open these links while the right project
   is selected):
   - Gmail API
   - Google Calendar API
   - Tasks API
4. Go to "APIs & Services → OAuth consent screen":
   - User type: **External** (a personal Gmail account can't use Internal).
   - Fill in the required app name/support email fields (anything
     reasonable — this never goes public).
   - Add yourself (`ersensari@gmail.com`) under "Test users" so the consent
     screen will let you through while the app is unpublished.
5. Go to "APIs & Services → Credentials → Create Credentials → OAuth client
   ID":
   - Application type: **Desktop app**.
   - Name: anything (e.g. "Voxa").
   - Click Create. Copy the **Client ID** and **Client Secret** it shows you.

## Step 2 — fill in the credentials, then authorize

1. Edit `mcp.json`'s `google-workspace` entry and put the Client ID/Secret
   into the two empty `env` fields:
   - Host template: `/home/ersen/Source/pithagoras/data/home/.pi/agent/mcp.json`
   - Live container (same file, bind-mounted — editing the host path above
     is enough, no copy needed)
2. Restart the portal so Pi picks up the change:
   `docker restart forgeloop-ai-pithagoras`
3. In any Voxa chat, ask it to do something real with Workspace — e.g. "what's
   on my calendar today" or "check my unread Gmail". The *first* real call
   will make the server open (or print, in logs) a Google sign-in/consent
   URL. Open it, make sure you're on **ersensari@gmail.com**, and click
   Allow. This is the one step nobody but you can do.
4. After that, it's authorized — the refresh token is cached locally, so you
   won't see that consent screen again.

## What Voxa will and won't do with this

Voxa's `SOUL.md` has an explicit rule: it only touches Gmail/Calendar/Tasks
when you ask in that turn — it never checks your mail, adds events, or
creates tasks on its own initiative.
