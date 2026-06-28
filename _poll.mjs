import { readFileSync } from 'fs'; import pg from 'pg';
const env=readFileSync('.env.local','utf8'); let url;
for(const l of env.split('\n')){const i=l.indexOf('=');if(i>0&&l.slice(0,i).trim()==='DATABASE_URL'){url=l.slice(i+1).trim().replace(/^['"]|['"]$/g,'');}}
const p=new pg.Pool({connectionString:url,ssl:false});
const JOBID=492;
for(let i=0;i<45;i++){
  const r=(await p.query(`SELECT status,stage,num_clips,num_clips_done,num_clips_failed,total_segments,error_message FROM video_analysis_jobs WHERE id=$1`,[JOBID])).rows[0];
  const t=new Date().toISOString().slice(11,19);
  console.log(`${t} ${r.status} ${r.stage||''} clips=${r.num_clips_done}/${r.num_clips} fail=${r.num_clips_failed} ${r.total_segments?('segs='+r.total_segments):''}`);
  if(r.status==='done'||r.status==='error'){ if(r.error_message)console.log('ERR:',r.error_message); break; }
  await new Promise(s=>setTimeout(s,20000));
}
process.exit(0);
