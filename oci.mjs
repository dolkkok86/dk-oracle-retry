// 오라클 클라우드 API를 Node.js만으로 부르는 작은 도구(오라클 CLI 없이).
// ~/.oci/config 의 [DEFAULT] 값과 API 키로 요청에 서명해요(OCI HTTP Signature).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfgText = fs.readFileSync(path.join(os.homedir(), '.oci', 'config'), 'utf8');
export const cfg = Object.fromEntries(cfgText.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const key = fs.readFileSync(cfg.key_file, 'utf8');
const keyId = `${cfg.tenancy}/${cfg.user}/${cfg.fingerprint}`;

/** 서명한 요청. 새 API 키가 아직 퍼지는 중이면 401이 섞여 와서, 401은 몇 번 다시 시도해요. */
export async function oci(service, method, pathAndQuery, body) {
  for (let i = 0; ; i++) {
    try { return await once(service, method, pathAndQuery, body); }
    catch (e) { if (e.status !== 401 || i >= 5) throw e; await new Promise((r) => setTimeout(r, 4000)); }
  }
}

async function once(service, method, pathAndQuery, body) {
  const host = `${service}.${cfg.region}.oraclecloud.com`;
  const date = new Date().toUTCString();
  const headers = { date, host };
  const names = ['date', '(request-target)', 'host'];
  let data;
  if (body !== undefined) {
    data = JSON.stringify(body);
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(data));
    headers['x-content-sha256'] = crypto.createHash('sha256').update(data).digest('base64');
    names.push('content-length', 'content-type', 'x-content-sha256');
  }
  const lines = names.map((n) => (n === '(request-target)' ? `(request-target): ${method.toLowerCase()} ${pathAndQuery}` : `${n}: ${headers[n]}`));
  const signature = crypto.createSign('RSA-SHA256').update(lines.join('\n')).sign(key, 'base64');
  headers.authorization = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${signature}"`;
  const res = await fetch(`https://${host}${pathAndQuery}`, { method, headers, body: data });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) { const e = new Error(`${res.status} ${json?.code ?? ''}: ${json?.message ?? text}`); e.status = res.status; e.body = json; throw e; }
  return json;
}
