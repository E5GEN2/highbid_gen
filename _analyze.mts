import { readFileSync, writeFileSync } from 'fs';
for (const l of readFileSync('.env.local','utf8').split('\n')){const i=l.indexOf('=');if(i<0)continue;const k=l.slice(0,i).trim();let v=l.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(k&&!process.env[k])process.env[k]=v;}
const apiKey = process.env.PAPAI_API_KEY!;
const { planChunks, extractChunks, analyzeVideoChunk, mergeChunkResults } = await import('./lib/gemini-files');
const fileUrl = 'file:///tmp/v/refvideo.mp4';
const duration = 605.5;
const chunks = planChunks(duration);
console.log(`planned ${chunks.length} chunks`);
const extracted = await extractChunks(fileUrl, chunks, (e,t)=>process.stdout.write(`\r  extract ${e}/${t}`));
console.log(`\n  extracted ${extracted.size}`);
let done=0;
const results = await Promise.all(chunks.map((c:any) => analyzeVideoChunk(fileUrl, apiKey, c, extracted)
  .then((r:any)=>{done++;process.stdout.write(`\r  analyzed ${done}/${chunks.length}`);return r;})
  .catch((e:any)=>{console.log(`\n  chunk ${c.index} FAILED: ${e.message.slice(0,80)}`);return null;})));
const valid = results.filter(Boolean) as any[];
const merged = mergeChunkResults(valid);
console.log(`\n=== ${merged.analysis.total_segments} segments | ${Math.round(merged.analysis.video_duration_seconds)}s | tokens ${merged.tokens_in}/${merged.tokens_out} | ${valid.length}/${chunks.length} chunks ok ===`);
writeFileSync('/tmp/v/refvideo_analysis.json', JSON.stringify(merged.analysis, null, 2));
console.log('saved /tmp/v/refvideo_analysis.json');
process.exit(0);
