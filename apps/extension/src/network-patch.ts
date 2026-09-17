// Injected into the page's MAIN world by background.ts (chrome.scripting
// world: "MAIN") to patch fetch/XHR where the page's own calls actually run
// -- a content script's window is a separate isolated-world global, so
// patching window.fetch there never sees the page's real requests. Toggles
// on/off: calling this file a second time undoes the patch, so background.ts
// can inject it once at recording start and once at recording stop without
// extra messaging.
//
// Captured entries are relayed to the isolated-world content script via a
// DOM CustomEvent (the DOM is shared across worlds; window objects are not).
// Headers/bodies follow the same privacy rules as the rest of the pipeline:
// auth/cookie header values are redacted (name kept), and bodies over
// MAX_BODY_CHARS are dropped entirely rather than truncated.
export {};

(() => {
  const w = window as any;
  if (w.__wingmanNetworkUnpatch) {
    w.__wingmanNetworkUnpatch();
    delete w.__wingmanNetworkUnpatch;
    return;
  }

  const MAX_BODY_CHARS = 2000;
  const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);

  function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!headers) return undefined;
    const out: Record<string, string> = {};
    for (const k in headers) out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : headers[k];
    return out;
  }

  function headersToObject(h: HeadersInit | Headers | undefined): Record<string, string> | undefined {
    if (!h) return undefined;
    const out: Record<string, string> = {};
    if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
    else for (const k in h) out[k] = (h as Record<string, string>)[k];
    return redactHeaders(Object.keys(out).length ? out : undefined);
  }

  function formDataToText(fd: FormData): string | undefined {
    const parts: string[] = [];
    fd.forEach((v, k) => {
      parts.push(typeof v === "string" ? `${k}=${v}` : `${k}=[file: ${(v as File).name}, ${(v as File).size} bytes]`);
    });
    const text = parts.join("&");
    return text.length > 0 && text.length <= MAX_BODY_CHARS ? text : undefined;
  }

  function smallTextBody(body: unknown): string | undefined {
    if (typeof body === "string") return body.length > 0 && body.length <= MAX_BODY_CHARS ? body : undefined;
    if (typeof FormData !== "undefined" && body instanceof FormData) return formDataToText(body);
    return undefined;
  }

  function parseXhrHeaders(raw: string): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    for (const line of raw.trim().split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return redactHeaders(Object.keys(out).length ? out : undefined);
  }

  function emit(entry: unknown): void {
    window.dispatchEvent(new CustomEvent("wingman-network-entry", { detail: entry }));
  }

  const originalFetch = window.fetch;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const start = performance.now();
    const input = args[0];
    const init = args[1];
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const requestHeaders = headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const requestBody = smallTextBody(init?.body);
    return originalFetch.apply(window, args).then(
      async (res) => {
        const responseHeaders = headersToObject(res.headers);
        let responseBody: string | undefined;
        try {
          responseBody = smallTextBody(await res.clone().text());
        } catch {
          /* opaque/streamed response body -- skip it */
        }
        emit({ method, url, status: res.status, durationMs: Math.round(performance.now() - start), ok: res.ok, requestHeaders, requestBody, responseHeaders, responseBody });
        return res;
      },
      (err) => {
        emit({ method, url, status: 0, durationMs: Math.round(performance.now() - start), ok: false, requestHeaders, requestBody });
        throw err;
      }
    );
  };

  const OrigXHR = XMLHttpRequest;
  const originalXhrOpen = OrigXHR.prototype.open;
  const originalXhrSend = OrigXHR.prototype.send;
  const originalXhrSetRequestHeader = OrigXHR.prototype.setRequestHeader;

  OrigXHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    (this as any).__wingmanMethod = method;
    (this as any).__wingmanUrl = String(url);
    (this as any).__wingmanReqHeaders = undefined;
    return (originalXhrOpen as any).call(this, method, url, ...rest);
  };
  OrigXHR.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const headers = ((this as any).__wingmanReqHeaders ??= {});
    headers[name] = value;
    return originalXhrSetRequestHeader.call(this, name, value);
  };
  OrigXHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    const start = performance.now();
    const requestBody = smallTextBody(args[0]);
    this.addEventListener("loadend", () => {
      let responseBody: string | undefined;
      try {
        responseBody = smallTextBody(this.responseType === "" || this.responseType === "text" ? this.responseText : undefined);
      } catch {
        /* responseText throws for non-text responseTypes */
      }
      emit({
        method: (this as any).__wingmanMethod ?? "GET",
        url: (this as any).__wingmanUrl ?? "",
        status: this.status,
        durationMs: Math.round(performance.now() - start),
        ok: this.status >= 200 && this.status < 400,
        requestHeaders: redactHeaders((this as any).__wingmanReqHeaders),
        requestBody,
        responseHeaders: parseXhrHeaders(this.getAllResponseHeaders() ?? ""),
        responseBody,
      });
    });
    return (originalXhrSend as any).apply(this, args);
  };

  w.__wingmanNetworkUnpatch = () => {
    window.fetch = originalFetch;
    OrigXHR.prototype.open = originalXhrOpen;
    OrigXHR.prototype.send = originalXhrSend;
    OrigXHR.prototype.setRequestHeader = originalXhrSetRequestHeader;
  };
})();
