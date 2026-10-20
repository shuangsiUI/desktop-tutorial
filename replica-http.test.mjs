import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const cwd=dirname(fileURLToPath(import.meta.url));
const root='http://127.0.0.1:4196';
const address={type:'booking',address_name:'HTTP本地测试',name:'本地测试联系人',code:'LOCAL-HTTP-ADDR',address_1:'测试地址',city:'测试市',country:'CN',postcode:'000000'};
test('新版HTTP静态资源、地址版本操作及重启持久化',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'replica-http-'));let child;
  async function start(){await new Promise((resolve,reject)=>{let output='';child=spawn(process.execPath,['server.mjs'],{cwd,env:{...process.env,PORT:'4196',DB_PATH:join(dir,'test.sqlite')},stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill();reject(Error('启动超时 '+output))},10000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes(root)){clearTimeout(timer);resolve()}});child.stderr.on('data',chunk=>{output+=chunk});child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('exit',code=>{clearTimeout(timer);reject(Error('服务退出 '+code+' '+output))})})}
  async function stop(){if(!child||child.exitCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill()})}
  async function api(path,body,{status=200,headers={}}={}){const response=await fetch(root+'/api/replica/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data}
  try {
    await start();
    for(const path of ['/','/tms/wos/myaddress']){const response=await fetch(root+path);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/html/);const html=await response.text();assert.doesNotMatch(html,/航序/);assert.match(html,/src="\/replica\.js"/);assert.match(html,/href="\/replica\.css"/)}
    for(const[path,type]of [['/replica.js','text/javascript'],['/replica.css','text/css'],['/replica-config.json','application/json'],['/assets/xlsx.full.min.js','text/javascript']]){const response=await fetch(root+path);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),new RegExp('^'+type));assert.ok((await response.arrayBuffer()).byteLength>100);assert.equal(response.headers.get('x-content-type-options'),'nosniff')}
    assert.deepEqual(await api('address'),[]);assert.deepEqual(await api('ticket'),[]);
    const emptyFinance=await api('finance');assert.deepEqual(emptyFinance.accounts,[]);assert.equal(emptyFinance.balance,null);assert.equal(emptyFinance.actual_balance,null);assert.deepEqual(emptyFinance.byCurrency,[]);assert.deepEqual(await api('account'),[]);assert.deepEqual(await api('recharge'),[]);assert.deepEqual(await api('invoice'),[]);
    const invoiceInput={reference:'HTTP-LOCAL-INVOICE',currency:'GBP',invoiceDate:'2026-10-20',description:'HTTP本地账务测试',lines:[{reference:'HTTP-LINE',description:'本地记录',amountCents:12345}]};
    const imported=await api('finance/import',invoiceInput);assert.equal(imported.totalCents,12345);assert.equal(imported.status,2);assert.equal((await api('invoice'))[0].id,imported.id);
    const replay=await api('finance/import',invoiceInput);assert.equal(replay.id,imported.id);assert.equal((await api('invoice')).length,1);
    await api('finance/import',{...invoiceInput,currency:'USD'},{status:409});
    const allocationInput={invoiceId:imported.id,version:1,amountCents:345,reference:'HTTP-LOCAL-ALLOCATION'};
    const allocated=await api('finance/allocate',allocationInput);assert.equal(allocated.invoice.remainingCents,12000);assert.equal(allocated.invoice.version,2);assert.equal(allocated.allocation.localOnly,true);
    const allocationReplay=await api('finance/allocate',allocationInput);assert.equal(allocationReplay.idempotent,true);assert.equal(allocationReplay.allocation.id,allocated.allocation.id);
    await api('finance/allocate',{...allocationInput,amountCents:346},{status:409});
    await api('finance/allocate',{...allocationInput,reference:'STALE-ALLOC'},{status:409});
    await api('finance/allocate',{...allocationInput,version:2,amountCents:12001,reference:'OVER-ALLOC'},{status:400});
    const detail=await api('invoice/'+imported.id);assert.equal(detail.allocations.length,1);assert.equal(detail.remaining_charge,'120.00');assert.equal(detail.total_charge,'123.45');assert.equal(detail.paid_charge,'3.45');
    await api('invoice/missing',undefined,{status:404});
    const finance=await api('finance');assert.deepEqual(finance.byCurrency,[{currency:'GBP',invoiceCount:1,totalCents:12345,allocatedCents:345,remainingCents:12000}]);assert.equal(finance.balance,null);assert.deepEqual(await api('account'),[]);assert.deepEqual(await api('recharge'),[]);
    const shipmentInput=reference=>({values:{service:'HP40P',client_reference:reference,name:'HTTP Local Recipient',address_1:'HTTP Local Address',city:'Test City',state:'Test State',postcode:'TEST',country:'GB',eori:'LOCAL-EORI',vat_number:'LOCAL-VAT'},parcels:[{number:'BOX-1',client_weight:10,client_length:10,client_width:10,client_height:10,name_zh:'本地测试',name_en:'Local test',unit_value:'1.23',qty:2,material:'Test',usage:'Test',sale_url:'https://example.invalid/local',hscode:'0001234567'}],parcel_count:1});
    const batch=await api('shipment/batch',{inputs:[shipmentInput('HTTP-BATCH-1'),shipmentInput('HTTP-BATCH-2')]});assert.equal(batch.length,2);assert.equal((await api('shipment')).length,2);assert.equal(batch[0].declarationCents,246);
    const auditBefore=(await(await fetch(root+'/api/state')).json()).audit.length;
    const invalidSecond=shipmentInput('HTTP-BATCH-INVALID');invalidSecond.parcels[0].qty=0;
    await api('shipment/batch',{inputs:[shipmentInput('HTTP-BATCH-ROLLBACK'),invalidSecond]},{status:400});assert.equal((await api('shipment')).length,2);assert.equal((await(await fetch(root+'/api/state')).json()).audit.length,auditBefore);
    await api('shipment/batch',{inputs:[shipmentInput('HTTP-BATCH-DUPLICATE'),shipmentInput('HTTP-BATCH-DUPLICATE')]},{status:400});assert.equal((await api('shipment')).length,2);
    await api('shipment/batch',{inputs:[]},{status:400});await api('shipment/batch',{inputs:Array(101).fill(shipmentInput('LIMIT'))},{status:400});await api('shipment/batch',{},{status:400});
    const created=await api('address',{values:address});assert.equal(created.version,1);assert.equal(created.type,'booking');assert.equal((await api('address'))[0].id,created.id);
    const booking=await api('booking',{values:{address_id:created.id,box_count:1,weight:10,booking_time:'2026-10-21'}});
    const [cancelledBooking]=await api('booking/cancel',{ids:[booking.id],versions:{[booking.id]:1},note:'HTTP本地取消'});assert.equal(cancelledBooking.status,'cancelled');assert.equal(cancelledBooking.cancellation.scope,'local');
    await api('booking',{id:booking.id,version:2,values:{remark:'不可修改'}},{status:400});
    await api('booking/cancel',{ids:[booking.id],versions:{[booking.id]:1}},{status:409});
    const cabin=await api('cabin',{values:{cabin_resource_id:'LOCAL-HTTP-RESOURCE',scheduled_capacity:10,deploy_type:'fixed'}});
    const [cancelledCabin]=await api('cabin/cancel',{ids:[cabin.id],versions:{[cabin.id]:1}});assert.equal(cancelledCabin.status,'cancel');assert.equal(cancelledCabin.version,2);
    const rejected=await api('address',{values:{...address,code:'FORBIDDEN'}},{status:400,headers:{Origin:'https://untrusted.example'}});assert.match(rejected.error,/来源不允许/);
    const missing=await api('address',{values:{type:'booking'}},{status:400});assert.match(missing.error,/不能为空/);
    const unknown=await api('address',{values:{...address,unknown:'value'}},{status:400});assert.match(unknown.error,/不允许字段/);
    for(const raw of ['{invalid','null','[]']){const response=await fetch(root+'/api/replica/address',{method:'POST',headers:{'Content-Type':'application/json'},body:raw});assert.equal(response.status,400);assert.equal(typeof(await response.json()).error,'string')}
    const wrongType=await fetch(root+'/api/replica/address',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});assert.equal(wrongType.status,400);assert.match((await wrongType.json()).error,/仅支持JSON/);
    await api('ticket',{values:{}},{status:400});assert.deepEqual(await api('ticket'),[]);
    const updated=await api('address',{id:created.id,version:1,values:{address_name:'HTTP已更新'}});assert.equal(updated.version,2);assert.equal(updated.code,address.code);
    await api('address',{id:created.id,version:1,values:{address_name:'旧版'}},{status:409});
    await stop();await start();assert.equal((await api('shipment')).length,2);const persistedInvoice=await api('invoice/'+imported.id);assert.equal(persistedInvoice.version,2);assert.equal(persistedInvoice.allocations.length,1);assert.equal(persistedInvoice.remainingCents,12000);assert.equal((await api('finance')).balance,null);const persisted=await api('address');assert.equal(persisted.length,1);assert.equal(persisted[0].address_name,'HTTP已更新');assert.equal(persisted[0].version,2);
    await api('address/archive',{ids:[created.id],versions:{[created.id]:1}},{status:409});assert.equal((await api('address')).length,1);
    const archived=await api('address/archive',{ids:[created.id],versions:{[created.id]:2}});assert.equal(archived[0].archived,true);assert.equal(archived[0].version,3);assert.deepEqual(await api('address'),[]);
    await stop();await start();assert.deepEqual(await api('address'),[]);assert.deepEqual(await api('ticket'),[]);
  }finally{await stop();rmSync(dir,{recursive:true,force:true})}
});
