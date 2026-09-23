import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentToolUpdateCallback,
  ExtensionContext,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

// -----------------------------------------------------------------------------
// Model gating
// -----------------------------------------------------------------------------

const WEB_SEARCH_TOOL = "web_search";

function isSupportedWebSearchModel(model: Model<any> | undefined): model is Model<any> {
  // openai-codex is enabled experimentally so the tool can be tested with
  // Codex models. The request still uses the Copilot SDK backend below.
  return !!model && (model.provider === "github-copilot" || model.provider === "openai-codex");
}

function setEquals<T>(a: Set<T>, b: Set<T>) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function missingConfigResult(ctx: ExtensionContext, kind: string) {
  const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
  return {
    content: [{ type: "text" as const, text: `Failed: ${kind} is only available on GitHub Copilot or OpenAI Codex models. Current model: ${current}.` }],
    details: { error: "unsupported_model", kind },
  };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: { error: true } };
}

// -----------------------------------------------------------------------------
// Active tool manager
// -----------------------------------------------------------------------------

function createModelScopedToolManager(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {
  let preferredActiveTools: Set<string> | undefined;
  let lastAppliedActiveTools: Set<string> | undefined;
  let suppressedTools = new Set<string>();

  const sync = (model: Model<any> | undefined) => {
    const currentActiveTools = new Set(pi.getActiveTools());

    if (!preferredActiveTools) {
      preferredActiveTools = new Set(currentActiveTools);
    } else if (lastAppliedActiveTools) {
      for (const tool of currentActiveTools) {
        if (!lastAppliedActiveTools.has(tool)) preferredActiveTools.add(tool);
      }
      for (const tool of lastAppliedActiveTools) {
        if (!currentActiveTools.has(tool) && !suppressedTools.has(tool)) {
          preferredActiveTools.delete(tool);
        }
      }
    }

    const desiredActiveTools = new Set(preferredActiveTools);
    suppressedTools = new Set<string>();

    if (!isSupportedWebSearchModel(model)) {
      desiredActiveTools.delete(WEB_SEARCH_TOOL);
      if (preferredActiveTools.has(WEB_SEARCH_TOOL)) suppressedTools.add(WEB_SEARCH_TOOL);
    }

    if (!setEquals(currentActiveTools, desiredActiveTools)) {
      pi.setActiveTools(Array.from(desiredActiveTools));
    }
    lastAppliedActiveTools = new Set(desiredActiveTools);
  };

  return { sync };
}

type CopilotSdkModule = {
  CopilotClient: new (options?: any) => {
    start(): Promise<void>;
    stop(): Promise<any>;
    createSession(config: any): Promise<any>;
  };
  approveAll: any;
};

let copilotSdkPromise: Promise<CopilotSdkModule> | undefined;
let copilotClientPromise: Promise<any> | undefined;

function uniqueStrings(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.filter((value): value is string => !!value)));
}

function resolveNpmGlobalRoot(): string | undefined {
  try {
    const value = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function getCopilotSdkCandidatePaths() {
  const require = createRequire(import.meta.url);
  const candidates: string[] = [];

  try {
    const sdkEntry = require.resolve("@github/copilot/sdk");
    candidates.push(join(dirname(dirname(sdkEntry)), "copilot-sdk", "index.js"));
  } catch {
    // Ignore and continue to global fallbacks.
  }

  const globalRoot = resolveNpmGlobalRoot();
  if (globalRoot) candidates.push(join(globalRoot, "@github", "copilot", "copilot-sdk", "index.js"));

  if (process.env.HOME) {
    candidates.push(join(process.env.HOME, ".npm-global", "lib", "node_modules", "@github", "copilot", "copilot-sdk", "index.js"));
    candidates.push(join(process.env.HOME, ".local", "share", "pnpm", "global", "5", "node_modules", "@github", "copilot", "copilot-sdk", "index.js"));
  }

  return uniqueStrings(candidates);
}

async function loadCopilotSdk(): Promise<CopilotSdkModule> {
  if (!copilotSdkPromise) {
    copilotSdkPromise = (async () => {
      const errors: string[] = [];

      try {
        return (await import("@github/copilot-sdk")) as unknown as CopilotSdkModule;
      } catch (error: any) {
        errors.push(`@github/copilot-sdk: ${error?.message || String(error)}`);
      }

      for (const candidate of getCopilotSdkCandidatePaths()) {
        if (!existsSync(candidate)) continue;
        try {
          return (await import(pathToFileURL(candidate).href)) as unknown as CopilotSdkModule;
        } catch (error: any) {
          errors.push(`${candidate}: ${error?.message || String(error)}`);
        }
      }

      throw new Error(
        `Unable to load the GitHub Copilot SDK. Install @github/copilot and ensure its internal copilot-sdk is available. Tried: ${errors.join(" | ")}`,
      );
    })().catch((error) => {
      copilotSdkPromise = undefined;
      throw error;
    });
  }

  return copilotSdkPromise;
}

async function getCopilotClient() {
  if (!copilotClientPromise) {
    copilotClientPromise = (async () => {
      const sdk = await loadCopilotSdk();
      const client = new sdk.CopilotClient({
        autoStart: true,
        logLevel: "error",
        useLoggedInUser: true,
      });
      await client.start();
      return client;
    })().catch((error) => {
      copilotClientPromise = undefined;
      throw error;
    });
  }

  return copilotClientPromise;
}

function collectMarkdownSources(text: string, sources: Array<{ title: string; url: string }>) {
  const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of text.matchAll(markdownLinkRegex)) {
    pushUniqueSource(sources, match[1].trim() || titleFromUrl(match[2]), match[2]);
  }
}

function buildCopilotWebSearchPrompt(params: WebSearchInput) {
  const urlBlock = params.urls?.length
    ? `\n\nThe user also provided specific URLs. You must inspect them with web_fetch before answering:\n${params.urls.join("\n")}`
    : "";

  return [
    "You are fulfilling a web_search tool call inside GitHub Copilot.",
    "Use the built-in web_fetch tool to gather fresh public web information as needed.",
    "Answer the user's question directly and include a final '## Sources' section with markdown links for the sources you actually relied on.",
    "Prefer authoritative and current sources.",
    "Do not mention internal tool mechanics unless necessary.",
    `\nUser request: ${params.query}${urlBlock}`,
  ].join("\n");
}

async function callCopilotSdkWebSearch(
  model: Model<any>,
  params: WebSearchInput,
  onUpdate: AgentToolUpdateCallback | undefined,
  signal?: AbortSignal,
) {
  const sdk = await loadCopilotSdk();
  const client = await getCopilotClient();
  const session = await client.createSession({
    clientName: "pi-github-copilot-web-search",
    model: model.id,
    onPermissionRequest: sdk.approveAll,
    availableTools: ["web_fetch", "report_intent"],
    workingDirectory: process.cwd(),
    streaming: true,
  });

  let latestText = "";
  let sessionError: Error | undefined;
  const sources: Array<{ title: string; url: string }> = [];
  const fetchedUrls: string[] = [];
  const toolCalls = new Map<string, string | undefined>();

  const unsubscribe = session.on((event: any) => {
    if (event.type === "assistant.message") {
      const content = event.data?.content;
      if (typeof content === "string" && content.trim()) {
        latestText = content;
        collectMarkdownSources(content, sources);
        onUpdate?.({ content: [{ type: "text", text: content }], details: { streaming: true } });
      }
      return;
    }

    if (event.type === "tool.execution_start") {
      toolCalls.set(event.data?.toolCallId, event.data?.toolName);
      if (event.data?.toolName === "web_fetch") {
        const url = event.data?.arguments?.url;
        if (typeof url === "string" && !fetchedUrls.includes(url)) fetchedUrls.push(url);
        const status = typeof url === "string" ? `Fetching ${url}...` : "Fetching web content...";
        onUpdate?.({ content: [{ type: "text", text: latestText || status }], details: { streaming: true, fetching: url } });
      } else if (event.data?.toolName === "report_intent") {
        const intent = event.data?.arguments?.intent;
        onUpdate?.({
          content: [{ type: "text", text: latestText || (typeof intent === "string" ? intent : "Searching the web...") }],
          details: { streaming: true, searching: true },
        });
      }
      return;
    }

    if (event.type === "tool.execution_complete") {
      const toolCallId = event.data?.toolCallId;
      const toolName = toolCalls.get(toolCallId);
      toolCalls.delete(toolCallId);
      if (toolName === "web_fetch") {
        const content = event.data?.result?.content;
        if (typeof content === "string") collectMarkdownSources(content, sources);
      }
      return;
    }

    if (event.type === "session.error") {
      sessionError = new Error(event.data?.message || "GitHub Copilot session error");
    }
  });

  const abortHandler = () => {
    try {
      session.abort();
    } catch {
      // Ignore abort cleanup issues.
    }
  };

  try {
    if (signal?.aborted) throw new Error("Request was aborted");
    signal?.addEventListener("abort", abortHandler, { once: true });

    const finalEvent = await session.sendAndWait({ prompt: buildCopilotWebSearchPrompt(params) }, 180000);
    if (sessionError) throw sessionError;

    const finalText = finalEvent?.data?.content;
    if (typeof finalText === "string" && finalText.trim()) {
      latestText = finalText;
      collectMarkdownSources(finalText, sources);
    }

    if (sources.length === 0) {
      for (const url of params.urls || fetchedUrls) {
        pushUniqueSource(sources, titleFromUrl(url), url);
      }
    }

    return {
      text: latestText || "No answer available.",
      sources,
      searchQueries: [params.query],
      searchResults: sources.map((source) => ({ ...source, source: "copilot-sdk" })),
      fetchedUrls,
    };
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    unsubscribe();
    await session.disconnect().catch(() => {});
  }
}

function pushUniqueSource(sources: Array<{ title: string; url: string }>, title: string, url: string) {
  if (!url) return;
  if (sources.some((s) => s.url === url && s.title === title)) return;
  sources.push({ title, url });
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatResult(text: string, details: any) {
  const truncated = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  return {
    content: [{ type: "text" as const, text: truncated.content + (truncated.truncated ? "\n\n[Truncated]" : "") }],
    details,
  };
}

// -----------------------------------------------------------------------------
// Tool schemas
// -----------------------------------------------------------------------------

export const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query or question" }),
  urls: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional URLs to analyze alongside the search",
      maxItems: 20,
    }),
  ),
});
export type WebSearchInput = Static<typeof WebSearchSchema>;

// -----------------------------------------------------------------------------
// Tool implementations
// -----------------------------------------------------------------------------

async function webSearch(
  _id: string,
  params: WebSearchInput,
  signal: AbortSignal,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
) {
  const model = ctx.model;
  if (!isSupportedWebSearchModel(model)) return missingConfigResult(ctx, WEB_SEARCH_TOOL);

  onUpdate?.({
    content: [{ type: "text", text: params.urls?.length ? `Searching and analyzing ${params.urls.length} URL(s)...` : `Searching for "${params.query}"...` }],
    details: {},
  });

  try {
    const result = await callCopilotSdkWebSearch(model, params, onUpdate, signal);

    const sources = result.sources || [];
    let summary = result.text;

    if (sources.length > 0 && !/\n## Sources\b/i.test(summary)) {
      summary += `\n\n## Sources\n${sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`;
    }

    return formatResult(summary, {
      sources,
      searchQueries: result.searchQueries,
      searchResults: result.searchResults,
      fetchedUrls: result.fetchedUrls,
      model: model.id,
      grounded: sources.length > 0,
    });
  } catch (e: any) {
    return errorResult(e?.message || String(e));
  }
}

// -----------------------------------------------------------------------------
// Extension entrypoint
// -----------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: WEB_SEARCH_TOOL,
    label: "Web Search",
    description: "Search the web using the current GitHub Copilot or OpenAI Codex model.",
    promptSnippet: "Search the web using the current GitHub Copilot or OpenAI Codex model.",
    promptGuidelines: ["Use web_search when you need fresh web information while using a GitHub Copilot or OpenAI Codex model."],
    parameters: WebSearchSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return webSearch(toolCallId, params as WebSearchInput, signal, onUpdate, ctx);
    },
  });

  const toolManager = createModelScopedToolManager(pi);
  pi.on("session_start", (_event, ctx) => toolManager.sync(ctx.model));
  pi.on("model_select", (event) => toolManager.sync(event.model));
}
