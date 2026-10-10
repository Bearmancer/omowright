const MODULES = new Set(["tls", "https", "http2"]);
const CLIENTS = {
  tls: new Set(["connect", "TLSSocket", "checkServerIdentity"]),
  https: new Set(["request", "get", "Agent", "globalAgent"]),
  http2: new Set(["connect"]),
  Bun: new Set(["connect"]),
};

export function normalizeCallText(text) {
  return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(")
    .replace(/,\s*\)/g, ")").replace(/\s+\)/g, ")");
}

function literal(token) {
  if (!token || !/^["'`]/.test(token.text)) return null;
  return token.text.slice(1, -1)
    .replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,
      (_, wide, unicode, hex) => String.fromCodePoint(parseInt(wide ?? unicode ?? hex, 16)))
    .replace(/\\(["'`\\])/g, "$1");
}

function tokens(content) {
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g;
  return [...content.matchAll(pattern)]
    .filter(match => !match[0].startsWith("//") && !match[0].startsWith("/*"))
    .map(match => ({ text: match[0], index: match.index }));
}

function grantsClient(clause, module) {
  if (module === "tls") return true;
  if (clause.some(token => token.text === "*")) return true;
  const open = clause.findIndex(token => token.text === "{");
  if (open !== 0) return true; // Default import, including default plus named.
  let atStart = true;
  for (let i = 1; i < clause.length; i += 1) {
    const text = clause[i].text;
    if (text === ",") atStart = true;
    else if (atStart) {
      atStart = false;
      if (text !== "type" && CLIENTS[module].has(literal(clause[i]) ?? text)) return true;
    }
  }
  return false;
}

export function findRawTlsClients(content) {
  const list = tokens(content);
  const hits = [];
  const add = (start, end) => {
    hits.push({
      line: content.slice(0, list[start].index).split("\n").length,
      text: normalizeCallText(content.slice(list[start].index, list[end].index + list[end].text.length)),
    });
  };
  const callEnd = open => {
    let depth = 0;
    for (let i = open; i < list.length; i += 1) {
      if (list[i].text === "(") depth += 1;
      if (list[i].text === ")" && --depth === 0) return i;
    }
    return list.length - 1;
  };
  for (let i = 0; i < list.length; i += 1) {
    const text = list[i].text;
    const next = list[i + 1]?.text;
    if (Object.hasOwn(CLIENTS, text)) {
      let property, open;
      if (next === ".") {
        property = list[i + 2]?.text;
        open = i + 3;
      } else if (next === "[" && list[i + 3]?.text === "]") {
        property = literal(list[i + 2]);
        open = i + 4;
      }
      if (CLIENTS[text].has(property) && list[open]?.text === "(") {
        add(list[i - 1]?.text === "new" ? i - 1 : i, callEnd(open));
      }
    }
    if (text === "checkServerIdentity" && list[i + 1]?.text === ":") add(i, i);
    const builtin = text === "process" && next === "." &&
      list[i + 2]?.text === "getBuiltinModule" && list[i + 3]?.text === "(";
    if ((text === "require" || text === "import") && next === "(" || builtin) {
      const open = builtin ? i + 3 : i + 1;
      const name = literal(list[open + 1])?.replace(/^node:/, "");
      if (MODULES.has(name)) add(i, callEnd(open));
      continue;
    }
    if (text !== "import" && text !== "export") continue;
    if (next === "type") continue;
    const sideEffect = literal(list[i + 1])?.replace(/^node:/, "");
    if (text === "import" && MODULES.has(sideEffect)) {
      add(i, i + 1);
      continue;
    }
    for (let j = i + 1; j < list.length; j += 1) {
      if ([";", "import", "export"].includes(list[j].text)) break;
      if (list[j].text !== "from") continue;
      const name = literal(list[j + 1])?.replace(/^node:/, "");
      if (MODULES.has(name) && grantsClient(list.slice(i + 1, j), name)) add(i, j + 1);
      break;
    }
  }
  return hits;
}

export function isScannedSourceFile(file) {
  return /\.(?:[cm]?js|jsx|tsx?)$/.test(file) &&
    !/\.(?:test|spec)\.[^/]+$/.test(file) && !file.endsWith(".d.ts") &&
    !file.split("/").some(segment => [
      "test", "tests", "__tests__", "fixtures", "__fixtures__", "test-support", "test-fixtures",
      "node_modules", ".git",
    ].includes(segment));
}

export function evaluateShippedSource(scan, allowlist) {
  const offenders = [];
  const counts = new Map(allowlist.map(entry => [entry, 0]));
  for (const item of scan) {
    for (const hit of findRawTlsClients(item.content)) {
      const entry = allowlist.find(candidate => candidate.file === item.path && candidate.call === hit.text);
      if (entry) counts.set(entry, counts.get(entry) + 1);
      else offenders.push(`${item.path}:${hit.line}  ${hit.text}`);
    }
  }
  const stale = [];
  for (const entry of allowlist) {
    if (!scan.some(item => item.path === entry.file)) stale.push(`${entry.file}: no longer scanned`);
    if (counts.get(entry) !== entry.count) {
      stale.push(`${entry.file}: expected ${entry.call} x${entry.count}, found x${counts.get(entry)}`);
    }
    if (!entry.reason?.trim() || !Number.isInteger(entry.count) || entry.count < 1) {
      stale.push(`${entry.file}: requires positive count and reviewed host provenance`);
    }
  }
  return { offenders, stale };
}
