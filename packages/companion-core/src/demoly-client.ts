// Talks to Demoly's own backend API on behalf of the user, using a token
// pair captured via the extension's handshake bridge (see
// apps/extension/src/demoly-handshake.ts). Runs entirely inside Companion
// Core (a Node process), so none of these calls are subject to browser CORS
// -- that's also why uploads are triggered from the replay page hitting
// Companion Core's own local server, not by the replay page calling Demoly
// directly (see ensureStaticServer's /demoly/* routes in index.ts).
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { appSupportDir } from "@browser-agent/protocol/dist/paths";

interface DemolyAuth {
  apiBase: string;
  accessToken: string;
  refreshToken: string;
  user?: unknown;
  organization?: { _id?: string; id?: string; name?: string };
  workspaceId?: string;
  projectId?: string | null;
}

const authFile = (): string => path.join(appSupportDir(), "demoly-auth.json");

function load(): DemolyAuth | null {
  try {
    return JSON.parse(fs.readFileSync(authFile(), "utf8"));
  } catch {
    return null;
  }
}

function save(auth: DemolyAuth): void {
  fs.mkdirSync(appSupportDir(), { recursive: true });
  fs.writeFileSync(authFile(), JSON.stringify(auth, null, 2));
}

function requireAuth(): DemolyAuth {
  const auth = load();
  if (!auth) throw new Error("Not connected to Demoly. Log into app.demoly.dev in a normal tab with Wingman installed, then try again.");
  return auth;
}

async function refreshAccessToken(auth: DemolyAuth): Promise<DemolyAuth> {
  const res = await fetch(`${auth.apiBase}/auth/extension-token/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: auth.refreshToken }),
  });
  if (!res.ok) throw new Error("Demoly session expired. Log into app.demoly.dev again in a normal tab.");
  const data = (await res.json()) as { accessToken?: string; token?: string; refreshToken?: string };
  const next: DemolyAuth = { ...auth, accessToken: data.accessToken ?? data.token ?? auth.accessToken, refreshToken: data.refreshToken ?? auth.refreshToken };
  save(next);
  return next;
}

// Access tokens are short-lived; every call here can be the first one after
// a long idle gap, so a 401 is expected and refreshed-and-retried once
// rather than surfaced as an error.
async function apiFetch(auth: DemolyAuth, path_: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = (a: DemolyAuth) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${a.accessToken}`);
    return fetch(`${a.apiBase}${path_}`, { ...init, headers });
  };
  const res = await doFetch(auth);
  if (res.status !== 401) return res;
  const refreshed = await refreshAccessToken(auth);
  return doFetch(refreshed);
}

export const demolyClient = {
  isConnected(): boolean {
    return load() !== null;
  },

  getStatus(): { connected: boolean; workspaceId?: string; projectId?: string | null; organization?: unknown } {
    const auth = load();
    if (!auth) return { connected: false };
    return { connected: true, workspaceId: auth.workspaceId, projectId: auth.projectId, organization: auth.organization };
  },

  // Called when the extension pushes a captured handshake (see
  // apps/extension/src/background.ts's demoly.auth event).
  storeHandshake(data: { apiBase: string; accessToken: string; refreshToken: string; user?: unknown; organization?: DemolyAuth["organization"] }): void {
    const existing = load();
    save({
      apiBase: data.apiBase,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
      organization: data.organization,
      workspaceId: data.organization?._id ?? data.organization?.id ?? existing?.workspaceId,
      projectId: existing?.projectId ?? null,
    });
  },

  async listWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    const auth = requireAuth();
    const res = await apiFetch(auth, "/auth/org");
    if (!res.ok) throw new Error(`Failed to list workspaces (${res.status})`);
    const data = (await res.json()) as Array<{ _id?: string; id?: string; name: string }>;
    return data.map((o) => ({ id: o._id ?? o.id ?? "", name: o.name }));
  },

  async setWorkspace(organizationId: string): Promise<void> {
    const auth = requireAuth();
    const res = await apiFetch(auth, "/auth/org/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId }),
    });
    if (!res.ok) throw new Error(`Failed to switch workspace (${res.status})`);
    const data = (await res.json()) as { accessToken?: string; token?: string; refreshToken?: string };
    save({ ...auth, accessToken: data.accessToken ?? data.token ?? auth.accessToken, refreshToken: data.refreshToken ?? auth.refreshToken, workspaceId: organizationId });
  },

  async listProjects(): Promise<Array<{ id: string; name: string }>> {
    const auth = requireAuth();
    const res = await apiFetch(auth, "/projects");
    if (!res.ok) throw new Error(`Failed to list projects (${res.status})`);
    const data = (await res.json()) as { projects?: Array<{ id: string; name: string }> };
    return data.projects ?? [];
  },

  setProject(projectId: string | null): void {
    const auth = requireAuth();
    save({ ...auth, projectId });
  },

  // Creates a Demoly session, uploads the given rrweb events in ~20-event
  // gzip chunks (mirrors Demoly's own checkAndUploadChunk pacing), and
  // finalizes it. Returns the share URL Demoly's frontend serves the replay
  // at.
  async upload(opts: {
    events: unknown[];
    sourceUrl: string;
    title: string;
    durationMs: number;
    projectId?: string | null;
    comments?: Array<{ text: string; offsetMs: number }>;
  }): Promise<{ shareId: string; url: string }> {
    const auth = requireAuth();
    const projectId = opts.projectId !== undefined ? opts.projectId : auth.projectId;

    const createBody: Record<string, unknown> = { sourceUrl: opts.sourceUrl, title: opts.title, viewport: null };
    if (projectId) createBody.projectId = projectId;
    const createRes = await apiFetch(auth, "/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });
    if (!createRes.ok) throw new Error(`Failed to create Demoly session (${createRes.status})`);
    const created = (await createRes.json()) as { id?: string; shareId?: string };
    if (!created.id) throw new Error("Demoly did not return a session id");

    const CHUNK_SIZE = 20;
    for (let i = 0; i < opts.events.length; i += CHUNK_SIZE) {
      const slice = opts.events.slice(i, i + CHUNK_SIZE);
      const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(slice), "utf8"));
      const form = new FormData();
      form.append("index", String(i / CHUNK_SIZE));
      form.append("chunk", new Blob([gzipped], { type: "application/gzip" }), "chunk.gz");
      const chunkRes = await apiFetch(auth, `/sessions/${created.id}/chunk`, { method: "POST", body: form });
      if (!chunkRes.ok) throw new Error(`Failed to upload chunk ${i / CHUNK_SIZE} (${chunkRes.status})`);
    }

    const finalizeForm = new FormData();
    finalizeForm.append("durationMs", String(opts.durationMs));
    finalizeForm.append("eventsRawBytes", "0");
    finalizeForm.append("sourceUrl", opts.sourceUrl);
    finalizeForm.append("tabTimeline", "[]");
    finalizeForm.append("tabCount", "1");
    finalizeForm.append("events", new Blob([new Uint8Array(0)]), "dummy.gz");
    const finalizeRes = await apiFetch(auth, `/sessions/${created.id}/finalize`, { method: "POST", body: finalizeForm });
    if (!finalizeRes.ok) throw new Error(`Failed to finalize Demoly session (${finalizeRes.status})`);
    const finalized = (await finalizeRes.json()) as { shareId?: string };
    const shareId = finalized.shareId ?? created.shareId ?? created.id;

    const frontendBase = auth.apiBase.replace("api.demoly.dev/api/v1", "app.demoly.dev").replace(/\/api\/v1$/, "");

    // Best-effort: Demoly's comment API is separate from the session upload
    // above, so one bad comment shouldn't fail an otherwise-successful
    // upload. Posted sequentially (not Promise.all) so comments land in the
    // same order they were recorded.
    for (const comment of opts.comments ?? []) {
      try {
        await apiFetch(auth, `/sessions/${created.id}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: comment.text, timestampMs: comment.offsetMs, elementSelector: null, elementSnapshot: null, parentId: null }),
        });
      } catch {
        // ignore; the video upload itself already succeeded
      }
    }

    return { shareId, url: `${frontendBase}/share/replay/${shareId}` };
  },
};
