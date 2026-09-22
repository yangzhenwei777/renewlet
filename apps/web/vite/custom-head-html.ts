import { defaultTreeAdapter, html as parse5HTML, parse, parseFragment } from "parse5";

export const customHeadHTMLEnvName = "RENEWLET_CUSTOM_HEAD_HTML";
export const customHeadHTMLMaxBytes = 64 * 1024;

const customHeadHTMLStartMarker = "<!-- renewlet-custom-head-html:start -->";
const customHeadHTMLEndMarker = "<!-- renewlet-custom-head-html:end -->";
const allowedHeadElements = new Set(["base", "link", "meta", "noscript", "script", "style", "template", "title"]);

export type CustomHeadHTML = {
  markup: string;
};

type ParsedNode = {
  nodeName: string;
  tagName?: string;
  value?: string;
  data?: string;
  childNodes?: ParsedNode[];
  sourceCodeLocation?: {
    startOffset: number;
    endOffset: number;
    endTag?: { startOffset: number };
  };
};

export function parseCustomHeadHTML(raw: string | undefined): CustomHeadHTML | undefined {
  const markup = raw ?? "";
  if (!hasWellFormedUnicode(markup)) {
    throw new Error(`${customHeadHTMLEnvName} must be valid UTF-8`);
  }
  if (new TextEncoder().encode(markup).byteLength > customHeadHTMLMaxBytes) {
    throw new Error(`${customHeadHTMLEnvName} exceeds the 64 KiB UTF-8 limit`);
  }
  if (!markup.trim()) return undefined;

  // WHATWG tree builder 会恢复并重排错误标签；唯一尾部哨兵用于证明片段没有吞掉宿主页后续结构，不能把“parse5 未报错”当作合法性结论。
  const marker = customHeadHTMLMarker(markup);
  const source = `${markup}<!--${marker}-->`;
  const context = defaultTreeAdapter.createElement("head", parse5HTML.NS.HTML, []);
  const fragment = parseFragment(context, source, { sourceCodeLocationInfo: true });
  const nodes = fragment.childNodes as ParsedNode[];
  const endNode = nodes.at(-1);
  if (endNode?.nodeName !== "#comment" || endNode.data !== marker || endNode.sourceCodeLocation?.startOffset !== markup.length) {
    throw new Error(`${customHeadHTMLEnvName} must be a complete head fragment`);
  }

  // parse5 可能静默忽略或重定位源码 token；location coverage 要求每段非空白源码都映射到稳定的 head 顶层节点。
  let coveredOffset = 0;
  for (const node of nodes) {
    const location = node.sourceCodeLocation;
    if (!location || location.startOffset < coveredOffset) {
      throw new Error(`${customHeadHTMLEnvName} could not be mapped to a stable head fragment`);
    }
    if (source.slice(coveredOffset, location.startOffset).trim()) {
      throw new Error(`${customHeadHTMLEnvName} must not contain html or body escape markup`);
    }
    coveredOffset = location.endOffset;
  }
  if (coveredOffset !== source.length) {
    throw new Error(`${customHeadHTMLEnvName} could not be mapped to a complete head fragment`);
  }

  for (const node of nodes.slice(0, -1)) {
    if (node.nodeName === "#text") {
      if (node.value?.trim()) {
        throw new Error(`${customHeadHTMLEnvName} must not contain non-whitespace top-level text`);
      }
      continue;
    }
    if (node.nodeName === "#comment") continue;
    if (!node.tagName || !allowedHeadElements.has(node.tagName)) {
      throw new Error(`${customHeadHTMLEnvName} contains <${node.tagName ?? node.nodeName}>, which is not valid at the top level of a head fragment`);
    }
  }

  // 该变量由实例部署者控制并拥有页面同源代码权限；这里只守住 head 结构，不清洗属性、重写脚本或推断外部资源。
  return { markup };
}

export function transformCustomHeadHTML(documentHTML: string, customHeadHTML: CustomHeadHTML | undefined): string {
  if (!customHeadHTML) return documentHTML;
  // Vite 的同一 HTML hook 在 dev/build 或插件组合中可能重复执行；成对 marker 只负责幂等，不承担内容清洗或信任判断。
  const hasStartMarker = documentHTML.includes(customHeadHTMLStartMarker);
  const hasEndMarker = documentHTML.includes(customHeadHTMLEndMarker);
  if (hasStartMarker || hasEndMarker) {
    if (hasStartMarker && hasEndMarker) return documentHTML;
    throw new Error("Renewlet custom head HTML markers are incomplete.");
  }

  const document = parse(documentHTML, { sourceCodeLocationInfo: true }) as unknown as ParsedNode;
  const head = findElement(document, "head");
  const closeOffset = head?.sourceCodeLocation?.endTag?.startOffset;
  if (closeOffset === undefined) {
    throw new Error("Vite index.html must contain an explicit head element.");
  }

  // parse5 只定位宿主的显式 </head>；最终按源码偏移拼接，避免序列化部署者提供的脚本、属性和多标签片段。
  const injected = [customHeadHTMLStartMarker, customHeadHTML.markup, customHeadHTMLEndMarker].join("\n");
  return `${documentHTML.slice(0, closeOffset)}\n${injected}\n${documentHTML.slice(closeOffset)}`;
}

export function updateCustomHeadHTMLStaticHeaders(headers: string, customHeadHTML: CustomHeadHTML | undefined): string {
  if (!customHeadHTML) return headers;
  const cspLinePattern = /^(\s*Content-Security-Policy:\s*)(.+)$/m;
  if (!cspLinePattern.test(headers)) {
    throw new Error("Missing Content-Security-Policy in apps/web/dist/_headers.");
  }
  return headers.replace(cspLinePattern, `$1${trustedExtensionContentSecurityPolicy(true)}`);
}

export function trustedExtensionContentSecurityPolicy(httpsProduction: boolean): string {
  // 可信扩展态刻意不声明 default-src 与 fetch directives；任何 fallback 白名单都会重新限制动态脚本、XHR、图片和 frame。
  const directives = ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'"];
  if (httpsProduction) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

function findElement(node: ParsedNode, tagName: string): ParsedNode | undefined {
  if (node.tagName === tagName) return node;
  for (const child of node.childNodes ?? []) {
    const match = findElement(child, tagName);
    if (match) return match;
  }
  return undefined;
}

function customHeadHTMLMarker(markup: string): string {
  let marker = "renewlet-custom-head-html-parse-end";
  while (markup.includes(marker)) marker += "-marker";
  return marker;
}

function hasWellFormedUnicode(value: string): boolean {
  // TextEncoder 会把孤立 UTF-16 surrogate 静默替换成 U+FFFD；先显式拒绝，才能让前后端共享“有效 UTF-8 输入”契约。
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
