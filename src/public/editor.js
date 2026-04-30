import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";

const LANG_MAP = {
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  cjs: () => javascript(),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  mts: () => javascript({ typescript: true }),
  json: () => json(),
  jsonc: () => json(),
  css: () => css(),
  html: () => html(),
  htm: () => html(),
  md: () => markdown(),
  markdown: () => markdown(),
  py: () => python(),
  rs: () => rust(),
  sh: () => StreamLanguage.define(shell),
  bash: () => StreamLanguage.define(shell),
  zsh: () => StreamLanguage.define(shell),
  yml: () => StreamLanguage.define(yaml),
  yaml: () => StreamLanguage.define(yaml),
};

let currentView = null;

window.initCodeViewer = function (containerId, content, filename) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (currentView) {
    currentView.destroy();
    currentView = null;
  }

  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const langFn = LANG_MAP[ext];

  const extensions = [
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    oneDark,
    lineNumbers(),
    highlightActiveLine(),
    EditorView.theme({
      "&": { height: "100%", fontSize: "12px" },
      ".cm-scroller": { overflow: "auto", fontFamily: "monospace" },
    }),
  ];
  if (langFn) {
    try {
      extensions.push(langFn());
    } catch {}
  }

  currentView = new EditorView({
    state: EditorState.create({ doc: content, extensions }),
    parent: container,
  });
};

window.destroyCodeViewer = function () {
  if (currentView) {
    currentView.destroy();
    currentView = null;
  }
};
