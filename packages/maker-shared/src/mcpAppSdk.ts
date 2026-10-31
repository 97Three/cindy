import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { parse as parseJavaScript, type AnyNode } from 'acorn';

const moduleName = '@modelcontextprotocol/ext-apps';
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
// HTML runs these exact essences as classic scripts; any other type is a data block.
const classicScriptTypes = new Set(['', 'application/ecmascript', 'application/javascript',
  'application/x-ecmascript', 'application/x-javascript', 'text/ecmascript', 'text/javascript',
  'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3',
  'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript']);
function importsSdk(source: string, module: boolean): boolean {
  if (!source.includes(moduleName)) return false;
  try {
    const pending: unknown[] = [parseJavaScript(source, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script' })];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      const node = value as AnyNode;
      if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression' ||
          node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
        const source = node.source;
        if (source?.type === 'Literal' && source.value === moduleName) return true;
        if (source?.type === 'TemplateLiteral' && source.expressions.length === 0 &&
            source.quasis[0]?.value.cooked === moduleName) return true;
      }
      pending.push(...Object.values(value));
    }
  } catch { /* Invalid JavaScript remains the browser's responsibility. */ }
  return false;
}

function sdkPlan(html: string) {
  // Ordinary pages keep their exact bytes and never pay for HTML parsing.
  // A byte-order mark is an encoding marker, not text before the doctype.
  const offset = html.startsWith('\ufeff') ? 1 : 0;
  const document = parse(html.slice(offset), { sourceCodeLocationInfo: true });
  let insertion = offset;
  let imported = false;
  let authoredSdk = false;
  let authoredMap: { start: number; end: number; value: Record<string, unknown> } | undefined;
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if (node.nodeName === '#documentType') insertion = (node.sourceCodeLocation?.endOffset ?? 0) + offset;
    if ('tagName' in node && node.namespaceURI === htmlNamespace) {
      if (node.tagName === 'head' && node.sourceCodeLocation?.startTag)
        insertion = node.sourceCodeLocation.startTag.endOffset + offset;
      if (node.tagName === 'script') {
        const type = (node.attrs.find(attr => attr.name === 'type')?.value ?? '')
          .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
        const text = node.childNodes.map(child => 'value' in child ? child.value : '').join('');
        if (!node.attrs.some(attr => attr.name === 'src') && (type === 'module' || classicScriptTypes.has(type)))
          imported ||= importsSdk(text, type === 'module');
        if (type === 'importmap') {
          try {
            const map = JSON.parse(text);
            authoredSdk ||= Object.entries(map?.imports ?? {}).some(([name, address]) =>
              (name === moduleName || (name.endsWith('/') && moduleName.startsWith(name))) &&
              (address === null || (typeof address === 'string' &&
                (name === moduleName || address.endsWith('/')))));
            const location = node.sourceCodeLocation;
            if (!authoredMap && map && typeof map === 'object' && !Array.isArray(map) &&
                (map.imports === undefined || (map.imports && typeof map.imports === 'object' && !Array.isArray(map.imports))) &&
                location?.startTag && location.endTag) {
              authoredMap = { start: location.startTag.endOffset + offset, end: location.endTag.startOffset + offset, value: map };
            }
          } catch { /* Invalid authored maps remain the browser's responsibility. */ }
        }
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(document);
  return { insertion, authoredMap, imported, authoredSdk };
}

/** Only HTML requesting the bare SDK module needs the executor's optional asset. */
export function needsHostAppSdk(html: string): boolean { const plan = sdkPlan(html); return plan.imported && !plan.authoredSdk; }

// The default form action is always disabled by CSP. Cancel it before Chromium
// navigates to a CSP error document; page handlers still run before this fallback.
const runtime = `<script data-cindy-runtime>
(()=>{
 const prevent=event=>{if(!event.defaultPrevented)event.preventDefault();};
 const install=()=>window.addEventListener('submit',prevent);
 const open=Document.prototype.open;
 Document.prototype.open=function(...args){
  const result=Reflect.apply(open,this,args);
  if(this===document&&args.length<3)install();
  return result;
 };
 for(const method of ['write','writeln']){
  const write=Document.prototype[method];
  Document.prototype[method]=function(...args){
   const result=Reflect.apply(write,this,args);
   if(this===document)install();
   return result;
  };
 }
 // Direct submit() skips the event; requestSubmit() still runs page handlers.
 HTMLFormElement.prototype.submit=function(){};
 install();
})();
</script>`;

/** Prepare the App environment outside the chat contract's startup dependency graph. */
export function withHostAppSdk(html: string, sdkUrl: string): string {
  if (!new URL(sdkUrl).hostname) throw new Error('MCP_APP_SDK_URL_REQUIRED');
  const { insertion, authoredMap, imported, authoredSdk } = sdkPlan(html);
  let prefix = runtime;
  if (imported && !authoredSdk) {
    if (authoredMap) {
      const value = { ...authoredMap.value, imports: {
        ...(authoredMap.value.imports as Record<string, unknown> | undefined), [moduleName]: sdkUrl,
      } };
      html = html.slice(0, authoredMap.start) + JSON.stringify(value).replace(/</g, '\\u003c') + html.slice(authoredMap.end);
    } else {
      prefix += '<script type="importmap">' + JSON.stringify({ imports: { [moduleName]: sdkUrl } }) + '</script>';
    }
  }
  return html.slice(0, insertion) + prefix + html.slice(insertion);
}
