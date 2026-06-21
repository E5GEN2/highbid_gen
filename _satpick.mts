import { config } from 'dotenv'; config({ path: './.env.local' });
const { findSimilarChannels } = await import('./lib/content-gen/similar-channels');
const { loadChannel } = await import('./lib/content-gen/listicle-builder');
const { captureYtScreen } = await import('./lib/content-gen/yt-capture');
const HERO = 'UCsUMk7bRY8wXWcpuDo0LHDQ';
const GROUP = ['UC2RkPC-fzVCAdOEwc11Eesw','UCjByBYYazGapmHpD3fd4mpA','UClEH97oWJjrm1PX6ZCEcafQ','UCWbM5p20UDzs1VLGa9ku2Jw','UC6WfwZLK0d3EmG6QCSzQPwA','UCdeUiI5M1FLtKrXQPxdzB-A','UCUmCVRNy7wEOjgbteKyiUZw','UCmKjefsbN1_nOS0rIUdlo9Q'];
const sim:any = await findSimilarChannels(HERO, GROUP);
const pool = (sim.montagePool ?? []).slice(0, 8);
console.log('pool size', pool.length);
for (const cId of pool) {
  try {
    const c = await loadChannel(cId).catch(()=>null);
    const subs = (c as any)?.subscriber_count ?? 0;
    if (subs < 5000) { console.log(cId, 'subs', subs, '<5k skip'); continue; }
    const cap:any = await captureYtScreen(cId, { kind: 'videos_tab', mode: 'static' });
    const cards = Object.keys(cap?.bboxes ?? {}).filter((k:string)=>/^video_card_\d+$/.test(k)).length;
    console.log(cId, '|', (c as any)?.channel_name, '| subs', subs, '| cards', cards, cards>=4?'LIVE':'DEAD');
    if (cards >= 4) { console.log('>>> PICK', cId); break; }
  } catch (e:any) { console.log(cId, 'capfail', String(e?.message||e).slice(0,45)); }
}
process.exit(0);
