// A stand-in for NEAR mainnet RPC, for testing mainnet/verify.mjs without a network. Its values were
// read live from mainnet on 2026-11-12 (keys, policy, spend, code hashes); the record, ledger and
// balances follow the README's v2 run. With bad: true it plants three faults the checks must catch:
// Cara's agent key widened to set_rules, a wrong reason_hash on Dan's exit, and NEAR books off.
// With round3: true it adds what the third run leaves on chain: the DAO lock, Alice, Dan and Emma
// joining again, market keys, bid funds and one share sale. sale: 'below' plants a sale under its reserve,
// and autoUpdate: true turns the DAO's factory auto-update back on.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);

export function startMock({ bad = false, round3 = false, sale = 'ok', autoUpdate = false } = {}) {
const BAD = bad, R3 = round3;
const N=(s)=>`${s}.dissentfinance.near`, V='vault2.dissentfinance.near', DAO='dissentfinance.sputnik-dao.near', USDC='17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const notes=Object.fromEntries(['alice','dan','emma'].map(m=>[N(m),JSON.parse(fs.readFileSync(path.join(here,'..','..','mainnet','notes','vault2',`0-${N(m)}.json`)))]));
const ts=(iso)=>String(BigInt(Date.parse(iso))*1000000n);
const ev=(event,data,at)=>JSON.stringify({standard:'dissent',version:'2.0.0',event,data:[data],ts:ts(at)});
const record=[];
for(const m of ['alice','ben','cara','dan','emma']) record.push(ev('join',{account_id:N(m),shares:'100',near:'100000000000000000000000',usdc:'200000'},'2026-11-12T13:10:00Z'));
record.push(ev('queue_spend',{spend_id:0,proposal_id:1,recipient:N('ben'),amount:'600000',approve:2,not_approve:0},'2026-11-12T13:31:09.844Z'));
for(const [m,t] of [['alice','13:31:17'],['dan','13:31:17'],['emma','13:31:18']]) record.push(ev('exit',{account_id:N(m),shares:'100',near:'100000000000000000000000',usdc:'200000',reason_hash:BAD&&m==='dan'?'00':notes[N(m)].hash},`2026-11-12T${t}Z`));
record.push(ev('cancel_spend',{spend_id:0,by:N('emma')},'2026-11-12T13:31:21Z'));
const offer={id:0,seller:N('cara'),shares:'50',reserve:'90000',ends_at:ts('2026-11-13T15:10:00Z'),best_bidder:N('dan'),best_bid:sale==='below'?'80000':'97000',bids:3,status:'Sold'};
if(R3){
 for(const m of ['alice','dan','emma']) record.push(ev('join',{account_id:N(m),shares:'50',near:'51000000000000000000000',usdc:'100000'},'2026-11-13T15:00:00Z'));
 record.push(ev('offer',{offer_id:0,seller:N('cara'),shares:'50',reserve:'90000',ends_at:offer.ends_at},'2026-11-13T15:00:10Z'));
 record.push(ev('share_sale',{offer_id:0,seller:N('cara'),buyer:N('dan'),shares:'50',usdc:'97000',bids:3},'2026-11-13T15:10:05Z'));
}
const fc=(r,methods)=>({access_key:{permission:{FunctionCall:{allowance:'1',method_names:methods??(BAD&&r==='x'?['exit','set_rules']:['exit','cancel_spend']),receiver_id:r}}}});
const marketKey=(a)=>R3&&['alice','dan','emma','cara'].map(N).includes(a)?[fc(V,['bid','settle_offer'])]:[];
const args=Buffer.from(JSON.stringify({proposal_id:1,recipient:N('ben'),token_id:USDC,amount:'600000',memo:'group spend'})).toString('base64');
const views={
 [V]:{contract_source_metadata:{link:'https://github.com/QijomoFav35/Dissent-Finance/tree/6ae02598ff28e45046523b940a6bcf061705fe50'},
  get_config:{dao:DAO,usdc:USDC,fee_account:'dissentfinance.near',window_ns:'600000000000'},
  get_spend:{id:0,proposal_id:1,recipient:N('ben'),token:'Usdc',amount:'600000',memo:'group spend',approvers:[N('ben'),N('cara')],objectors:[],queued_at:'1794490269844300751',window_ends:'1794490869844300751',status:'Cancelled'},
  get_record_len:record.length,get_record:record,
  get_balances:{near:'200000000000000000000000',usdc:'400000',total_shares:'200',members:2,open_spends:0},
  get_members:[[N('ben'),'100'],[N('cara'),'100']],
  get_ledger:(a)=>a.token==='Usdc'?{balance:'400000',in_flight:'0',claimable:'0',pending_joins:'0',deposited:'1000000',spent:'0',fees:'0',exited:'600000',refunded:'0',held:'0'}:{balance:'200000000000000000000000',in_flight:'0',claimable:'0',pending_joins:'0',deposited:'500000000000000000000000',spent:'0',fees:'0',exited:BAD?'1':'300000000000000000000000',refunded:'0',held:'0'},
  get_shares:(a)=>[N('ben'),N('cara')].includes(a.account_id)?'100':R3&&[N('alice'),N('dan'),N('emma')].includes(a.account_id)?'50':'0',
  ...(R3?{get_bid_funds_totals:['300000','300000'],get_open_spends:[],get_holds:[],get_offers:(a)=>a.from_index===0?[offer]:[],get_offer_count:1}:{})},
 [DAO]:{get_policy:{roles:[{name:'council',kind:{Group:['ben','emma','dan','alice','cara'].map(N)},permissions:['*:*'],vote_policy:{}}],default_vote_policy:{weight_kind:'RoleWeight',quorum:'0',threshold:'2'}},
  get_factory_info:{factory_id:'sputnik-dao.near',auto_update:autoUpdate},
  get_proposal:{id:1,proposer:N('ben'),description:'pay Ben',kind:{FunctionCall:{receiver_id:V,actions:[{method_name:'queue_spend',args,deposit:'0',gas:'60000000000000'}]}},status:'Approved',votes:{[N('ben')]:'Approve',[N('cara')]:'Approve'}}},
 'sputnik-dao.near':{get_default_code_hash:'DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF',get_default_version:[3,2]},
 [USDC]:{ft_balance_of:R3?'700000':'400000'},
};
const server = http.createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{
 const j=JSON.parse(b),p=j.params;let result,error;
 if(j.method==='block')result={header:{height:224230702}};
 else if(j.method==='tx'){const who=p.sender_account_id;result={receipts_outcome:[{outcome:{logs:['EVENT_JSON:'+JSON.stringify({event:'exit',data:[{account_id:who,reason_hash:notes[who]?.hash}]})]}}]};}
 else if(p.request_type==='view_account')result=p.account_id===DAO?{code_hash:'11111111111111111111111111111111',global_contract_hash:'DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF'}:{code_hash:'2CkdfmNBiPGukvkBpRm1AygHERiGDdPXf23eXPL58uVM'};
 else if(p.request_type==='view_access_key_list')result=p.account_id===V?{keys:[{access_key:{permission:'FullAccess'}}]}:{keys:[{access_key:{permission:'FullAccess'}},fc(BAD&&p.account_id===N('cara')?'x':V),fc('vault.dissentfinance.near'),...marketKey(p.account_id)]};
 else{const a=JSON.parse(Buffer.from(p.args_base64,'base64').toString());let v=views[p.account_id]?.[p.method_name];if(typeof v==='function')v=v(a);if(v===undefined)error={name:'METHOD_NOT_FOUND',m:p.method_name};else result={result:[...Buffer.from(JSON.stringify(v))]};}
 res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,...(error?{error}:{result})}));
});});
return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
