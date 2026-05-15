var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => EnglishWriteCheckerPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_view = require("@codemirror/view");
var import_state = require("@codemirror/state");
var DEFAULT_SETTINGS = {
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "gemma3:4b",
  targetLevel: "C1"
};
var setSuggestionsEffect = import_state.StateEffect.define();
var clearSuggestionsEffect = import_state.StateEffect.define();
var acceptSuggestionEffect = import_state.StateEffect.define();
var suggestionsField = import_state.StateField.define({
  create: () => [],
  update(suggestions, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSuggestionsEffect))
        return effect.value;
      if (effect.is(clearSuggestionsEffect))
        return [];
      if (effect.is(acceptSuggestionEffect)) {
        const { offset, originalLength, replacementLength } = effect.value;
        const delta = replacementLength - originalLength;
        return suggestions.filter((s) => s.offset !== offset).map((s) => s.offset > offset ? { ...s, offset: s.offset + delta } : s);
      }
    }
    return suggestions;
  }
});
var SuggestionWidget = class extends import_view.WidgetType {
  constructor(message, suggestion, type, offset, length, view) {
    super();
    this.message = message;
    this.suggestion = suggestion;
    this.type = type;
    this.offset = offset;
    this.length = length;
    this.view = view;
  }
  toDOM() {
    const el = createSpan({ cls: `ewc-suggestion ewc-suggestion--${this.type}` });
    el.setAttribute("aria-label", `${this.message} \u2192 ${this.suggestion}`);
    el.textContent = ` \u2726 ${this.suggestion}`;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.view.dispatch({
        changes: { from: this.offset, to: this.offset + this.length, insert: this.suggestion },
        effects: acceptSuggestionEffect.of({
          offset: this.offset,
          originalLength: this.length,
          replacementLength: this.suggestion.length
        })
      });
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
};
function buildDecorations(suggestions, view) {
  const decorations = [];
  const docLength = view.state.doc.length;
  const usedWidgetPositions = /* @__PURE__ */ new Set();
  for (const s of suggestions) {
    const from = s.offset;
    const to = s.offset + s.length;
    if (from < 0 || to > docLength || from >= to)
      continue;
    decorations.push(
      import_view.Decoration.mark({
        class: `ewc-underline ewc-underline--${s.type}`
      }).range(from, to)
    );
    if (!usedWidgetPositions.has(to)) {
      usedWidgetPositions.add(to);
      decorations.push(
        import_view.Decoration.widget({
          widget: new SuggestionWidget(s.message, s.suggestion, s.type, s.offset, s.length, view),
          side: 1
        }).range(to)
      );
    }
  }
  decorations.sort((a, b) => a.from - b.from);
  return import_view.Decoration.set(decorations);
}
var suggestionsViewPlugin = import_view.ViewPlugin.fromClass(
  class {
    constructor(view) {
      const suggestions = view.state.field(suggestionsField);
      this.decorations = buildDecorations(suggestions, view);
    }
    update(update) {
      const hasEffect = update.transactions.some(
        (tr) => tr.effects.some(
          (e) => e.is(setSuggestionsEffect) || e.is(clearSuggestionsEffect)
        )
      );
      if (hasEffect || update.docChanged || update.viewportChanged) {
        const suggestions = update.view.state.field(suggestionsField);
        this.decorations = buildDecorations(suggestions, update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
async function analyzeWithOllama(text, settings) {
  var _a;
  const prompt = buildPrompt(text, settings.targetLevel);
  const response = await (0, import_obsidian.requestUrl)({
    url: `${settings.ollamaEndpoint}/api/generate`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.ollamaModel,
      prompt,
      stream: false,
      format: "json"
    })
  });
  if (response.status !== 200) {
    throw new Error(`Ollama responded with ${response.status}`);
  }
  const data = response.json;
  return parseSuggestions((_a = data.response) != null ? _a : "", text);
}
function buildPrompt(text, level) {
  return `You are an expert English editor helping a writer reach ${level} proficiency.

Analyze the following English text and return a JSON object with a "suggestions" array.
Each suggestion must have:
- "original": the exact phrase from the text that should change (copy it verbatim)
- "message": brief explanation of the issue (1 sentence)
- "suggestion": the improved replacement phrase
- "type": MUST be "error" if the phrase contains a grammar mistake, wrong verb tense, missing article, subject-verb disagreement, or spelling error. MUST be "style" only if the grammar is correct but the word choice or register could be improved to reach ${level} level.

Only flag real issues. Return at most 5 suggestions. If the text is already good, return {"suggestions":[]}.

TEXT:
"""
${text}
"""

Respond ONLY with valid JSON. No explanation outside the JSON.`;
}
function parseSuggestions(raw, originalText) {
  let parsed;
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match)
      return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch (e2) {
      return [];
    }
  }
  if (!Array.isArray(parsed.suggestions))
    return [];
  const results = [];
  for (const item of parsed.suggestions) {
    if (typeof item !== "object" || item === null || typeof item.original !== "string" || typeof item.suggestion !== "string" || typeof item.message !== "string") {
      continue;
    }
    const s = item;
    let offset = originalText.indexOf(s.original);
    if (offset === -1)
      continue;
    while (offset > 0 && /\w/.test(originalText[offset - 1]))
      offset--;
    let end = offset + s.original.length;
    while (end < originalText.length && /\w/.test(originalText[end]))
      end++;
    results.push({
      offset,
      length: end - offset,
      original: s.original,
      message: s.message,
      suggestion: s.suggestion,
      type: s.type === "error" ? "error" : "style"
    });
  }
  return results;
}
var EnglishWriteCheckerPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.analyzing = false;
  }
  async onload() {
    await this.loadSettings();
    this.registerEditorExtension([suggestionsField, suggestionsViewPlugin]);
    this.addCommand({
      id: "analyze-selection",
      name: "Analyze selected text",
      editorCallback: (_editor, view) => {
        void this.analyzeSelection(view);
      }
    });
    this.addCommand({
      id: "clear-suggestions",
      name: "Clear all suggestions",
      editorCallback: (_editor, view) => {
        this.clearSuggestions(view);
      }
    });
    this.addSettingTab(new EnglishWriteCheckerSettingTab(this.app, this));
  }
  async analyzeSelection(view) {
    if (this.analyzing) {
      new import_obsidian.Notice("Already analyzing, please wait");
      return;
    }
    const editor = view.editor;
    const selectedText = editor.getSelection();
    if (!selectedText || selectedText.trim().length < 10) {
      new import_obsidian.Notice("Select at least a sentence to analyze");
      return;
    }
    this.analyzing = true;
    const notice = new import_obsidian.Notice("Analyzing with Ollama", 0);
    try {
      const suggestions = await analyzeWithOllama(selectedText, this.settings);
      const selectionStart = editor.getCursor("from");
      const absoluteOffset = editor.posToOffset(selectionStart);
      const remapped = suggestions.map((s) => ({
        ...s,
        offset: absoluteOffset + s.offset
      }));
      const cmView = view.editor.cm;
      cmView.dispatch({
        effects: setSuggestionsEffect.of(remapped)
      });
      if (suggestions.length === 0) {
        new import_obsidian.Notice("No issues found. Your writing looks good");
      } else {
        new import_obsidian.Notice(
          `Found ${suggestions.length} suggestion${suggestions.length > 1 ? "s" : ""}`
        );
      }
    } catch (err) {
      console.error("[EnglishWriteChecker]", err);
      new import_obsidian.Notice(
        `Could not connect to Ollama. Is it running at ${this.settings.ollamaEndpoint}?`
      );
    } finally {
      notice.hide();
      this.analyzing = false;
    }
  }
  clearSuggestions(view) {
    const cmView = view.editor.cm;
    cmView.dispatch({ effects: clearSuggestionsEffect.of(null) });
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var EnglishWriteCheckerSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Ollama endpoint").setDesc("URL where Ollama is running").addText(
      (text) => text.setPlaceholder("http://localhost:11434").setValue(this.plugin.settings.ollamaEndpoint).onChange(async (value) => {
        this.plugin.settings.ollamaEndpoint = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Ollama model").setDesc("Ollama model to use, e.g. gemma3:4b or gemma3:12b").addText(
      (text) => text.setPlaceholder("gemma3:4b").setValue(this.plugin.settings.ollamaModel).onChange(async (value) => {
        this.plugin.settings.ollamaModel = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Target level").setDesc("Writing proficiency level for suggestions (B2, C1, or C2)").addDropdown(
      (drop) => drop.addOption("B2", "B2 \u2014 upper intermediate").addOption("C1", "C1 \u2014 advanced").addOption("C2", "C2 \u2014 proficient").setValue(this.plugin.settings.targetLevel).onChange(async (value) => {
        this.plugin.settings.targetLevel = value;
        await this.plugin.saveSettings();
      })
    );
  }
};
