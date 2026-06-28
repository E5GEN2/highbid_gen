import { readFileSync } from 'fs'; import path from 'path';
const repoRoot = process.cwd();
for (const l of readFileSync(path.join(repoRoot,'.env.local'),'utf8').split('\n')){const i=l.indexOf('=');if(i<0)continue;const k=l.slice(0,i).trim();let v=l.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(k&&process.env[k]===undefined)process.env[k]=v;}
const pg=(await import('pg')).default;
const prod=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false});
const { classifyRelationship } = await import('./lib/content-gen/channel-b-verify');
const cattie=(await prod.query(`SELECT channel_id FROM niche_spy_channels WHERE channel_name ILIKE '%cattie cute%' LIMIT 1`)).rows[0]?.channel_id;
const tests:any[]=[
  ['Domain→The Recap Mania (expect DIFFERENT)','UCM-XPFv_VoHHxx-77Ux_a_w','Post-apocalyptic sci-fi survival stories','UCeiCVHwwnelyPEamQvNItxw'],
  ['Domain→Scripture Origins (expect DIFFERENT)','UCM-XPFv_VoHHxx-77Ux_a_w','Post-apocalyptic sci-fi survival stories','UCF0YCMEOckri_jHflCnNv9w'],
];
if(cattie) tests.push(['Ponpon→Cattie Cute (positive control, expect SAME)','UC1kxzRPXQ7oCP1Ra07enK5Q','Roblox roleplay romance stories',cattie]);
for(const [label,hid,niche,cid] of tests){
  console.log('\n=== '+label+' ===');
  await classifyRelationship({channelId:hid,nicheLabel:niche,recipeFormula:null} as any, cid, {bypassCache:true});
}
process.exit(0);
