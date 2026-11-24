"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const engine = require("./repromptEngine");
const { Orchestrator } = require("./orchestrator");

const SETTINGS_KEY = "reprompt.settings.v1";
const HISTORY_KEY = "reprompt.history.v1";
const ORCH_USAGE_KEY = "reprompt.orchestrator.usage.v1";
const MAX_HISTORY = 50;

const SECRET_PROVIDERS = ["gemini", "anthropic", "openai"];
const SECRET_KEYS = Object.fromEntries(
  SECRET_PROVIDERS.map((p) => [`${p}ApiKey`, `reprompt.secret.${p}ApiKey`])
);

// P2-272 4B: the folder a queued Gemini task belongs to (its git root is found by the orchestrator).
function wkWorkspaceFolder() {
  const f = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return f && f.uri && f.uri.fsPath ? f.uri.fsPath : "";
}

function getWebviewHtml(extensionPath) {
  const htmlPath = path.join(extensionPath, "media", "reprompt_app.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  const cspMeta =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">';
  html = html.replace("<head>", `<head>\n${cspMeta}`);
  return html;
}

function collectWorkspaceContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return { workspaceContext: "", contextLabel: "" };
  }
  const doc = editor.document;
  const relPath = vscode.workspace.asRelativePath(doc.uri, false) || path.basename(doc.fileName);
  const lang = doc.languageId || "text";
  const sel = editor.selection;

  if (sel && !sel.isEmpty) {
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;
    const rawText = doc.getText(sel);
    const lines = rawText.split(/\r?\n/);
    const truncated = lines.slice(0, 120).join("\n").slice(0, 4000);
    const note = lines.length > 120 || rawText.length > 4000 ? "\n... [truncated]" : "";
    return {
      contextLabel: `${relPath} (L${startLine}-${endLine})`,
      workspaceContext: `Active file: ${relPath} (${lang}, lines ${startLine}-${endLine})\nSelected snippet:\n\`\`\`${lang}\n${truncated}${note}\n\`\`\``,
    };
  }

  return {
    contextLabel: relPath,
    workspaceContext: `Active file: ${relPath} (${lang})`,
  };
}

class RePromptController {
  constructor(context) {
    this.context = context;
    this.views = new Set();
    this.overlayPanel = null;
    this.overlayDetached = false;
    this.ctxTimer = null;
    this.pendingInitialState = null;
    this.orchestrator = new Orchestrator({
      loadState: () => this.context.globalState.get(ORCH_USAGE_KEY),
      saveState: (st) => this.context.globalState.update(ORCH_USAGE_KEY, st),
      getSecrets: () => this.getSecrets(),
    });
  }

  getSettings() {
    const saved = this.context.globalState.get(SETTINGS_KEY) || {};
    return { ...engine.DEFAULT_SETTINGS, ...saved };
  }

  async getSecrets() {
    const [geminiApiKey, anthropicApiKey, openaiApiKey] = await Promise.all([
      this.context.secrets.get(SECRET_KEYS.geminiApiKey),
      this.context.secrets.get(SECRET_KEYS.anthropicApiKey),
      this.context.secrets.get(SECRET_KEYS.openaiApiKey),
    ]);
    return {
      geminiApiKey: geminiApiKey || "",
      anthropicApiKey: anthropicApiKey || "",
      openaiApiKey: openaiApiKey || "",
    };
  }

  async getPublicSettings() {
    const s = this.getSettings();
    const secrets = await this.getSecrets();
    return {
      ...s,
      hasGeminiApiKey: Boolean(secrets.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      hasAnthropicApiKey: Boolean(secrets.anthropicApiKey || process.env.ANTHROPIC_API_KEY),
      hasOpenaiApiKey: Boolean(secrets.openaiApiKey || process.env.OPENAI_API_KEY),
    };
  }

  getHistory() {
    const list = this.context.globalState.get(HISTORY_KEY);
    return Array.isArray(list) ? list.slice(0, MAX_HISTORY) : [];
  }

  async addHistory(entry) {
    const record = {
      id: crypto.randomBytes(6).toString("hex"),
      timestamp: new Date().toISOString(),
      original: entry.original,
      rewritten: entry.rewritten_prompt,
      summary: entry.summary,
      improvements: entry.improvements || [],
      target: entry.target,
      mode: entry.mode,
      provider: entry.provider,
      model: entry.model,
      duration_ms: entry.duration_ms || 0,
    };
    const next = [record, ...this.getHistory()].slice(0, MAX_HISTORY);
    await this.context.globalState.update(HISTORY_KEY, next);
    return next;
  }

  async buildStatePayload(extra = {}) {
    const [settings, ctx, orchStatus] = await Promise.all([
      this.getPublicSettings(),
      Promise.resolve(collectWorkspaceContext()),
      this.orchestrator.status(),
    ]);
    return {
      settings,
      providers: engine.getProviderStatuses(),
      history: this.getHistory(),
      orchestrator: orchStatus,
      workspaceContext: ctx.workspaceContext,
      contextLabel: ctx.contextLabel,
      ...extra,
    };
  }

  broadcast(event, data) {
    const msg = { type: "event", event, data };
    for (const wv of this.views) {
      try {
        wv.postMessage(msg);
      } catch (_) {}
    }
    if (this.overlayPanel) {
      try {
        this.overlayPanel.webview.postMessage(msg);
      } catch (_) {}
    }
  }

  pushContextUpdate() {
    if (this.ctxTimer) clearTimeout(this.ctxTimer);
    this.ctxTimer = setTimeout(() => {
      const ctx = collectWorkspaceContext();
      this.broadcast("contextUpdate", ctx);
    }, 250);
  }

  async saveSettings(updates) {
    const current = this.getSettings();
    const strKeys = [
      "provider",
      "agyModel",
      "claudeModel",
      "geminiModel",
      "anthropicModel",
      "openaiModel",
      "openaiBaseUrl",
      "defaultTarget",
      "defaultMode",
    ];
    for (const k of strKeys) {
      if (typeof updates[k] === "string") current[k] = updates[k].trim();
    }
    if (typeof updates.autoRewrite === "boolean") current.autoRewrite = updates.autoRewrite;
    if (typeof updates.includeWorkspaceContext === "boolean") {
      current.includeWorkspaceContext = updates.includeWorkspaceContext;
    }
    if (typeof updates.openInFloatingWindow === "boolean") {
      current.openInFloatingWindow = updates.openInFloatingWindow;
    }
    if (typeof updates.hookAutoAll === "boolean") {
      current.hookAutoAll = updates.hookAutoAll;
    }
    if (typeof updates.enableSkillRouting === "boolean") {
      current.enableSkillRouting = updates.enableSkillRouting;
    }
    if (updates.autoRewriteDelayMs !== undefined) {
      const n = Number(updates.autoRewriteDelayMs);
      if (Number.isFinite(n)) current.autoRewriteDelayMs = Math.max(400, Math.min(5000, Math.round(n)));
    }
    await this.context.globalState.update(SETTINGS_KEY, current);

    for (const [field, clearFlag] of [
      ["geminiApiKey", "clearGeminiApiKey"],
      ["anthropicApiKey", "clearAnthropicApiKey"],
      ["openaiApiKey", "clearOpenaiApiKey"],
    ]) {
      if (updates[clearFlag]) {
        await this.context.secrets.delete(SECRET_KEYS[field]);
      } else if (typeof updates[field] === "string" && updates[field].trim()) {
        await this.context.secrets.store(SECRET_KEYS[field], updates[field].trim());
      }
    }

    const state = await this.buildStatePayload();
    this.broadcast("stateUpdate", state);
    return state;
  }

  async sendToAntigravity(text) {
    await vscode.env.clipboard.writeText(text);
    const cmds = new Set(await vscode.commands.getCommands(true));

    // Try standard VS Code / Antigravity chat query command first
    if (cmds.has("workbench.action.chat.open")) {
      try {
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: text,
          isPartialQuery: true,
        });
        vscode.window.setStatusBarMessage("Re-Prompt: Inserted into chat & copied to clipboard", 4000);
        return { message: "Inserted into chat input (and copied to clipboard)." };
      } catch (_) {}
    }

    const focusCandidates = [
      "workbench.action.chat.focusInput",
      "workbench.panel.chat.view.copilot.focus",
      "antigravity.openChat",
      "antigravity.chat.focus",
      "antigravity.focusChat",
      "cascade.focus",
    ];
    for (const c of focusCandidates) {
      if (cmds.has(c)) {
        try {
          await vscode.commands.executeCommand(c);
          return { message: "Copied to clipboard & focused Antigravity Chat — press Ctrl+V (Cmd+V) to paste." };
        } catch (_) {}
      }
    }

    // Dynamic scan for any Antigravity chat focus command
    for (const c of cmds) {
      if (/(?:antigravity|cascade).*chat.*(?:open|focus)/i.test(c)) {
        try {
          await vscode.commands.executeCommand(c);
          return { message: "Copied to clipboard & focused Antigravity Chat — press Ctrl+V (Cmd+V) to paste." };
        } catch (_) {}
      }
    }

    return { message: "Prompt copied to clipboard — paste into Antigravity Chat (Ctrl+V / Cmd+V)." };
  }

  async sendToAntigravityNewSession(text) {
    await vscode.env.clipboard.writeText(text);
    const cmds = new Set(await vscode.commands.getCommands(true));

    if (cmds.has("workbench.action.chat.newChat")) {
      try {
        await vscode.commands.executeCommand("workbench.action.chat.newChat");
        if (cmds.has("workbench.action.chat.open")) {
          await vscode.commands.executeCommand("workbench.action.chat.open", {
            query: text,
            isPartialQuery: true,
          });
          vscode.window.setStatusBarMessage("Re-Prompt: Started new chat & copied prompt", 4000);
          return { message: "Started new chat & inserted prompt (also copied to clipboard)." };
        }
        return { message: "Started new chat & copied prompt — press Ctrl+V (Cmd+V) to paste." };
      } catch (_) {}
    }

    const focusCandidates = [
      "workbench.action.chat.focusInput",
      "workbench.panel.chat.view.copilot.focus",
      "antigravity.openChat",
      "antigravity.chat.focus",
      "antigravity.focusChat",
      "cascade.focus",
    ];
    for (const c of focusCandidates) {
      if (cmds.has(c)) {
        try {
          await vscode.commands.executeCommand(c);
          return { message: "Copied prompt & focused chat — start a new session and press Ctrl+V (Cmd+V) to paste." };
        } catch (_) {}
      }
    }

    return { message: "Prompt copied to clipboard — open a new chat session and press Ctrl+V (Cmd+V) to paste." };
  }

  async sendToClaudeCode(text) {
    await vscode.env.clipboard.writeText(text);
    const cmds = new Set(await vscode.commands.getCommands(true));

    const claudeCommands = [
      "claude-vscode.focus",
      "claude-vscode.editor.open",
      "claude-vscode.sidebar.open",
      "claude-vscode.open",
      "claude-code.open",
      "claude-code.focus",
    ];
    for (const c of claudeCommands) {
      if (cmds.has(c)) {
        try {
          await vscode.commands.executeCommand(c);
          return { message: "Copied prompt & focused Claude Code — press Ctrl+V (Cmd+V) to paste." };
        } catch (_) {}
      }
    }
    for (const c of cmds) {
      if (/^claude[-_.].*(?:open|focus)/i.test(c)) {
        try {
          await vscode.commands.executeCommand(c);
          return { message: "Copied prompt & focused Claude Code — press Ctrl+V (Cmd+V) to paste." };
        } catch (_) {}
      }
    }

    const claudeTerm = vscode.window.terminals.find((t) => /claude/i.test(t.name));
    if (claudeTerm) {
      claudeTerm.show(false);
      vscode.window
        .showInformationMessage("Re-Prompt copied to clipboard for Claude Code terminal.", "Paste into Terminal")
        .then((choice) => {
          if (choice === "Paste into Terminal") {
            claudeTerm.sendText(text, false);
          }
        });
      return { message: "Focused Claude Code terminal & copied prompt to clipboard." };
    }

    return { message: "Prompt copied to clipboard — open Claude Code chat or terminal and paste (Ctrl+V / Cmd+V)." };
  }

  async handleWebviewMessage(webview, msg) {
    if (!msg || msg.type !== "request") return;
    const { id, method, params = {} } = msg;
    const reply = (result, error = null) => {
      try {
        webview.postMessage({ type: "response", id, result, error });
      } catch (_) {}
    };

    try {
      if (method === "getState") {
        const extra = this.pendingInitialState || {};
        this.pendingInitialState = null;
        reply(await this.buildStatePayload(extra));
      } else if (method === "saveSettings") {
        reply(await this.saveSettings(params));
      } else if (method === "rewrite") {
        const [settings, secrets] = await Promise.all([this.getSettings(), this.getSecrets()]);
        const res = await engine.rewriteWithProvider({
          settings,
          secrets,
          prompt: params.prompt,
          target: params.target,
          mode: params.mode,
          workspaceContext: params.workspace_context || "",
          refinement: params.refinement || "",
          previousRewritten: params.previous_rewritten || "",
        });
        const history = await this.addHistory(res);
        reply({ ...res, history });
      } else if (method === "listModels") {
        const models = await engine.listAgyModels();
        reply({ models });
      } else if (method === "clearHistory") {
        await this.context.globalState.update(HISTORY_KEY, []);
        reply({ history: [] });
      } else if (method === "deleteHistory") {
        const next = this.getHistory().filter((item) => item.id !== params.id);
        await this.context.globalState.update(HISTORY_KEY, next);
        reply({ history: next });
      } else if (method === "copyText") {
        await vscode.env.clipboard.writeText(String(params.text || ""));
        reply({ copied: true });
      } else if (method === "sendToAntigravity") {
        reply(await this.sendToAntigravity(String(params.text || "")));
      } else if (method === "sendToAntigravityNewSession") {
        reply(await this.sendToAntigravityNewSession(String(params.text || "")));
      } else if (method === "sendToClaudeCode") {
        reply(await this.sendToClaudeCode(String(params.text || "")));
      } else if (method === "popOutWindow") {
        if (this.overlayPanel && webview === this.overlayPanel.webview) {
          if (!this.overlayDetached) {
            this.overlayPanel.reveal(undefined, false);
            const cmds = new Set(await vscode.commands.getCommands(true));
            if (cmds.has("workbench.action.moveEditorToNewWindow")) {
              try {
                await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
                this.overlayDetached = true;
              } catch (_) {}
            }
          } else {
            this.overlayPanel.reveal(undefined, false);
          }
          reply({ detached: this.overlayDetached });
        } else {
          await this.openOverlayPanel({}, { forceWindow: true });
          reply({ detached: this.overlayDetached });
        }
      } else if (method === "newSession") {
        reply({ session: { turn_count: 0, loaded_skills: [], loaded_domains: [] } });
      } else if (method === "loadSkill" || method === "removeSkill") {
        reply({});
      } else if (method === "syncVault") {
        reply({ vault: { ready: false, skill_count: 0, repo_count: 0, cloned_repo_count: 0 } });
      } else if (method === "orchestratorStatus") {
        reply(await this.orchestrator.status());
      } else if (method === "orchestratorPreview") {
        reply(await this.orchestrator.previewRoute(params));
      } else if (method === "orchestratorRun") {
        if (params.dry_run) {
          reply(await this.orchestrator.previewRoute(params));
        } else {
          reply(await this.orchestrator.orchestrateWorkflow({ ...params, workspace: params.workspace || wkWorkspaceFolder() }));
        }
      } else if (method === "orchestratorSaveConfig") {
        reply(await this.orchestrator.updateConfig(params));
      } else if (method === "orchestratorResetUsage") {
        reply(await this.orchestrator.resetUsage());
      } else {
        reply(null, `Unknown request: ${method}`);
      }
    } catch (err) {
      reply(null, err && err.message ? err.message : String(err));
    }
  }

  attachWebview(webview) {
    webview.options = { enableScripts: true };
    webview.html = getWebviewHtml(this.context.extensionPath);
    webview.onDidReceiveMessage((msg) => this.handleWebviewMessage(webview, msg));
  }

  async openOverlayPanel(initialState = {}, opts = {}) {
    if (this.overlayPanel) {
      this.overlayPanel.reveal(undefined, false);
      if (initialState.rewritten) {
        this.buildStatePayload(initialState).then((payload) => {
          this.overlayPanel?.webview.postMessage({ type: "event", event: "stateUpdate", data: payload });
        });
      } else if (initialState.draft) {
        this.overlayPanel.webview.postMessage({ type: "event", event: "prefillDraft", data: initialState });
      } else {
        this.overlayPanel.webview.postMessage({ type: "event", event: "focusDraft", data: {} });
      }
      if (opts.forceWindow && !this.overlayDetached) {
        const cmds = new Set(await vscode.commands.getCommands(true));
        if (cmds.has("workbench.action.moveEditorToNewWindow")) {
          try {
            await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
            this.overlayDetached = true;
          } catch (_) {}
        }
      }
      return;
    }

    const shouldDetach =
      opts.forceWindow !== undefined
        ? Boolean(opts.forceWindow)
        : this.getSettings().openInFloatingWindow !== false;

    if (initialState.draft || initialState.rewritten || initialState.activeTab) {
      this.pendingInitialState = initialState;
    }

    const panel = vscode.window.createWebviewPanel(
      "reprompt.overlayPanel",
      "Re-Prompt Overlay",
      { viewColumn: shouldDetach ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, "media", "icon.png"));
    this.overlayPanel = panel;
    this.overlayDetached = false;
    this.attachWebview(panel.webview);

    panel.onDidDispose(() => {
      if (this.overlayPanel === panel) {
        this.overlayPanel = null;
        this.overlayDetached = false;
      }
    });

    if (shouldDetach) {
      const cmds = new Set(await vscode.commands.getCommands(true));
      if (cmds.has("workbench.action.moveEditorToNewWindow")) {
        try {
          await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
          this.overlayDetached = true;
        } catch (_) {}
      }
    }
  }

  async runQuickOverlay(prefill = "") {
    const draft = await vscode.window.showInputBox({
      title: "Re-Prompt Floating Overlay",
      prompt: "Type a rough prompt — AI will rewrite it for Antigravity or Claude Code",
      placeHolder: "e.g. fix auth timeout, preserve cookies, and add unit tests",
      value: prefill,
      ignoreFocusOut: true,
    });
    if (!draft || !draft.trim()) return;

    const settings = this.getSettings();
    const secrets = await this.getSecrets();
    const ctx = settings.includeWorkspaceContext ? collectWorkspaceContext() : { workspaceContext: "" };

    let res;
    try {
      res = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Re-Prompt: Rewriting your prompt...",
          cancellable: false,
        },
        async () => {
          const out = await engine.rewriteWithProvider({
            settings,
            secrets,
            prompt: draft,
            target: settings.defaultTarget,
            mode: settings.defaultMode,
            workspaceContext: ctx.workspaceContext,
          });
          await this.addHistory(out);
          return out;
        }
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Re-Prompt failed: ${err.message || err}`);
      return;
    }

    const firstLines = res.rewritten_prompt.replace(/\s+/g, " ").slice(0, 140);
    const choice = await vscode.window.showQuickPick(
      [
        {
          id: "antigravity",
          label: "$(send) Send to Antigravity Chat",
          description: res.summary,
          detail: firstLines,
        },
        {
          id: "claude",
          label: "$(terminal) Send to Claude Code",
          description: "Copies & focuses Claude Code",
          detail: firstLines,
        },
        {
          id: "open",
          label: "$(edit) Open Full Overlay Composer (Inspect / Edit)",
          description: `${res.provider} · ${res.model}`,
        },
        {
          id: "copy",
          label: "$(copy) Copy to Clipboard",
          description: "Copies structured prompt without leaving editor",
        },
      ],
      {
        title: "Re-Prompt Ready",
        placeHolder: "Choose where to send or inspect your rewritten prompt",
        ignoreFocusOut: true,
      }
    );

    if (!choice) return;
    if (choice.id === "antigravity") {
      const msg = await this.sendToAntigravity(res.rewritten_prompt);
      vscode.window.showInformationMessage(msg.message);
    } else if (choice.id === "claude") {
      const msg = await this.sendToClaudeCode(res.rewritten_prompt);
      vscode.window.showInformationMessage(msg.message);
    } else if (choice.id === "copy") {
      await vscode.env.clipboard.writeText(res.rewritten_prompt);
      vscode.window.showInformationMessage("Re-Prompt copied to clipboard.");
    } else if (choice.id === "open") {
      this.openOverlayPanel({ draft, rewritten: res });
    }
  }
}

class RePromptWebviewViewProvider {
  constructor(controller) {
    this.controller = controller;
  }

  resolveWebviewView(webviewView) {
    this.controller.views.add(webviewView.webview);
    this.controller.attachWebview(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.controller.views.delete(webviewView.webview);
    });
  }
}

function activate(context) {
  const controller = new RePromptController(context);
  const viewProvider = new RePromptWebviewViewProvider(controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("reprompt.sidebarView", viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("reprompt.composerView", viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = "$(sparkle) Re-Prompt";
  statusItem.tooltip = "Open Re-Prompt Overlay (Ctrl+Alt+R / Cmd+Alt+R)";
  statusItem.command = "reprompt.openOverlay";
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("reprompt.openOverlay", () => controller.openOverlayPanel()),
    vscode.commands.registerCommand("reprompt.openWindow", () => controller.openOverlayPanel({}, { forceWindow: true })),
    vscode.commands.registerCommand("reprompt.popOutWindow", () => controller.openOverlayPanel({}, { forceWindow: true })),
    vscode.commands.registerCommand("reprompt.orchestratorStatus", async () => {
      const st = await controller.orchestrator.status();
      controller.openOverlayPanel({ activeTab: "orchestrator", orchestrator: st });
      controller.broadcast("switchTab", { tab: "orchestrator", orchestrator: st });
    }),
    vscode.commands.registerCommand("reprompt.orchestrateTask", async () => {
      const task = await vscode.window.showInputBox({
        title: "Gemini + Claude Smart Orchestrator",
        prompt: "Enter a task — auto-routes across Gemini & Claude based on quota, spend pace & complexity",
        placeHolder: "e.g. summarize the error logs below OR architect our retry queue",
        ignoreFocusOut: true,
      });
      if (!task || !task.trim()) return;
      const ctx = collectWorkspaceContext();
      try {
        const res = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Orchestrating across Gemini + Claude..." },
          () => controller.orchestrator.orchestrateWorkflow({ task, context: ctx.workspaceContext, workspace: wkWorkspaceFolder() })
        );
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: `# Orchestrated Result\n- **Provider:** ${res.provider} (${res.model} via ${res.channel})\n- **Routing Reason:** ${res.reason_summary}\n- **Tokens:** ${res.tokens.total} · **Est. Claude Savings:** $${(res.claude_savings_usd || 0).toFixed(4)}\n\n---\n\n${res.output}\n`,
        });
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        vscode.window.showErrorMessage(`Orchestration failed: ${err.message || err}`);
      }
    }),
    vscode.commands.registerCommand("reprompt.quickOverlay", () => controller.runQuickOverlay()),
    vscode.commands.registerCommand("reprompt.focusView", () =>
      vscode.commands.executeCommand("reprompt.composerView.focus")
    ),
    vscode.commands.registerCommand("reprompt.rewriteSelection", () => {
      const editor = vscode.window.activeTextEditor;
      const selText = editor && editor.selection ? editor.document.getText(editor.selection).trim() : "";
      controller.openOverlayPanel({ draft: selText });
    }),
    vscode.window.onDidChangeActiveTextEditor(() => controller.pushContextUpdate()),
    vscode.window.onDidChangeTextEditorSelection(() => controller.pushContextUpdate())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
