import path from "node:path";
import { mkdir, open, unlink } from "node:fs/promises";
import { writeJsonAtomic } from "./json-store.js";
import { ingestAsset } from "./media.js";
import { getPrimaryGeneration, importPrimaryGeneration, recordPrimaryFailure, submitPrimaryGeneration } from "./primary-generation.js";

const ORIGIN = "https://api.minimax.cn";
function credential(): string {
  const value = process.env.MINIMAX_API_KEY;
  if (!value?.trim()) throw new Error("MINIMAX_API_KEY is missing; load the configured User credential through video.ps1");
  return value;
}
async function apiJson(url: string, method: "GET" | "POST", body?: unknown): Promise<any> {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN || parsed.username || parsed.password || parsed.hash) throw new Error("Only the official configured MiniMax API origin is permitted");
  const response = await fetch(url, {
    method, redirect: "error", signal: AbortSignal.timeout(25_000),
    headers: { Authorization: `Bearer ${credential()}`, ...(method === "POST" ? {"Content-Type":"application/json"} : {}) },
    ...(method === "POST" ? {body: JSON.stringify(body)} : {}),
  });
  let result: any;
  try { result = await response.json(); } catch { throw new Error(`MiniMax returned non-JSON (HTTP ${response.status}); no paid retry is permitted`); }
  if (!response.ok || (result.base_resp && result.base_resp.status_code !== 0)) {
    const serviceCode = result.base_resp?.status_code ?? String(result.error?.message ?? "").match(/\((\d+)\)/)?.[1] ?? "unknown";
    throw new Error(`MiniMax HTTP ${response.status}, service code ${serviceCode}; submission outcome must be reconciled before any paid retry`);
  }
  return result;
}

/** Exactly one charged POST under the core project lock and frozen execution claim. */
export async function submitMinimaxPrimary(input: {projectDir: string; jobId: string; contractHash: string}) {
  credential();
  return submitPrimaryGeneration({...input, executor:"core-minimax-primary-v1"}, async ({endpoint, payload}) => {
    const result = await apiJson(endpoint, "POST", payload);
    if (typeof result.task_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.task_id)) throw new Error("MiniMax did not return a valid task_id; reserve retained, do not resubmit");
    return result.task_id;
  });
}

export async function queryMinimaxPrimary(input: {projectDir: string; jobId: string}) {
  const {contract, ledger} = await getPrimaryGeneration({projectDir:input.projectDir});
  const job = contract.jobs.find(j => j.id === input.jobId);
  const claim = ledger.claims.find(c => c.jobId === input.jobId);
  if (!job || !claim?.taskId || !["submitted","imported"].includes(claim.state)) throw new Error("A submitted core claim with a recorded taskId is required");
  const result = await apiJson(`${ORIGIN}/v2/query/video_generation/${encodeURIComponent(claim.taskId)}`, "GET");
  const task = result.task;
  if (!task || task.id !== claim.taskId) throw new Error("MiniMax query task identity does not match the core claim");
  for (const field of ["model","resolution","duration","ratio"] as const) {
    if (task[field] !== undefined && task[field] !== job.payload[field]) throw new Error(`MiniMax returned unexpected ${field}`);
  }
  const receiptDir = path.join(input.projectDir,"primary-provider");
  await mkdir(receiptDir,{recursive:true});
  await writeJsonAtomic(path.join(receiptDir,`${job.id}.latest-query.json`), {checkedAt:new Date().toISOString(),claimHash:claim.claimHash,contractHash:contract.contractHash,result});
  if (["failed","cancelled","canceled"].includes(task.status) && claim.state !== "imported") {
    await recordPrimaryFailure({projectDir:input.projectDir,jobId:input.jobId,claimHash:claim.claimHash,reason:`Provider terminal status: ${task.status}; budget reserve retained`});
  }
  return {jobId:job.id, taskId:task.id, status:task.status, claimHash:claim.claimHash, task};
}

function assertMediaUrl(url: string): void {
  const value = new URL(url);
  const allowed = ["hailuoai.com","minimax.chat","minimax.cn","minimaxi.com","minimax.io"];
  // This exact object-storage bucket was returned by the authenticated official v2 task API.
  const officialTaskStorage = value.hostname === "algeng-video-infer.oss-cn-shanghai.aliyuncs.com";
  if (value.protocol !== "https:" || value.port && value.port !== "443" || value.username || value.password
    || !officialTaskStorage && !allowed.some(host => value.hostname === host || value.hostname.endsWith(`.${host}`))) throw new Error("Generated media must use an official MiniMax HTTPS CDN or its verified task-storage bucket");
}

/** Download is part of producing the authorized editable video, with no API credential on CDN requests. */
export async function downloadMinimaxPrimary(input: {projectDir:string; jobId:string; outputPath:string}) {
  const queried = await queryMinimaxPrimary(input);
  if (queried.status !== "succeeded" || typeof queried.task.content?.url !== "string") throw new Error(`Generated media is not ready (${queried.status})`);
  let mediaUrl = queried.task.content.url;
  let response: Response | undefined;
  for (let hop=0;hop<6;hop++) {
    assertMediaUrl(mediaUrl);
    response = await fetch(mediaUrl,{redirect:"manual",signal:AbortSignal.timeout(60_000)});
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Generated media redirect has no location");
      mediaUrl = new URL(location,mediaUrl).href;
      response = undefined;
    } else break;
  }
  if (!response?.ok || !response.body) throw new Error(`Generated media download failed (HTTP ${response?.status ?? "redirect-limit"})`);
  const outputPath = path.resolve(input.outputPath);
  await mkdir(path.dirname(outputPath),{recursive:true});
  const handle = await open(outputPath,"wx");
  let sizeBytes = 0, completed = false;
  try {
    for await (const chunk of response.body) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > 500*1024*1024) throw new Error("Generated media exceeds the local download limit");
      let offset = 0;
      while (offset < chunk.byteLength) {
        const {bytesWritten} = await handle.write(chunk,offset,chunk.byteLength-offset);
        if (bytesWritten === 0) throw new Error("Generated media could not be written completely");
        offset += bytesWritten;
      }
    }
    await handle.sync();
    completed = true;
  } finally {
    await handle.close();
    if (!completed) await unlink(outputPath);
  }
  const imported = await importPrimaryGeneration({projectDir:input.projectDir,jobId:input.jobId,claimHash:queried.claimHash,taskId:queried.taskId,videoPath:outputPath});
  const registered = await ingestAsset({projectDir:input.projectDir,assetPath:outputPath,role:"supplemental",provenance:"ai-generated-minimax-primary"});
  return {jobId:input.jobId,taskId:queried.taskId,path:outputPath,sizeBytes,imported,registered};
}
