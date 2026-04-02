import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ConnectSSH,
  DisconnectSSH,
  CancelAIChat,
  GetAppState,
  GetConnectionLabel,
  SaveChatForModel,
  SaveServers,
  StartAIChat,
  SendSSHInput,
  SetActiveAIModel,
  UpsertAIModelV3,
} from "../wailsjs/go/main/App";
import { EventsOn } from "../wailsjs/runtime/runtime";

type LinuxServer = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
};

type ChatMsgPersist = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type AIModel = {
  id: string;
  name: string;
  apiKey: string;
  baseURL?: string;
  systemPrompt?: string;
  historyLimit?: number;
  chatMessages?: ChatMsgPersist[];
};

const DEFAULT_HISTORY_LIMIT = 20;

const effectiveHistoryLimit = (m: AIModel | undefined): number => {
  const n = m?.historyLimit ?? 0;
  return n > 0 ? Math.min(200, n) : DEFAULT_HISTORY_LIMIT;
};

const toPersistPayload = (msgs: Array<{ id: string; role: "user" | "assistant"; text: string }>) =>
  msgs.map((m) => ({ id: m.id, role: m.role, text: m.text }));

const makeServerId = () => `srv-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const inputClass =
  "w-full border border-zinc-600 bg-[#252526] px-3 py-2 text-sm text-zinc-100 placeholder-zinc-400 outline-none focus:border-zinc-300";
const buttonClass =
  "border border-zinc-600 bg-[#252526] px-3 py-2 text-sm text-zinc-100 transition hover:bg-[#2d2d2d] disabled:cursor-not-allowed disabled:opacity-50";

const parseHostAndUser = (rawHost: string, fallbackUser: string): { host: string; username: string } => {
  const value = rawHost.trim();
  const fallback = fallbackUser.trim();
  const atIndex = value.lastIndexOf("@");
  if (atIndex > 0 && atIndex < value.length - 1) {
    const userFromHost = value.slice(0, atIndex).trim();
    const hostOnly = value.slice(atIndex + 1).trim();
    if (userFromHost && hostOnly) {
      return { host: hostOnly, username: userFromHost };
    }
  }
  return { host: value, username: fallback };
};

function App() {
  const [servers, setServers] = useState<LinuxServer[]>([]);
  const [activeServerId, setActiveServerId] = useState<string>("");
  const [connectionLabel, setConnectionLabel] = useState<string>("Not connected");
  const [statusText, setStatusText] = useState<string>("Ready");
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [aiModels, setAiModels] = useState<AIModel[]>([]);
  const [activeAiModelId, setActiveAiModelId] = useState<string>("");
  const [isAiSettingsOpen, setIsAiSettingsOpen] = useState<boolean>(false);
  const [aiSettingsForm, setAiSettingsForm] = useState<{
    name: string;
    apiKey: string;
    baseURL: string;
    systemPrompt: string;
    historyLimit: string;
  }>({
    name: "",
    apiKey: "",
    baseURL: "",
    systemPrompt: "",
    historyLimit: "",
  });
  const [aiStatusText, setAiStatusText] = useState<string>("");
  const [chatInput, setChatInput] = useState<string>("");
  const [chatMessages, setChatMessages] = useState<Array<{ id: string; role: "user" | "assistant"; text: string }>>(
    [],
  );
  const [activeAiRequestId, setActiveAiRequestId] = useState<string>("");
  const activeAiRequestIdRef = useRef<string>("");
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: "22",
    username: "root",
    password: "",
  });
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const connectedRef = useRef<boolean>(false);

  const activeServer = useMemo(
    () => servers.find((s) => s.id === activeServerId),
    [servers, activeServerId],
  );

  const activeAiModel = useMemo(
    () => aiModels.find((m) => m.id === activeAiModelId),
    [aiModels, activeAiModelId],
  );

  const refreshConnectionLabel = async () => {
    const label = await GetConnectionLabel();
    setConnectionLabel(label);
  };

  const appendTerminal = (text: string) => {
    terminalRef.current?.write(text);
  };

  useEffect(() => {
    connectedRef.current = isConnected;
  }, [isConnected]);

  useEffect(() => {
    activeAiRequestIdRef.current = activeAiRequestId;
  }, [activeAiRequestId]);

  useEffect(() => {
    if (!activeAiModelId) return;
    if (activeAiRequestId) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          await SaveChatForModel(activeAiModelId, toPersistPayload(chatMessages));
          setAiModels((prev) =>
            prev.map((m) =>
              m.id === activeAiModelId ? { ...m, chatMessages: toPersistPayload(chatMessages) } : m,
            ),
          );
        } catch {
          // ignore persist errors (e.g. model removed)
        }
      })();
    }, 400);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [chatMessages, activeAiModelId, activeAiRequestId]);

  useEffect(() => {
    (async () => {
      try {
        const st = await GetAppState();
        const loadedServers = (st?.servers ?? []) as LinuxServer[];
        const loadedModels = (st?.aiModels ?? []) as AIModel[];
        const loadedActiveModelId = (st?.activeAiModelId ?? "") as string;

        setServers(loadedServers);
        if (loadedServers.length > 0) {
          setActiveServerId((prev) => prev || loadedServers[0].id);
        }

        setAiModels(loadedModels);
        if (loadedModels.length > 0) {
          const pick = loadedModels.find((m) => m.id === loadedActiveModelId) ?? loadedModels[0];
          setActiveAiModelId(pick?.id ?? "");
          const raw = pick?.chatMessages ?? [];
          setChatMessages(
            raw.map((c) => ({
              id: c.id,
              role: (c.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
              text: c.text ?? "",
            })),
          );
        } else {
          setActiveAiModelId("");
          setChatMessages([]);
        }
      } catch (err: unknown) {
        const text = err instanceof Error ? err.message : String(err);
        setStatusText(`Load config failed: ${text}`);
      }
    })();
  }, []);

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#1E1E1E",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        cursorAccent: "#1E1E1E",
      },
      convertEol: false,
      scrollback: 3000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainerRef.current);
    fitAddon.fit();
    term.write("Welcome to SHBOX SSH terminal\r\nPress Connect, then type directly here.\r\n\r\n");

    const onDataDisposable = term.onData(async (data: string) => {
      if (!connectedRef.current) {
        return;
      }
      try {
        await SendSSHInput(data);
      } catch (err: unknown) {
        const text = err instanceof Error ? err.message : String(err);
        term.write(`\r\n[error] ${text}\r\n`);
        setStatusText(`Input failed: ${text}`);
      }
    });

    const onResize = () => fitAddon.fit();
    window.addEventListener("resize", onResize);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const offOutput = EventsOn("ssh:output", (chunk: string) => {
      appendTerminal(chunk ?? "");
    });
    const offError = EventsOn("ssh:error", (message: string) => {
      appendTerminal(`\r\n[error] ${message}\r\n`);
    });
    const offStatus = EventsOn("ssh:status", (message: string) => {
      appendTerminal(message ?? "");
      setIsConnected(false);
      setStatusText("Disconnected");
      setConnectionLabel("Not connected");
    });

    const offAiChunk = EventsOn("ai:chunk", (evt: { id: string; chunk: string }) => {
      if (!evt || evt.id !== activeAiRequestIdRef.current) return;
      const chunk = evt.chunk ?? "";
      if (!chunk) return;
      setChatMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.role !== "assistant") return prev;
        const next = prev.slice(0, -1);
        next.push({ ...last, text: last.text + chunk });
        return next;
      });
    });
    const offAiDone = EventsOn("ai:done", (evt: { id: string }) => {
      if (!evt || evt.id !== activeAiRequestIdRef.current) return;
      setActiveAiRequestId("");
    });
    const offAiError = EventsOn("ai:error", (evt: { id: string; message: string }) => {
      if (!evt || evt.id !== activeAiRequestIdRef.current) return;
      setActiveAiRequestId("");
      setAiStatusText(evt.message || "AI error");
    });

    return () => {
      window.removeEventListener("resize", onResize);
      onDataDisposable.dispose();
      offOutput();
      offError();
      offStatus();
      offAiChunk();
      offAiDone();
      offAiError();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  const onAddServer = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseHostAndUser(form.host, form.username);
    const host = parsed.host;
    const username = parsed.username;
    const name = form.name.trim();
    if (!host || !username) {
      setStatusText("Host and username are required");
      return;
    }

    const parsedPort = Number.parseInt(form.port, 10);
    const server: LinuxServer = {
      id: makeServerId(),
      name: name || host,
      host,
      port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22,
      username,
      password: form.password,
    };

    setServers((prev) => {
      const next = [server, ...prev];
      void SaveServers(next);
      return next;
    });
    setActiveServerId(server.id);
    if (parsed.username !== form.username.trim()) {
      setForm((prev) => ({ ...prev, username: parsed.username, host: parsed.host }));
    }
    setStatusText(`Server ${server.name} added`);
  };

  const onConnect = async () => {
    if (!activeServer) {
      setStatusText("Please select a server first");
      return;
    }
    try {
      const message = await ConnectSSH(
        activeServer.host,
        activeServer.port,
        activeServer.username,
        activeServer.password,
      );
      setStatusText(message);
      appendTerminal(`\r\n[connected] ${activeServer.username}@${activeServer.host}:${activeServer.port}\r\n`);
      setIsConnected(true);
      await refreshConnectionLabel();
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      setStatusText(`Connect failed: ${text}`);
      appendTerminal(`\r\n[error] ${text}\r\n`);
      setIsConnected(false);
    }
  };

  const onDisconnect = async () => {
    const msg = await DisconnectSSH();
    setStatusText(msg);
    appendTerminal("\r\n[disconnected]\r\n");
    setIsConnected(false);
    await refreshConnectionLabel();
  };

  const openAiSettings = () => {
    setAiStatusText("");
    setAiSettingsForm({
      name: activeAiModel?.name ?? "",
      apiKey: activeAiModel?.apiKey ?? "",
      baseURL: activeAiModel?.baseURL ?? "",
      systemPrompt: activeAiModel?.systemPrompt ?? "",
      historyLimit:
        activeAiModel?.historyLimit && activeAiModel.historyLimit > 0
          ? String(activeAiModel.historyLimit)
          : "",
    });
    setIsAiSettingsOpen(true);
  };

  const onSaveAiSettings = async () => {
    setAiStatusText("");
    try {
      const limRaw = aiSettingsForm.historyLimit.trim();
      const limParsed = parseInt(limRaw, 10);
      const historyLimit =
        limRaw !== "" && Number.isFinite(limParsed) && limParsed > 0 ? Math.min(200, limParsed) : 0;
      const model = await UpsertAIModelV3(
        aiSettingsForm.name,
        aiSettingsForm.apiKey,
        aiSettingsForm.baseURL,
        aiSettingsForm.systemPrompt,
        historyLimit,
      );
      const saved = model as AIModel;
      setAiModels((prev) => {
        const without = prev.filter((m) => m.id !== saved.id && m.name.toLowerCase() !== saved.name.toLowerCase());
        return [saved, ...without];
      });
      setActiveAiModelId(saved.id);
      setIsAiSettingsOpen(false);
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      setAiStatusText(text);
    }
  };

  const onPickAiModel = async (id: string) => {
    if (id === activeAiModelId) return;
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const prevId = activeAiModelId;
    const prevMsgs = chatMessages;
    try {
      if (prevId) {
        await SaveChatForModel(prevId, toPersistPayload(prevMsgs));
        setAiModels((prev) =>
          prev.map((m) => (m.id === prevId ? { ...m, chatMessages: toPersistPayload(prevMsgs) } : m)),
        );
      }
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      setAiStatusText(text);
    }
    setActiveAiModelId(id);
    const next = aiModels.find((m) => m.id === id);
    setChatMessages(
      (next?.chatMessages ?? []).map((c) => ({
        id: c.id,
        role: (c.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        text: c.text ?? "",
      })),
    );
    try {
      await SetActiveAIModel(id);
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      setAiStatusText(text);
    }
  };

  const onNewChat = () => {
    if (activeAiRequestId) {
      setAiStatusText("Stop generation first");
      return;
    }
    setChatMessages([]);
    setAiStatusText("");
    if (!activeAiModelId) return;
    void (async () => {
      try {
        await SaveChatForModel(activeAiModelId, []);
        setAiModels((prev) => prev.map((m) => (m.id === activeAiModelId ? { ...m, chatMessages: [] } : m)));
      } catch (err: unknown) {
        const text = err instanceof Error ? err.message : String(err);
        setAiStatusText(text);
      }
    })();
  };

  const onSendChat = async () => {
    const text = chatInput.trim();
    if (!text) return;
    if (activeAiRequestId) {
      setAiStatusText("AI is still generating…");
      return;
    }
    setChatInput("");
    setAiStatusText("");
    const userMsgId = `m-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const assistantMsgId = `m-${Date.now()}-${Math.floor(Math.random() * 1000)}-a`;
    const snapshot = [...chatMessages, { id: userMsgId, role: "user" as const, text }];
    setChatMessages((prev) => [...prev, { id: userMsgId, role: "user", text }, { id: assistantMsgId, role: "assistant", text: "" }]);

    try {
      const limit = effectiveHistoryLimit(activeAiModel);
      const history: Array<{ role: string; content: string }> = [];
      const sys = activeAiModel?.systemPrompt?.trim();
      if (sys) {
        history.push({ role: "system", content: sys });
      }
      const tail = snapshot
        .filter((m) => m.text.trim() !== "")
        .slice(-limit);
      for (const m of tail) {
        history.push({ role: m.role, content: m.text });
      }
      const reqId = await StartAIChat(history);
      setActiveAiRequestId(reqId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setAiStatusText(msg);
      setChatMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.id !== assistantMsgId) return prev;
        const next = prev.slice(0, -1);
        next.push({ ...last, text: `Error: ${msg}` });
        return next;
      });
    }
  };

  const onStopChat = async () => {
    const id = activeAiRequestIdRef.current;
    if (!id) return;
    try {
      await CancelAIChat(id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setAiStatusText(msg);
    } finally {
      setActiveAiRequestId("");
    }
  };

  return (
    <div className="flex h-screen flex-col bg-[#1E1E1E] text-zinc-100">
      <header className="flex h-14 items-center justify-between border-b border-zinc-800 bg-[#1E1E1E] px-4">
        <div className="text-base font-semibold tracking-wide">SSH</div>
        <div className="text-xs text-zinc-200">{connectionLabel}</div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[300px_1fr_320px]">
        <aside className="flex min-h-0 flex-col gap-3 border-r border-zinc-800 bg-[#1E1E1E] p-3">
          <div className="text-sm font-semibold text-zinc-200">Servers</div>
          <form className="flex flex-col gap-2" onSubmit={onAddServer}>
            <input
              className={inputClass}
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm((v) => ({ ...v, name: e.target.value }))}
            />
            <input
              className={inputClass}
              placeholder="Host / IP (supports root@192.168.1.10)"
              value={form.host}
              onChange={(e) => setForm((v) => ({ ...v, host: e.target.value }))}
            />
            <div className="grid grid-cols-[80px_1fr] gap-2">
              <input
                className={inputClass}
                placeholder="Port"
                value={form.port}
                onChange={(e) => setForm((v) => ({ ...v, port: e.target.value }))}
              />
              <input
                className={inputClass}
                placeholder="Username"
                value={form.username}
                onChange={(e) => setForm((v) => ({ ...v, username: e.target.value }))}
              />
            </div>
            <input
              className={inputClass}
              placeholder="Password"
              type="password"
              value={form.password}
              onChange={(e) => setForm((v) => ({ ...v, password: e.target.value }))}
            />
            <button className={buttonClass} type="submit">
              Add Linux Server
            </button>
          </form>

          <div className="flex min-h-0 flex-col gap-2 overflow-auto">
            {servers.length === 0 && <div className="text-xs text-zinc-300">No servers yet</div>}
            {servers.map((s) => (
              <button
                className={`border px-3 py-2 text-left transition ${
                  s.id === activeServerId
                    ? "border-zinc-200 bg-[#2d2d2d] text-white"
                    : "border-zinc-800 bg-[#1E1E1E] text-zinc-100 hover:bg-[#2a2a2a]"
                }`}
                key={s.id}
                onClick={() => setActiveServerId(s.id)}
                type="button"
              >
                <div>{s.name}</div>
                <small className={s.id === activeServerId ? "text-zinc-100" : "text-zinc-300"}>
                  {s.username}@{s.host}:{s.port}
                </small>
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col border-r border-zinc-800 bg-[#1E1E1E]">
          <div className="flex h-14 items-center justify-between border-b border-zinc-800 px-3">
            <span>SSH Terminal</span>
            <div className="flex gap-2">
              <button className={buttonClass} type="button" onClick={onConnect}>
                Connect
              </button>
              <button className={buttonClass} type="button" onClick={onDisconnect}>
                Disconnect
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 p-3">
            <div
              ref={terminalContainerRef}
              className="h-full w-full border border-zinc-800 bg-[#1E1E1E]"
            />
          </div>

          <div className="px-3 pb-3 text-left text-xs text-zinc-200">{statusText}</div>
        </section>

        <aside className="flex min-h-0 flex-col gap-3 bg-[#1E1E1E] p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-zinc-200">AI Agent</div>
            <div className="flex items-center gap-1">
              <button
                className="border border-zinc-800 bg-[#1E1E1E] px-2 py-1 text-xs text-zinc-100 hover:bg-[#2a2a2a] disabled:opacity-50"
                type="button"
                title="New chat (per model)"
                onClick={onNewChat}
                disabled={!activeAiModelId || !!activeAiRequestId}
              >
                New chat
              </button>
              <button
                className="h-8 w-8 border border-zinc-800 bg-[#1E1E1E] text-zinc-100 hover:bg-[#2a2a2a]"
                type="button"
                title="Settings"
                onClick={openAiSettings}
              >
                ⋯
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col bg-[#1E1E1E]">
            <div className="min-h-0 flex-1 overflow-auto p-3 text-left text-sm text-zinc-200">
              {chatMessages.length === 0 ? (
                <div className="text-xs text-zinc-300">
                  先点右上角 “⋯” 添加你的模型（名称 + API key），然后在左下角切换模型。
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {chatMessages.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[95%] whitespace-pre-wrap border px-3 py-2 text-sm ${
                        m.role === "user"
                          ? "self-end border-zinc-700 bg-[#2d2d2d] text-zinc-100"
                          : "self-start border-zinc-800 bg-[#252526] text-zinc-100"
                      }`}
                    >
                      {m.text}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-zinc-800 p-2">
              <div className="grid grid-cols-[1fr_72px] gap-2">
                <input
                  className={inputClass}
                  placeholder="Ask AI..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void onSendChat();
                    }
                  }}
                />
                {activeAiRequestId ? (
                  <button className={buttonClass} type="button" onClick={() => void onStopChat()}>
                    Stop
                  </button>
                ) : (
                  <button className={buttonClass} type="button" onClick={() => void onSendChat()}>
                    Send
                  </button>
                )}
              </div>

              <div className="mt-2 flex items-center justify-between text-xs text-zinc-200">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-300">Model</span>
                  <select
                    className="appearance-none bg-transparent px-1 py-1 text-xs text-zinc-100 outline-none"
                    value={activeAiModelId}
                    onChange={(e) => void onPickAiModel(e.target.value)}
                    disabled={aiModels.length === 0}
                  >
                    {aiModels.length === 0 ? (
                      <option value="">No models</option>
                    ) : (
                      aiModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div className="truncate text-zinc-300">
                  {activeAiRequestId
                    ? "Generating…"
                    : aiStatusText
                      ? aiStatusText
                      : activeAiModel
                        ? `Using ${activeAiModel.name}`
                        : "No model selected"}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </main>

      {isAiSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div className="w-full max-w-md border border-zinc-800 bg-[#1E1E1E] p-4 text-zinc-100 shadow-xl">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">AI Model Settings</div>
              <button
                className="h-8 w-8 border border-zinc-800 bg-[#1E1E1E] hover:bg-[#2a2a2a]"
                type="button"
                onClick={() => setIsAiSettingsOpen(false)}
                title="Close"
              >
                ×
              </button>
            </div>

            <div className="mt-3 flex flex-col gap-2">
              <label className="text-xs text-zinc-300">Model name</label>
              <input
                className={inputClass}
                placeholder="e.g. gpt-4o / deepseek / claude..."
                value={aiSettingsForm.name}
                onChange={(e) => setAiSettingsForm((v) => ({ ...v, name: e.target.value }))}
              />

              <label className="mt-2 text-xs text-zinc-300">Base URL (optional)</label>
              <input
                className={inputClass}
                placeholder="https://api.openai.com  or  http://localhost:11434"
                value={aiSettingsForm.baseURL}
                onChange={(e) => setAiSettingsForm((v) => ({ ...v, baseURL: e.target.value }))}
              />

              <label className="mt-2 text-xs text-zinc-300">API key</label>
              <input
                className={inputClass}
                placeholder="sk-..."
                type="password"
                value={aiSettingsForm.apiKey}
                onChange={(e) => setAiSettingsForm((v) => ({ ...v, apiKey: e.target.value }))}
              />

              <label className="mt-2 text-xs text-zinc-300">System prompt (optional)</label>
              <textarea
                className={`${inputClass} min-h-[88px] resize-y`}
                placeholder="You are a helpful assistant…"
                value={aiSettingsForm.systemPrompt}
                onChange={(e) => setAiSettingsForm((v) => ({ ...v, systemPrompt: e.target.value }))}
              />

              <label className="mt-2 text-xs text-zinc-300">Context messages (optional)</label>
              <input
                className={inputClass}
                placeholder={`Empty = ${DEFAULT_HISTORY_LIMIT} (max 200)`}
                value={aiSettingsForm.historyLimit}
                onChange={(e) => setAiSettingsForm((v) => ({ ...v, historyLimit: e.target.value.replace(/[^\d]/g, "") }))}
              />
              <div className="text-[11px] text-zinc-400">
                How many recent user/assistant pairs to send (not counting system). Each model has its own saved chat.
              </div>

              {aiStatusText && <div className="mt-1 text-xs text-red-200">{aiStatusText}</div>}

              <div className="mt-3 flex justify-end gap-2">
                <button className={buttonClass} type="button" onClick={() => setIsAiSettingsOpen(false)}>
                  Cancel
                </button>
                <button className={buttonClass} type="button" onClick={() => void onSaveAiSettings()}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
