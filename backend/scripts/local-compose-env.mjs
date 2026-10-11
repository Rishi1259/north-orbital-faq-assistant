// Local acceptance helper. Reads resolved Compose secrets without printing them,
// maps only service endpoints to the documented loopback ports, then runs Node.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const allowed = new Set(['scripts/verify-commercial.mjs','scripts/verify-website-knowledge.mjs','scripts/verify-rag.mjs','dist/operations/object-backup.js']);
const script=process.argv[2];
if(!allowed.has(script))throw new Error('Unsupported local acceptance script.');
try {
  const {stdout}=await promisify(execFile)('docker',['compose','config','--format','json'],{maxBuffer:2*1024*1024});
  const configured=JSON.parse(stdout).services.backend.environment;
  const env={...process.env,...Object.fromEntries(Object.entries(configured).map(([k,v])=>[k,String(v)]))};
  const db=new URL(env.DATABASE_URL);db.hostname='127.0.0.1';db.port='55432';env.DATABASE_URL=db.toString();
  env.OBJECT_STORAGE_ENDPOINT='http://127.0.0.1:59000';env.OLLAMA_BASE_URL='http://127.0.0.1:11434';
  env.COMMERCIAL_TEST_API_URL='http://localhost:3001';env.RAG_TEST_API_URL='http://localhost:3001';
  const child=spawn(process.execPath,[script],{env,stdio:'inherit'});
  child.on('exit',code=>{process.exitCode=code??1;});
} catch {console.error('Unable to load local Compose acceptance configuration.');process.exitCode=1;}
