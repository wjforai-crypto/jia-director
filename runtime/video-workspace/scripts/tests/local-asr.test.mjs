import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalAsr} from '../local-asr.mjs';

test('ASR module loads without excluded speech-generation modules; unconfigured ASR fails clearly',async()=>{
  const result=await createLocalAsr({},path.join(os.tmpdir(),'config.json'))({audioPath:'unused',outputDir:'unused'});
  assert.equal(result.status,'unverified');assert.equal(result.code,'ASR_NOT_CONFIGURED');
});

test('ASR-only route binds source and model and retains original transcript without speech synthesis',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jia-public-asr-'));
  const executable=path.join(root,'whisper-cli.exe'),model=path.join(root,'small.bin'),audio=path.join(root,'source.wav'),output=path.join(root,'out');
  await fs.writeFile(executable,'fixture');await fs.writeFile(model,'fixture-model');await fs.writeFile(audio,'fixture-audio');await fs.mkdir(output);
  const sha=createHash('sha256').update('fixture-model').digest('hex');
  const calls=[];
  const run=async(exe,args)=>{
    calls.push({exe,args});
    if(exe===executable){const prefix=args[args.indexOf('-of')+1];await fs.writeFile(prefix+'.json',JSON.stringify({transcription:[{text:'原声台词'}]}));}
  };
  const config={asr:{engine:'whisper.cpp',executable,modelPath:model,jobsRoot:root,modelSha256:sha,modelName:'small',language:'zh'}};
  const result=await createLocalAsr(config,path.join(root,'config.json'),{run})({audioPath:audio,outputDir:output});
  assert.equal(result.status,'transcribed');assert.equal(result.text,'原声台词');assert.equal(result.modelSha256,sha);
  assert.equal(result.apiRequests,0);assert.equal(calls.length,2);assert.ok(calls[1].args.includes('-sow'));
  const saved=JSON.parse(await fs.readFile(path.join(output,'asr.receipt.json'),'utf8'));
  assert.equal(saved.humanReviewed,false);assert.equal(saved.audioSha256,createHash('sha256').update('fixture-audio').digest('hex'));
});
