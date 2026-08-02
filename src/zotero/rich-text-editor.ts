const SUPPORTED_FORMATS = ["i", "b", "sub", "sup"] as const;
// Do not read globalThis.Node here. Zotero loads bootstrap scripts in a
// privileged sandbox where DOM types exist for TypeScript but the Node
// constructor is not guaranteed to be exposed at runtime.
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function findFormatter(value: string):
  | { format: (typeof SUPPORTED_FORMATS)[number]; parts: [string, string, string] }
  | undefined {
  const lower = value.toLowerCase();
  const matches = SUPPORTED_FORMATS
    .map((format) => ({ format, offset: lower.indexOf(`<${format}>`) }))
    .filter((match) => match.offset >= 0)
    .sort((left, right) => left.offset - right.offset);
  for (const match of matches) {
    const close = lower.indexOf(`</${match.format}>`, match.offset);
    if (close < 0) continue;
    return {
      format: match.format,
      parts: [
        value.slice(0, match.offset),
        value.slice(match.offset + match.format.length + 2, close),
        value.slice(close + match.format.length + 3),
      ],
    };
  }
  return undefined;
}

function formatTextNodes(parent: Node): void {
  for (const original of Array.from(parent.childNodes) as ChildNode[]) {
    let child: ChildNode = original;
    if (child.nodeType === TEXT_NODE) {
      const formatter = findFormatter(child.nodeValue ?? "");
      if (formatter) {
        const doc = child.ownerDocument!;
        const formatted = doc.createElement(formatter.format);
        formatted.append(doc.createTextNode(formatter.parts[1]));
        const nodes: Node[] = [
          doc.createTextNode(formatter.parts[0]),
          formatted,
          doc.createTextNode(formatter.parts[2]),
        ];
        child.replaceWith(...nodes);
        formatTextNodes(parent);
        return;
      }
    }
    formatTextNodes(child);
  }
}

function cleanEditorDom(parent: Node): void {
  for (const original of Array.from(parent.childNodes) as ChildNode[]) {
    let child: ChildNode = original;
    if (child.nodeType === ELEMENT_NODE) {
      let element = child as HTMLElement;
      if (element.localName === "strong") {
        const replacement = element.ownerDocument!.createElement("b");
        while (element.firstChild) replacement.appendChild(element.firstChild);
        element.replaceWith(replacement);
        element = replacement;
        child = replacement;
      }

      const allowed = [...SUPPORTED_FORMATS, "br", "div"];
      if (!allowed.includes(element.localName as (typeof allowed)[number])) {
        while (element.firstChild) {
          const nested = element.firstChild!;
          parent.insertBefore(nested, element);
        }
        element.remove();
        cleanEditorDom(parent);
        return;
      }
      while (element.attributes.length) {
        element.removeAttribute(element.attributes[0]!.name);
      }
      cleanEditorDom(element);
    } else if (child.nodeType !== TEXT_NODE) {
      parent.removeChild(child);
    }
  }
}

function unformatElements(parent: Node): void {
  for (const original of Array.from(parent.childNodes) as ChildNode[]) {
    const child: ChildNode = original;
    if (
      child.nodeType === ELEMENT_NODE
      && SUPPORTED_FORMATS.includes((child as HTMLElement).localName as (typeof SUPPORTED_FORMATS)[number])
    ) {
      const element = child as HTMLElement;
      if ((element.textContent ?? "").trim()) {
        const doc = element.ownerDocument!;
        const name = element.localName;
        element.before(doc.createTextNode(`<${name}>`));
        while (element.firstChild) element.before(element.firstChild!);
        element.before(doc.createTextNode(`</${name}>`));
        element.remove();
        continue;
      }
    }
    unformatElements(child);
  }
}

function fallbackInnerText(parent: Node): string {
  let result = "";
  for (const child of Array.from(parent.childNodes) as ChildNode[]) {
    if (child.nodeType === TEXT_NODE) {
      result += child.nodeValue ?? "";
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const element = child as HTMLElement;
    if (element.localName === "br") {
      result += "\n";
      continue;
    }
    if (element.localName === "div" && result && !result.endsWith("\n")) {
      result += "\n";
    }
    result += fallbackInnerText(element);
  }
  return result;
}

function innerText(element: HTMLElement): string {
  return fallbackInnerText(element);
}

export function renderStoredComment(root: HTMLElement, value: string): void {
  root.textContent = value;
  formatTextNodes(root);
}

export function readStoredComment(root: HTMLElement): string {
  cleanEditorDom(root);
  const renderer = root.cloneNode(true) as HTMLElement;
  unformatElements(renderer);
  return innerText(renderer).replace(/\n<\//g, "</").trim();
}

export function selectEditorContents(root: HTMLElement): void {
  const selection = root.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  selection.removeAllRanges();
  selection.addRange(range);
}
