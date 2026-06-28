import { readFileSync, writeFileSync } from 'fs'; import pg from 'pg';
const env=readFileSync('.env.local','utf8'); let url;
for(const l of env.split('\n')){const i=l.indexOf('=');if(i>0&&l.slice(0,i).trim()==='DATABASE_URL'){url=l.slice(i+1).trim().replace(/^['"]|['"]$/g,'');}}
const JOBID=492;
const OUT='/Users/rofe/Desktop/lab/hbgen/whyou-gen/analysis/refvideo_analysis_492.json';
for(let i=0;i<60;i++){
  let r;
  try{
    const p=new pg.Pool({connectionString:url,ssl:false,connectionTimeoutMillis:8000});
    r=(await p.query(`SELECT status,stage,num_clips,num_clips_done,num_clips_failed,total_segments,error_message FROM video_analysis_jobs WHERE id=$1`,[JOBID])).rows[0];
    if(r.status==='done'){ const tl=(await p.query(`SELECT timeline_jsonb FROM video_analysis_jobs WHERE id=$1`,[JOBID])).rows[0].timeline_jsonb; if(tl) writeFileSync(OUT, JSON.stringify(tl,null,2)); }
    await p.end();
  }catch(e){ console.log(new Date().toISOString().slice(11,19),'db-err',e.code||String(e.message).slice(0,40)); await new Promise(s=>setTimeout(s,15000)); continue; }
  const t=new Date().toISOString().slice(11,19);
  console.log(`${t} ${r.status} ${r.stage||''} clips=${r.num_clips_done}/${r.num_clips} fail=${r.num_clips_failed} ${r.total_segments?('segs='+r.total_segments):''}`);
  if(r.status==='done'){ console.log('SAVED '+OUT); break; }
  if(r.status==='error'){ console.log('ERROR: '+r.error_message); break; }
  await new Promise(s=>setTimeout(s,15000));
}
process.exit(0);
