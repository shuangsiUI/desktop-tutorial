import {randomUUID} from 'node:crypto';
// Local bookkeeping only. An allocation records reconciliation, never a payment.
const fail=(message,status=400)=>{const error=new Error(message);error.status=status;throw error};
const text=(value,label,max=200,optional=false)=>{if(optional&&(value===undefined||value===null))return '';if(typeof value!=='string'||value.trim().length>max||(!optional&&!value.trim()))fail(`${label}无效`);return value.trim()};
const amount=(value,label='金额')=>{if(!Number.isSafeInteger(value)||value<=0)fail(`${label}必须为正整数分`);return value};
const safeSum=values=>values.reduce((sum,n)=>{const next=sum+n;if(!Number.isSafeInteger(next))fail('金额合计超出安全范围');return next},0);
function date(value,label,optional=false){if(optional&&(value===undefined||value===null||value===''))return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail(`${label}须为YYYY-MM-DD`);const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)fail(`${label}日期无效`);return value}
const decimal=cents=>{const s=String(cents);return s.length<3?'0.'+s.padStart(2,'0'):s.slice(0,-2)+'.'+s.slice(-2)};
function keys(value,allowed,label){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(`${label}格式或字段无效`)}
export function createFinanceService(db){
  const rows=kind=>db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(row=>JSON.parse(row.body));
  const invoices=()=>rows('replica:invoice'), allocations=()=>rows('replica:allocation');
  const get=id=>{const row=db.prepare("SELECT body FROM records WHERE id=? AND kind='replica:invoice'").get(id);if(!row)fail('账单不存在',404);return JSON.parse(row.body)};
  const atomic=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value}catch(error){db.exec('ROLLBACK');throw error}};
  const put=(kind,record,action)=>{db.prepare('INSERT INTO records(id,kind,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(record.id,kind,JSON.stringify(record));db.prepare('INSERT INTO audit(at,action,object) VALUES(?,?,?)').run(new Date().toISOString(),action,record.id)};
  const view=(record,withAllocations=false)=>({...record,number:record.reference,invoice_date:record.invoiceDate,due_date:record.dueDate,total_charge:decimal(record.totalCents),paid_charge:decimal(record.allocatedCents),remaining_charge:decimal(record.totalCents-record.allocatedCents),remainingCents:record.totalCents-record.allocatedCents,status:record.totalCents===record.allocatedCents?3:2,localOnly:true,...(withAllocations?{allocations:allocations().filter(row=>row.invoiceId===record.id)}:{})});
  return {
    overview(){const grouped=new Map();for(const record of invoices()){let group=grouped.get(record.currency);if(!group){group={currency:record.currency,invoiceCount:0,totalCents:0,allocatedCents:0,remainingCents:0};grouped.set(record.currency,group)}group.invoiceCount++;group.totalCents=safeSum([group.totalCents,record.totalCents]);group.allocatedCents=safeSum([group.allocatedCents,record.allocatedCents]);group.remainingCents=safeSum([group.remainingCents,record.totalCents-record.allocatedCents])}return {accounts:[],balance:null,unpay:null,actual_balance:null,byCurrency:[...grouped.values()].sort((a,b)=>a.currency.localeCompare(b.currency)),localOnly:true}},
    listInvoices(){return invoices().map(record=>view(record))},
    invoice(id){return view(get(text(id,'账单ID')),true)},
    importInvoice(input){return atomic(()=>{
      keys(input,['reference','currency','invoiceDate','dueDate','description','lines'],'账单');
      const reference=text(input.reference,'账单号'),currency=text(input.currency,'币种',3);if(!/^[A-Z]{3}$/.test(currency))fail('币种须为三位大写代码');
      const invoiceDate=date(input.invoiceDate,'账单日期'),dueDate=date(input.dueDate,'到期日期',true);if(dueDate&&dueDate<invoiceDate)fail('到期日期不能早于账单日期');
      const description=text(input.description,'描述',4000,true);
      if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>2000)fail('账单明细须为1至2000条');
      const lineReferences=new Set();const lines=input.lines.map(line=>{keys(line,['shipmentId','reference','description','amountCents'],'账单明细');const ref=text(line.reference,'明细参考号');if(lineReferences.has(ref))fail('账单明细参考号重复');lineReferences.add(ref);return {shipmentId:text(line.shipmentId,'运单ID',200,true)||null,reference:ref,description:text(line.description,'明细描述',4000,true),amountCents:amount(line.amountCents)}});
      const normalized={reference,currency,invoiceDate,dueDate,description,lines};
      const existing=invoices().find(record=>record.reference===reference);if(existing){if(JSON.stringify(existing.source)!==JSON.stringify(normalized))fail('账单号已用于不同内容',409);return view(existing,true)}
      for(const line of lines)if(line.shipmentId&&!db.prepare("SELECT id FROM records WHERE id=? AND kind='replica:shipment'").get(line.shipmentId))fail('关联本地运单不存在');
      const totalCents=safeSum(lines.map(line=>line.amountCents));const now=new Date().toISOString();const record={...normalized,id:randomUUID(),version:1,totalCents,allocatedCents:0,created:now,updated:now,source:normalized};put('replica:invoice',record,'finance:import-local-invoice');return view(record,true);
    })},
    updateInvoice(input){return atomic(()=>{
      keys(input,['id','version','reference','currency','invoiceDate','dueDate','description','lines','reason'],'账单修改');
      const old=get(text(input.id,'账单ID'));if(!Number.isSafeInteger(input.version)||input.version!==old.version)fail('账单已更新，请刷新后重试',409);
      const reason=text(input.reason,'修改原因',2000),reference=text(input.reference,'账单号'),currency=text(input.currency,'币种',3);
      if(!/^[A-Z]{3}$/.test(currency))fail('币种须为三位大写代码');if(old.allocatedCents&&currency!==old.currency)fail('已有核销记录，不可变更币种');
      if(invoices().some(r=>r.id!==old.id&&r.reference===reference))fail('账单号已存在',409);
      const invoiceDate=date(input.invoiceDate,'账单日期'),dueDate=date(input.dueDate,'到期日期',true);if(dueDate&&dueDate<invoiceDate)fail('到期日期不能早于账单日期');
      const description=text(input.description,'描述',4000,true);if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>2000)fail('账单明细须为1至2000条');
      const refs=new Set();const lines=input.lines.map(line=>{keys(line,['shipmentId','reference','description','amountCents'],'账单明细');const reference=text(line.reference,'明细参考号');if(refs.has(reference))fail('账单明细参考号重复');refs.add(reference);const shipmentId=text(line.shipmentId,'运单ID',200,true)||null;if(shipmentId&&!db.prepare("SELECT id FROM records WHERE id=? AND kind='replica:shipment'").get(shipmentId))fail('关联本地运单不存在');return {shipmentId,reference,description:text(line.description,'明细描述',4000,true),amountCents:amount(line.amountCents)}});
      const totalCents=safeSum(lines.map(l=>l.amountCents));if(totalCents<old.allocatedCents)fail('修改后总额不得低于已核销金额');
      const source={reference,currency,invoiceDate,dueDate,description,lines};const snapshot={reference:old.reference,currency:old.currency,invoiceDate:old.invoiceDate,dueDate:old.dueDate,description:old.description,lines:old.lines,totalCents:old.totalCents,version:old.version};
      const record={...old,...source,totalCents,source,version:old.version+1,updated:new Date().toISOString(),revisions:[...(old.revisions||[]),{at:new Date().toISOString(),reason,before:snapshot}]};
      put('replica:invoice',record,'finance:update-local-invoice');return view(record,true);
    })},
    recordAllocation(input){return atomic(()=>{
      keys(input,['invoiceId','version','amountCents','reference'],'核销');const invoiceId=text(input.invoiceId,'账单ID'),reference=text(input.reference,'核销参考号'),amountCents=amount(input.amountCents);
      const existing=allocations().find(record=>record.reference===reference);if(existing){if(existing.invoiceId!==invoiceId||existing.amountCents!==amountCents)fail('核销参考号已用于不同内容',409);return {allocation:existing,invoice:view(get(invoiceId),true),idempotent:true}}
      const record=get(invoiceId);if(!Number.isSafeInteger(input.version)||record.version!==input.version)fail('账单已更新，请刷新后重试',409);if(amountCents>record.totalCents-record.allocatedCents)fail('核销金额超过账单余款');
      const now=new Date().toISOString(),allocation={id:randomUUID(),invoiceId,reference,amountCents,currency:record.currency,created:now,localOnly:true,kind:'local_reconciliation'};
      // Allocation records are append-only. No API updates or deletes them.
      db.prepare('INSERT INTO records(id,kind,body) VALUES(?,?,?)').run(allocation.id,'replica:allocation',JSON.stringify(allocation));db.prepare('INSERT INTO audit(at,action,object) VALUES(?,?,?)').run(now,'finance:record-local-allocation',allocation.id);
      record.allocatedCents=safeSum([record.allocatedCents,amountCents]);record.version++;record.updated=now;put('replica:invoice',record,'finance:reconcile-local-invoice');return {allocation,invoice:view(record,true),idempotent:false};
    })}
  };
}
