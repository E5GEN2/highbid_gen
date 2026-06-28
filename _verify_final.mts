import { readFileSync } from 'fs'; import { execSync } from 'child_process'; import pg from 'pg';
const env=readFileSync('./.env.local','utf8'); for(const l of env.split('\n')){const i=l.indexOf('=');if(i<0)continue;const k=l.slice(0,i).trim();let v=l.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(k&&process.env[k]===undefined)process.env[k]=v;}
process.env.HB_RAILWAY_DB_URL=process.env.DATABASE_URL; process.env.DATABASE_URL='postgresql://localhost:5432/hbgen_local'; process.env.NODE_ENV='development';
const m=await import('./lib/content-gen/listicle-builder'); const loadChannel=(m as any).loadChannel; const fh=(m as any).floorHumanizeNumber;
const KEY=execSync(`/opt/homebrew/opt/postgresql@16/bin/psql -d hbgen_local -t -A -c "SELECT value FROM admin_config WHERE key='elevenlabs_api_key' LIMIT 1;"`).toString().trim();
const local=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false});
const slots=(await local.query(`SELECT script_jsonb FROM content_gen_producer_jobs ORDER BY id DESC LIMIT 1`)).rows[0].script_jsonb.slots;
const dur=(s:any)=>{const n=(s.gems||[]).find((g:any)=>g.id==='narr'); let d=0.8; if(n?.args&&typeof n.args.start_s==='number'&&typeof n.args.end_s==='number')d=n.args.end_s-n.args.start_s; else if(typeof s.hold_s==='number')d=s.hold_s; return d+(typeof s.dwell_s==='number'?s.dwell_s:0);};
const starts:any={}; let t=0; for(const s of slots){starts[s.slot_id]=t; t+=dur(s);}
const chOf=(sid:string)=>{const s=slots.find((x:any)=>x.slot_id===sid); for(const g of (s?.gems||[]))if(g.args?.channelId)return g.args.channelId; return null;};
async function scribe(start:number,end:number){execSync(`ffmpeg -y -hide_banner -loglevel error -ss ${Math.max(0,start-2.5)} -to ${end+2.5} -i clips/_latest.mp4 /tmp/v/s.mp3`);const buf=readFileSync('/tmp/v/s.mp3');const fd=new FormData();fd.append('file',new Blob([buf]),'s.mp3');fd.append('model_id','scribe_v1');const r=await fetch('https://api.elevenlabs.io/v1/speech-to-text',{method:'POST',headers:{'xi-api-key':KEY},body:fd});return ((await r.json() as any).text||'').trim();}
for(let n=1;n<=10;n++){
  const cid=chOf(`niche_${n}_channel_proof_1`)||chOf(`niche_${n}_channel_proof_2`); if(!cid)continue;
  const ch:any=await loadChannel(cid);
  const sids=[`niche_${n}_channel_proof_1`,`niche_${n}_channel_proof_2`].filter(sid=>slots.some((s:any)=>s.slot_id===sid));
  let spoken='';
  for(const sid of sids){const s=slots.find((x:any)=>x.slot_id===sid); spoken+=' '+await scribe(starts[sid], starts[sid]+dur(s));}
  spoken=spoken.replace(/\s+/g,' ').trim();
  console.log(`niche_${n} [${ch.channel_name}] official: ${ch.video_count}vid / ${fh(ch.subscriber_count)} subs / ${fh(ch.total_views)} views`);
  console.log(`   RENDERED VO: "${spoken}"`);
}
process.exit(0);
