import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === 'unicast';
  } catch { return false; }
}
export function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('网页地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
      !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|lan|test|invalid)$/.test(url.hostname)) throw Error('只能读取公网 HTTPS 网页');
  url.hash = '';
  return url;
}
function decodeEntities(text) {
  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
    const number = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  }).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
}
export function pageText(raw, type) {
  if (!/html/i.test(type)) return { title: '', text: raw.replace(/\u0000/g, '') };
  const title = decodeEntities(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const text = decodeEntities(raw.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|article|section|h[1-6]|li|tr)>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
  return { title, text };
}
async function requestPage(url, signal, resolve = lookup) {
  const addresses = await new Promise((done, fail) => {
    const abort = () => fail(new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(resolve(url.hostname, { all: true, verbatim: true })).then(done, fail).finally(() => signal?.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw Error('该地址指向内网或非公网服务，不能读取');
  const address = addresses[0];
  return new Promise((resolveRequest, reject) => {
    // Pin the validated DNS answer for this connection, including redirects.
    const req = https.request(url, {
      method: 'GET', signal, agent: false,
      lookup(hostname, options, callback) {
        if (options.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
      headers: { Accept: 'text/html,text/plain,text/markdown', 'Accept-Encoding': 'identity', 'User-Agent': 'BranchMindmap/2.0 (public-document-reader)' },
    }, response => {
      const status = response.statusCode || 500;
      if ([301, 302, 303, 307, 308].includes(status)) { response.resume(); resolveRequest({ status, location: response.headers.location }); return; }
      const type = String(response.headers['content-type'] || '');
      if (status !== 200) { response.resume(); reject(Error('网页返回 HTTP ' + status)); return; }
      if (!/^(text\/(html|plain|markdown)|application\/xhtml\+xml)(;|$)/i.test(type)) { response.resume(); reject(Error('仅支持 HTML、Markdown 和纯文本页面，不支持 PDF 或下载文件')); return; }
      if (Number(response.headers['content-length'] || 0) > 600000) { response.destroy(); reject(Error('网页内容过大')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 600000) { response.destroy(Error('网页内容过大')); return; } chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolveRequest({ status, type, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
}
export async function readPublicPage(value, signal, { resolve, request = requestPage } = {}) {
  let url = publicUrl(value);
  const timeout = AbortSignal.timeout(18000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let index = 0; index < 4; index++) {
    const result = await request(url, combined, resolve);
    if (result.location) { url = publicUrl(new URL(result.location, url).href); continue; }
    const { title, text } = pageText(result.raw, result.type);
    if (!text.trim()) throw Error('该网页没有可提取的文本，可能需要浏览器执行 JavaScript');
    return { url: url.href, title: title || url.hostname, text: text.slice(0, 10000), truncated: text.length > 10000, fetchedAt: new Date().toISOString() };
  }
  throw Error('网页重定向次数过多');
}
