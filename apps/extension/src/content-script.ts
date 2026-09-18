// Content script. Injected on demand by the background service worker
// (chrome.scripting.executeScript with files: ["content-script.js"]) the
// first time a tab needs DOM access. Guarded so re-injection is a no-op —
// state (the element id map) lives in this module's closure and survives
// for the life of the page, and is naturally cleared on navigation.
import { record, addCustomEvent } from "rrweb";

export {};

type PageFnResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

interface ContentRequest {
  target: "browser-agent-content";
  op: "getPageInfo" | "click" | "type" | "scroll" | "pressKey" | "recording.begin" | "recording.end";
  elementId?: string;
  text?: string;
  direction?: "up" | "down";
  amount?: number;
  key?: string;
  // Whether a recording is currently active, so these ops know whether to
  // play the cursor-glide/highlight animation that makes the resulting
  // replay legible (skipped otherwise so normal automation stays fast).
  recording?: boolean;
  // Optional reason the AI is performing this action, e.g. "clicking submit
  // to save the update". Recorded as an rrweb custom event so it shows up
  // alongside the replay timeline (see renderReplayHtml's comment sidebar).
  comment?: string;
}

if (!(window as any).__browserAgentInjected) {
  (window as any).__browserAgentInjected = true;

  let elements = new Map<string, Element>();

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------
  // Recording: chrome.tabCapture/getUserMedia need a real user gesture Chrome
  // will never grant to an MCP-driven call, and screenshot-based video is
  // capped at Chrome's ~2fps captureVisibleTab quota no matter how it's
  // composited (always looks stop-motion for real page content). rrweb
  // sidesteps both problems: it records DOM mutations + interaction events
  // (not pixels), so there's no fps ceiling to hit, and starting it is just
  // a function call — no gesture needed. This is the same approach Demoly's
  // extension uses (confirmed by reading its unpacked source).
  // ---------------------------------------------------------------------

  let stopRrweb: (() => void) | null = null;
  let eventBuffer: unknown[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------
  // Network capture: the actual fetch/XHR patching runs in the page's MAIN
  // world (injected/toggled by background.ts via network-patch.ts) because
  // a content script's window is a separate isolated-world global -- patching
  // window.fetch here would never see the page's own fetch calls. The main-
  // world patch relays each completed request via a DOM CustomEvent (shared
  // across worlds), which this listener turns into an rrweb custom event
  // read back deterministically by agent-pipeline.ts.
  // ---------------------------------------------------------------------
  const MAX_NETWORK_EVENTS = 500; // ponytail: hard cap so a chatty page can't flood the recording
  const MAX_CONSOLE_EVENTS = 500;
  let networkEventCount = 0;
  let consoleEventCount = 0;

  window.addEventListener("wingman-network-entry", (e: Event) => {
    if (networkEventCount >= MAX_NETWORK_EVENTS) return;
    networkEventCount++;
    addCustomEvent("wingman-network", (e as CustomEvent).detail);
  });

  // Same MAIN-world relay as network capture above, for console.log/info/warn/error/debug.
  window.addEventListener("wingman-console-entry", (e: Event) => {
    if (consoleEventCount >= MAX_CONSOLE_EVENTS) return;
    consoleEventCount++;
    addCustomEvent("wingman-console", (e as CustomEvent).detail);
  });

  function flush(done: boolean): void {
    if (eventBuffer.length === 0 && !done) return;
    const events = eventBuffer;
    eventBuffer = [];
    chrome.runtime.sendMessage({ type: "RECORDING_EVENTS", events, done });
  }

  function queueEvent(event: unknown): void {
    eventBuffer.push(event);
    if (eventBuffer.length >= 50) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      flush(false);
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush(false);
      }, 500);
    }
  }

  function centerOf(el: Element): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // Starts centered rather than off-screen so the very first move is a real
  // glide instead of a zero-length "animation" that rrweb-player renders as
  // an instant jump from its own (0,0) default cursor position.
  let cursorPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  // Dispatches real mousemove events along the path so rrweb's own
  // mousemove sampling captures a genuine glide (and its player renders a
  // moving cursor + click ripples out of the box) instead of the element
  // just teleporting to its click.
  async function animateCursorTo(x: number, y: number): Promise<void> {
    const startX = cursorPos.x;
    const startY = cursorPos.y;
    const dist = Math.hypot(x - startX, y - startY);
    const durationMs = Math.min(1200, Math.max(400, dist * 0.8));
    const steps = Math.max(15, Math.round(durationMs / 20));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = startX + (x - startX) * t;
      const py = startY + (y - startY) * t;
      cursorPos = { x: px, y: py };
      const target = document.elementFromPoint(px, py) || document.body;
      target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: px, clientY: py }));
      await sleep(durationMs / steps);
    }
  }

  // el.click() fires a native click event with clientX/clientY = 0, and
  // rrweb's mouse-interaction observer records that (0,0) verbatim -- that's
  // what made the replay cursor jump to the top-left corner on every click.
  // Dispatching the click ourselves with real coordinates keeps it in sync
  // with the cursor we just animated there.
  function dispatchClickAt(el: HTMLElement, x: number, y: number): void {
    const opts: MouseEventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // Real DOM mutation (not a canvas overlay) so rrweb's own mutation
  // observer captures and replays the highlight naturally.
  function highlightElement(el: Element): () => void {
    const prevOutline = (el as HTMLElement).style.outline;
    const prevOffset = (el as HTMLElement).style.outlineOffset;
    (el as HTMLElement).style.outline = "3px solid rgba(230,30,30,0.85)";
    (el as HTMLElement).style.outlineOffset = "2px";
    return () => {
      (el as HTMLElement).style.outline = prevOutline;
      (el as HTMLElement).style.outlineOffset = prevOffset;
    };
  }

  // A closed shadow root is invisible to rrweb's serializer (it can only walk
  // shadow trees it can reach via `.shadowRoot`, which is null for "closed"),
  // so this stop control never shows up in the replay even though it's a
  // real on-page element the user can see and click live.
  let overlayHost: HTMLElement | null = null;

  // Drags by switching from right/bottom to left/top positioning at the
  // pointer's current offset, so the bar can be parked wherever it doesn't
  // block the content the user is demoing.
  function makeDraggable(bar: HTMLElement): void {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    bar.addEventListener("pointerdown", (e: PointerEvent) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      dragging = true;
      bar.classList.add("dragging");
      bar.setPointerCapture(e.pointerId);
      const rect = bar.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      bar.style.left = `${rect.left}px`;
      bar.style.top = `${rect.top}px`;
      bar.style.right = "auto";
      bar.style.bottom = "auto";
    });
    bar.addEventListener("pointermove", (e: PointerEvent) => {
      if (!dragging) return;
      const maxX = window.innerWidth - bar.offsetWidth;
      const maxY = window.innerHeight - bar.offsetHeight;
      bar.style.left = `${Math.min(Math.max(0, e.clientX - offsetX), maxX)}px`;
      bar.style.top = `${Math.min(Math.max(0, e.clientY - offsetY), maxY)}px`;
    });
    bar.addEventListener("pointerup", (e: PointerEvent) => {
      dragging = false;
      bar.classList.remove("dragging");
      bar.releasePointerCapture(e.pointerId);
    });
  }

  function showStopOverlay(): void {
    if (overlayHost) return;
    overlayHost = document.createElement("div");
    overlayHost.style.all = "initial";
    const shadow = overlayHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        #bar {
          position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
          display: flex; align-items: center; gap: 8px; cursor: grab;
          background: #101828; color: #fff; border-radius: 999px;
          padding: 8px 8px 8px 14px; font: 600 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 4px 16px rgba(16,24,40,0.35); user-select: none; touch-action: none;
        }
        #bar.dragging { cursor: grabbing; }
        #dot { width: 8px; height: 8px; border-radius: 50%; background: #e11d48; animation: pulse 1.6s ease-in-out infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        button {
          all: unset; cursor: pointer; background: #e11d48; color: #fff;
          padding: 6px 12px; border-radius: 999px; font: inherit;
        }
        button:hover { filter: brightness(1.1); }
      </style>
      <div id="bar"><span id="dot"></span>Recording<button id="stop">Stop</button></div>
    `;
    shadow.getElementById("stop")!.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "POPUP_STOP_RECORDING" });
    });
    makeDraggable(shadow.getElementById("bar")!);
    document.documentElement.appendChild(overlayHost);
  }

  function hideStopOverlay(): void {
    overlayHost?.remove();
    overlayHost = null;
  }

  function beginRecording(): PageFnResult<unknown> {
    eventBuffer = [];
    cursorPos = { x: -100, y: -100 };
    stopRrweb =
      record({
        emit: queueEvent,
        sampling: { mousemove: 50, scroll: 150 },
        inlineStylesheet: true,
        collectFonts: true,
        recordCanvas: false,
        maskInputOptions: { password: true },
      }) ?? null;
    networkEventCount = 0;
    consoleEventCount = 0;
    showStopOverlay();
    return { ok: true, data: { started: true } };
  }

  function endRecording(): PageFnResult<unknown> {
    stopRrweb?.();
    stopRrweb = null;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush(true);
    hideStopOverlay();
    return { ok: true, data: { stopped: true } };
  }

  function labelFor(el: Element): string | null {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }

    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.textContent?.trim()) return label.textContent.trim();
    }

    const closestLabel = el.closest("label");
    if (closestLabel?.textContent?.trim()) return closestLabel.textContent.trim();

    const placeholder = (el as HTMLInputElement).placeholder;
    if (placeholder) return placeholder.trim();

    const title = el.getAttribute("title");
    if (title) return title.trim();

    const text = el.textContent?.trim();
    if (text) return text.slice(0, 120);

    return null;
  }

  function isInteractive(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (["input", "textarea", "select", "button", "a"].includes(tag)) return true;
    if (el.getAttribute("role") === "button" || el.getAttribute("role") === "link") return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.hasAttribute("onclick")) return true;
    return false;
  }

  function getPageInfo(): PageFnResult<unknown> {
    const map = new Map<string, Element>();
    elements = map;

    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        'input, textarea, select, button, a[href], [role="button"], [role="link"], [contenteditable="true"]'
      )
    );

    const out: Array<Record<string, unknown>> = [];
    let n = 0;
    for (const el of candidates) {
      if (out.length >= 200) break;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (!isInteractive(el)) continue;

      n += 1;
      const id = `el_${n}`;
      map.set(id, el);

      const tag = el.tagName.toLowerCase();
      out.push({
        id,
        tag,
        type: tag === "input" ? (el as HTMLInputElement).type : undefined,
        role: el.getAttribute("role"),
        label: labelFor(el),
        text: (el.textContent || "").trim().slice(0, 200),
        placeholder: (el as HTMLInputElement).placeholder || undefined,
        disabled: (el as HTMLInputElement).disabled === true,
      });
    }

    const bodyText = (document.body?.innerText || "").slice(0, 10_000);
    return { ok: true, data: { url: location.href, title: document.title, text: bodyText, elements: out } };
  }

  function resolveElement(elementId: string): PageFnResult<Element> {
    const el = elements.get(elementId);
    if (!el) {
      return { ok: false, code: "ELEMENT_NOT_FOUND", message: `No element with id ${elementId}. Call browser_get_page_info again.` };
    }
    if (!el.isConnected) {
      return { ok: false, code: "STALE_ELEMENT", message: "Element no longer exists. Call browser_get_page_info again." };
    }
    return { ok: true, data: el };
  }

  async function click(elementId: string, recording: boolean): Promise<PageFnResult<unknown>> {
    const res = resolveElement(elementId);
    if (!res.ok) return res;
    const el = res.data as HTMLElement;
    el.scrollIntoView({ block: "center" });
    if (recording) {
      await sleep(100);
      const { x, y } = centerOf(el);
      await animateCursorTo(x, y);
      await sleep(150);
      dispatchClickAt(el, x, y);
    } else {
      el.click();
    }
    return { ok: true, data: { clicked: true } };
  }

  function charDelay(): number {
    return 8 + Math.random() * 15;
  }

  async function typeText(elementId: string, text: string, recording: boolean): Promise<PageFnResult<unknown>> {
    const res = resolveElement(elementId);
    if (!res.ok) return res;
    const el = res.data as HTMLElement;
    let unhighlight: (() => void) | null = null;

    if (recording) {
      el.scrollIntoView({ block: "center" });
      const { x, y } = centerOf(el);
      await animateCursorTo(x, y);
      unhighlight = highlightElement(el);
    }

    let result: PageFnResult<unknown>;
    if (el.isContentEditable) {
      el.focus();
      if (recording) {
        el.textContent = "";
        for (const ch of text) {
          el.textContent += ch;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          await sleep(charDelay());
        }
      } else {
        el.textContent = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      result = { ok: true, data: { typed: true } };
    } else {
      const tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") {
        result = { ok: false, code: "ELEMENT_NOT_EDITABLE", message: `Element ${elementId} (${tag}) is not editable.` };
      } else {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        const proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        el.focus();
        if (recording) {
          let current = "";
          for (const ch of text) {
            current += ch;
            if (setter) setter.call(input, current);
            else input.value = current;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await sleep(charDelay());
          }
        } else {
          if (setter) setter.call(input, text);
          else input.value = text;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        input.dispatchEvent(new Event("change", { bubbles: true }));
        result = { ok: true, data: { typed: true } };
      }
    }

    if (recording) {
      await sleep(150);
      unhighlight?.();
    }
    return result;
  }

  async function scroll(direction: "up" | "down", amount: number, recording: boolean): Promise<PageFnResult<unknown>> {
    window.scrollBy({ top: direction === "down" ? amount : -amount, behavior: "smooth" });
    if (recording) await sleep(400);
    return { ok: true, data: { scrolled: true } };
  }

  async function pressKey(key: string, recording: boolean): Promise<PageFnResult<unknown>> {
    const target: HTMLElement = (document.activeElement as HTMLElement) || document.body;
    if (recording) await sleep(150);
    const opts: KeyboardEventInit = { key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    return { ok: true, data: { pressed: true } };
  }

  chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
    if (request?.target !== "browser-agent-content") return undefined;

    (async () => {
      const recording = !!request.recording;
      if (recording && request.comment) addCustomEvent("wingman-comment", { text: request.comment, action: request.op });
      switch (request.op) {
        case "getPageInfo":
          sendResponse(getPageInfo());
          break;
        case "click":
          sendResponse(await click(request.elementId!, recording));
          break;
        case "type":
          sendResponse(await typeText(request.elementId!, request.text ?? "", recording));
          break;
        case "scroll":
          sendResponse(await scroll(request.direction ?? "down", request.amount ?? 600, recording));
          break;
        case "pressKey":
          sendResponse(await pressKey(request.key ?? "", recording));
          break;
        case "recording.begin":
          sendResponse(beginRecording());
          break;
        case "recording.end":
          sendResponse(endRecording());
          break;
        default:
          sendResponse({ ok: false, code: "UNKNOWN_ACTION", message: "Unknown content op" });
      }
    })();
    return true; // responds asynchronously
  });
}
