// Prints counts only, never matching log lines or secret values.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
const { stdout } = await promisify(execFile)('docker',['compose','logs','--no-color','backend','worker'], {maxBuffer:32*1024*1024});
const privateValues=[];
for (const name of ['.env.security.local','.env.smoke.local']) {
  try { const values=parse(await readFile(new URL(`../../${name}`,import.meta.url))); privateValues.push(...Object.entries(values).filter(([k])=>/SECRET|TOKEN|PASSWORD/.test(k)).map(([,v])=>v)); } catch {}
}
const checks={
  documentContent: /Volunteers should cancel|12 hours|Princess Donut|ACKNOWLEDGEMENTS/g,
  credentialFields: /"(?:authorization|cookie|set-cookie|password|csrfToken|sessionToken|OBJECT_STORAGE_SECRET_KEY|OBJECT_STORAGE_ACCESS_KEY)"\s*:/gi,
  vectors: /\[\s*-?\d+\.\d+(?:\s*,\s*-?\d+\.\d+){15,}/g,
};
let failed=false;
for(const [name,pattern] of Object.entries(checks)){const count=[...stdout.matchAll(pattern)].length;console.log(`${name}: ${count} matches`);failed ||= count>0;}
const secrets=privateValues.filter(value=>value.length>10 && stdout.includes(value)).length;
console.log(`Known credential values: ${secrets} matches`); failed ||= secrets>0;
if(failed) process.exitCode=1;
