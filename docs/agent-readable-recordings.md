# How we made recordings agent-readable

This is the story of how the `/agent/recordings/:id` gateway came to look the
way it does — mostly a series of "that doesn't actually work" discoveries,
each one changing the shape of the solution.

## The goal

An rrweb recording is just a replay page — great for a human, useless for an
agent that wasn't in the loop when it was made. The goal: let *any* agent
that can open a URL figure out what happened in a recording — actions taken,
page state, what changed, network calls made — without needing an LLM to
re-derive it from raw events every time, and without requiring MCP.

## Attempt 1: hidden AI-only instructions on the page

The first idea was simple — bake an instructions block into the replay page
that's only meant for an AI to read, not a human. We first made this a
visible panel, then hid it (DOM-present, not rendered) once it started
cluttering the human-facing replay view.

This assumed the agent would fetch the page like `curl` would: request the
URL, get HTML back, read the text. That assumption broke immediately.

## Problem: the agent doesn't curl, it browses

The agent reading the recording didn't hit the URL with a plain HTTP fetch —
it opened it with a browser-access / "browser use" tool, i.e. it rendered
the page and read it the way a human would, through the DOM. That's a
reasonable thing for a browsing-capable agent to do, but it meant:

- Nothing about the URL itself told the agent "this is a machine-readable
  resource, not just a page to look at."
- Some browsing tools don't reliably surface everything in a hidden
  (`display:none`) block the same way a plain-text fetch would.

## Fix: name the URL, make the plain-text version the main link

Two changes:

1. **Renamed the route** from a terse `/r/:id` to `/agent/recordings/:id`
   (and every sub-route under it). The path itself now hints to any agent —
   human-written or not — that this is a scrapable/agent-oriented resource,
   not just another replay link.
2. **`/agent/recordings/:id/agents.txt` is the main agent link**, not a
   fallback. It serves the exact same instructions as a standalone
   `text/plain` resource — zero DOM, zero rendering, just a fetchable URL —
   so it's the one to hand an agent, or the one an agent should try first if
   it found the recording URL on its own. The HTML replay page still carries
   the identical instructions (hidden, DOM-present) for an agent that opens
   the recording link directly rather than being handed `agents.txt`, but
   `agents.txt` is what "Copy for AI" on the replay page actually copies.

## Then: build out actual tools, not just instructions

Instructions alone just point at data that didn't exist yet. So the actual
extraction got built — deterministically, no LLM — from the raw rrweb event
stream:

- `/agent/recordings/:id/actions` — every semantic action (click, type,
  scroll, ...) with a timestamp and target.
- `/agent/recordings/:id/state?action=<id>` — compact semantic state
  (headings, inputs, table shape) at that point.
- `/agent/recordings/:id/diff?before=<id>&after=<id>` — added/removed/changed
  content between two actions.
- `/agent/recordings/:id/search?q=<query>` — full-text search across
  actions and state.
- A JSON API mirroring all of the above, for a client that wants to skip
  HTML entirely.

This is computed once per recording into a `.agent.json` sidecar (a headless
Chromium pass resolves DOM-dependent state), and every route just reads it
back — no recomputation, no LLM call, on every request.

## Problem: the agent won't follow a URL it constructed itself

Once `/state?action=<id>` existed, the obvious next step was letting an
agent ask for state at an arbitrary point: `/state?t=<seconds>`. That mostly
worked — until testing showed some browsing tools will follow a link *they
found on the page*, but refuse to navigate to a URL they built or edited
themselves (a safety restriction against agents wandering off to
constructed URLs). So an agent could click through to `state?t=0` because
that exact link was on the page, but editing it to `state?t=8` itself was
blocked, even though the endpoint worked perfectly fine.

## Fix: never make the agent construct a URL — always give it a real `<a href>`

Every reference to another part of the recording had to become an actual
discoverable link on the page, not something the agent was expected to
build:

- Actions link straight to their own `state`, `diff`, and (later) `render`
  URLs.
- Search results link to the matching action's `state` URL.
- A server-generated timestamp form/links, rather than expecting the agent
  to hand-edit a `?t=` query string.

The rule that fell out of this: if an agent needs to get somewhere, put a
real link there — don't assume it can or will construct the URL itself.

## Other friction along the way

- The original visible "For AI agents" panel was removed from the human
  view entirely once the hidden-block + `/agents.txt` approach existed — no
  reason to clutter the replay page a human is looking at.
- A "Copy for AI" button was added so a human could hand the same
  instructions to an agent manually, for tools that can't open the URL
  themselves. It went through two fixes: first it copied the (now-hidden)
  instructions text, when what an agent actually needs is a URL it can
  open — fixed to copy a link instead. Then the link itself was wrong: it
  pointed at the HTML replay page, when `/agents.txt` (the plain-text,
  zero-DOM entry point) is the one an agent should actually be handed —
  fixed to copy that instead.

## Last additions: network capture, for debugging, and full render

Two more capabilities got added on top once the core gateway worked:

**Network capture** (`/agent/recordings/:id/network`) — for debugging what
a recorded session actually talked to over the network, not just what it
did in the DOM. This went through its own round of iteration:
metadata-only first (method/URL/status/duration), then headers and small
text bodies, then redaction of `Authorization`/`Cookie`-style header values
(name kept, value replaced) plus FormData support. The real bug, caught only
once tested against a genuine recording instead of synthetic test data: the
patch was written into the content script's *isolated* JS world, which is a
separate global object from the page's *main* world — so it never saw the
page's own `fetch`/`XHR` calls at all. Fixed by injecting the patch into the
page's MAIN world instead, relaying captured requests back to the content
script via a DOM `CustomEvent` (the DOM is shared across worlds even though
`window` objects aren't).

**Render HTML** (`/agent/recordings/:id/render?action=<id>`) — the compact
`state` endpoint tells an agent *that* a table has, say, 12 rows, but not
what's in them. `render` does an on-demand headless-Chromium reconstruction
of the full DOM at that timestamp, so an agent can actually read the
content it only knew the shape of before.

**Console capture** (`/agent/recordings/:id/console`) — added right after
network capture, for the same debugging reason: an agent looking at *why*
something went wrong wants the page's own `console.log`/`warn`/`error`
output, not just the requests it made. Same MAIN-world patch as network
capture (same isolated-vs-main-world fix applies to `console`, not just
`fetch`/`XHR`), same 2000-char cap per entry — but truncated rather than
dropped, since a log line isn't a credential carrier the way a request body
can be, so there's less reason to throw the whole thing away.

## Where it ended up

```
/agent/recordings/:id/agents.txt   -- MAIN LINK: plain text, no DOM required
/agent/recordings/:id              -- same instructions, embedded in the replay page
 ├─ actions      -- what happened, with timestamps
 │   ├─ state    -- compact semantic state at a point
 │   ├─ render   -- full reconstructed HTML at that point
 │   └─ diff     -- what changed between two points
 ├─ search       -- full-text search across all of the above
 ├─ network      -- captured fetch/XHR requests
 └─ console      -- captured console.log/info/warn/error/debug output
```

Same data, two consumption modes: a browsing-capable agent (or a human
handing off via "Copy for AI", which copies the `agents.txt` link) can just
open the URL and follow real links; anything MCP-capable gets the same data
faster, directly as JSON — MCP is the optional shortcut here, never the
requirement.
