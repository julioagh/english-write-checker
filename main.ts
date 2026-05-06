// Based on write-good-obsidian by Mark Hesketh (MIT)
import {
  Plugin,
  PluginSettingTab,
  App,
  Setting,
  Notice,
  Editor,
  MarkdownView,
} from "obsidian";
import {
  ViewPlugin,
  DecorationSet,
  Decoration,
  EditorView,
  WidgetType,
  ViewUpdate,
} from "@codemirror/view";
import { StateField, StateEffect, Range } from "@codemirror/state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OllamaSuggestion {
  offset: number;
  length: number;
  original: string;
  message: string;
  suggestion: string;
  type: "error" | "style";
}

interface PluginSettings {
  ollamaEndpoint: string;
  ollamaModel: string;
  targetLevel: "B2" | "C1" | "C2";
}

const DEFAULT_SETTINGS: PluginSettings = {
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "gemma3:4b",
  targetLevel: "C1",
};

// ---------------------------------------------------------------------------
// State effects & fields for CM6
// ---------------------------------------------------------------------------

const setSuggestionsEffect = StateEffect.define<OllamaSuggestion[]>();
const clearSuggestionsEffect = StateEffect.define<null>();
const acceptSuggestionEffect = StateEffect.define<{ offset: number; originalLength: number; replacementLength: number }>();

const suggestionsField = StateField.define<OllamaSuggestion[]>({
  create: () => [],
  update(suggestions, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSuggestionsEffect)) return effect.value;
      if (effect.is(clearSuggestionsEffect)) return [];
      if (effect.is(acceptSuggestionEffect)) {
        const { offset, originalLength, replacementLength } = effect.value;
        const delta = replacementLength - originalLength;
        return suggestions
          .filter((s) => s.offset !== offset)
          .map((s) => s.offset > offset ? { ...s, offset: s.offset + delta } : s);
      }
    }
    return suggestions;
  },
});

// ---------------------------------------------------------------------------
// Suggestion widget rendered after the flagged phrase
// ---------------------------------------------------------------------------

class SuggestionWidget extends WidgetType {
  constructor(
    readonly message: string,
    readonly suggestion: string,
    readonly type: "error" | "style",
    readonly offset: number,
    readonly length: number,
    readonly view: EditorView
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = `ewc-suggestion ewc-suggestion--${this.type}`;
    el.setAttribute("aria-label", `${this.message} → ${this.suggestion}`);
    el.textContent = ` ✦ ${this.suggestion}`;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.view.dispatch({
        changes: { from: this.offset, to: this.offset + this.length, insert: this.suggestion },
        effects: acceptSuggestionEffect.of({
          offset: this.offset,
          originalLength: this.length,
          replacementLength: this.suggestion.length,
        }),
      });
    });
    return el;
  }

  ignoreEvent() {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Decoration builder
// ---------------------------------------------------------------------------

function buildDecorations(
  suggestions: OllamaSuggestion[],
  view: EditorView
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const docLength = view.state.doc.length;

  for (const s of suggestions) {
    const from = s.offset;
    const to = s.offset + s.length;

    if (from < 0 || to > docLength || from >= to) continue;

    decorations.push(
      Decoration.mark({
        class: `ewc-underline ewc-underline--${s.type}`,
        attributes: { title: s.message },
      }).range(from, to)
    );

    decorations.push(
      Decoration.widget({
        widget: new SuggestionWidget(s.message, s.suggestion, s.type, s.offset, s.length, view),
        side: 1,
      }).range(to)
    );
  }

  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations);
}

// ---------------------------------------------------------------------------
// CM6 ViewPlugin
// ---------------------------------------------------------------------------

const suggestionsViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      const suggestions = view.state.field(suggestionsField);
      this.decorations = buildDecorations(suggestions, view);
    }

    update(update: ViewUpdate) {
      const hasEffect = update.transactions.some((tr) =>
        tr.effects.some(
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

// ---------------------------------------------------------------------------
// Ollama client
// ---------------------------------------------------------------------------

async function analyzeWithOllama(
  text: string,
  settings: PluginSettings
): Promise<OllamaSuggestion[]> {
  const prompt = buildPrompt(text, settings.targetLevel);

  const response = await fetch(`${settings.ollamaEndpoint}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.ollamaModel,
      prompt,
      stream: false,
      format: "json",
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama responded with ${response.status}`);
  }

  const data = await response.json();
  return parseSuggestions(data.response ?? "", text);
}

function buildPrompt(text: string, level: string): string {
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

function parseSuggestions(
  raw: string,
  originalText: string
): OllamaSuggestion[] {
  let parsed: { suggestions?: unknown[] };

  try {
    // Strip markdown code fences if model wraps in ```json ... ```
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from within a longer string
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed.suggestions)) return [];

  const results: OllamaSuggestion[] = [];

  for (const item of parsed.suggestions) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).original !== "string" ||
      typeof (item as Record<string, unknown>).suggestion !== "string" ||
      typeof (item as Record<string, unknown>).message !== "string"
    ) {
      continue;
    }

    const s = item as Record<string, string>;
    let offset = originalText.indexOf(s.original);
    if (offset === -1) continue;

    // Expand to word boundaries so we never cut a word in half (letters/digits only)
    while (offset > 0 && /\w/.test(originalText[offset - 1])) offset--;
    let end = offset + s.original.length;
    while (end < originalText.length && /\w/.test(originalText[end])) end++;

    results.push({
      offset,
      length: end - offset,
      original: s.original,
      message: s.message,
      suggestion: s.suggestion,
      type: s.type === "error" ? "error" : "style",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

export default class EnglishWriteCheckerPlugin extends Plugin {
  settings: PluginSettings;
  private analyzing = false;

  async onload() {
    await this.loadSettings();

    this.registerEditorExtension([suggestionsField, suggestionsViewPlugin]);

    this.addCommand({
      id: "analyze-selection",
      name: "Analyze selected text",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.analyzeSelection(editor, view);
      },
    });

    this.addCommand({
      id: "clear-suggestions",
      name: "Clear all suggestions",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.clearSuggestions(view);
      },
    });

    this.addSettingTab(new EnglishWriteCheckerSettingTab(this.app, this));
  }

  private async analyzeSelection(editor: Editor, view: MarkdownView) {
    if (this.analyzing) {
      new Notice("Already analyzing, please wait…");
      return;
    }

    const selectedText = editor.getSelection();
    if (!selectedText || selectedText.trim().length < 10) {
      new Notice("Select at least a sentence to analyze.");
      return;
    }

    this.analyzing = true;
    const notice = new Notice("Analyzing with Ollama…", 0);

    try {
      const suggestions = await analyzeWithOllama(selectedText, this.settings);

      // Remap offsets from selection-relative to document-relative
      const selectionStart = editor.getCursor("from");
      const absoluteOffset = editor.posToOffset(selectionStart);

      const remapped = suggestions.map((s) => ({
        ...s,
        offset: absoluteOffset + s.offset,
      }));

      const cmView = (view.editor as unknown as { cm: EditorView }).cm;
      cmView.dispatch({
        effects: setSuggestionsEffect.of(remapped),
      });

      if (suggestions.length === 0) {
        new Notice("No issues found. Your writing looks good!");
      } else {
        new Notice(
          `Found ${suggestions.length} suggestion${suggestions.length > 1 ? "s" : ""}.`
        );
      }
    } catch (err) {
      console.error("[EnglishWriteChecker]", err);
      new Notice(
        `Could not connect to Ollama. Is it running at ${this.settings.ollamaEndpoint}?`
      );
    } finally {
      notice.hide();
      this.analyzing = false;
    }
  }

  private clearSuggestions(view: MarkdownView) {
    const cmView = (view.editor as unknown as { cm: EditorView }).cm;
    cmView.dispatch({ effects: clearSuggestionsEffect.of(null) });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class EnglishWriteCheckerSettingTab extends PluginSettingTab {
  plugin: EnglishWriteCheckerPlugin;

  constructor(app: App, plugin: EnglishWriteCheckerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Ollama endpoint")
      .setDesc("URL where Ollama is running")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings.ollamaEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.ollamaEndpoint = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Ollama model to use (e.g. gemma3:4b, gemma3:12b)")
      .addText((text) =>
        text
          .setPlaceholder("gemma3:4b")
          .setValue(this.plugin.settings.ollamaModel)
          .onChange(async (value) => {
            this.plugin.settings.ollamaModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Target level")
      .setDesc("Writing proficiency level for suggestions")
      .addDropdown((drop) =>
        drop
          .addOption("B2", "B2 — Upper intermediate")
          .addOption("C1", "C1 — Advanced")
          .addOption("C2", "C2 — Proficient")
          .setValue(this.plugin.settings.targetLevel)
          .onChange(async (value) => {
            this.plugin.settings.targetLevel = value as "B2" | "C1" | "C2";
            await this.plugin.saveSettings();
          })
      );
  }
}
