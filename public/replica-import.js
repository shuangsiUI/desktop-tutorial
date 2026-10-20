import {renderFields,readValues,flattenFields,mergeFormColumns,fillParcelNumbers} from './replica-modules.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=v=>String(v??'').replace(/<[^>]*>/g,'').replace(/[＊*]/g,'').trim();
export function parseParcelSheet(XLSX, workbook, tableColumns) {
  const sheet=workbook.Sheets[workbook.SheetNames[0]];if(!sheet)throw Error('工作簿没有可读取的工作表');
  // raw:true preserves strings and leading zeroes stored as text. Numeric Excel cells stay numeric.
  const data=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:''}).filter(row=>row.some(v=>String(v).trim()!==''));
  if(data.length<2)throw Error('请提供表头和至少一行货箱数据');
  if(data.length>2001)throw Error('货箱数据最多 2000 行');
  const headers=data[0].map(label), indices=new Map();
  for(const col of tableColumns) {const matches=headers.map((h,i)=>h===label(col.label)||h===col.name?i:-1).filter(i=>i>=0);if(matches.length>1)throw Error(`重复表头：${label(col.label)}`);if(matches.length)indices.set(col.name,matches[0]);}
  for(const col of tableColumns.filter(c=>c.verify || /[*＊]/.test(c.label)))if(!indices.has(col.name))throw Error(`缺少表头：${label(col.label)}`);
  const errors=[];
  const parcels=data.slice(1).map((row,i)=>Object.fromEntries(tableColumns.map(col=>{
    const value=indices.has(col.name)?String(row[indices.get(col.name)]??'').trim():'';
    if((col.verify || /[*＊]/.test(col.label))&&!value)errors.push(`第 ${i+2} 行：${label(col.label)}不能为空`);
    if(value && ['client_weight','client_length','client_width','client_height','unit_value','qty'].includes(col.name)&&(!Number.isFinite(Number(value))||Number(value)<=0))errors.push(`第 ${i+2} 行：${label(col.label)}必须为正数`);
    if(value&&col.name==='qty'&&!Number.isInteger(Number(value)))errors.push(`第 ${i+2} 行：数量必须为整数`);
    return [col.name,value];
  })));
  if(errors.length)throw Error(errors.slice(0,12).join('\n')+(errors.length>12?`\n另有 ${errors.length-12} 项错误`:''));
  return fillParcelNumbers(parcels);
}
export function openParcelImport(ctx,config,{onComplete}={}) {
  if(!window.XLSX){ctx.notify('Excel读取组件未加载，请刷新页面');return;}
  const profiles=config.shipmentProfiles||{},services=Object.keys(profiles);if(!services.length){ctx.notify('暂无已采集服务，无法导入');return;}
  let service=services[0],values={},parcels=[],filename='',columns;
  const draw=()=>{
    const profile=profiles[service];columns=mergeFormColumns(config.pages.shipment.form.form.columns,profile.form.columns);
    const serviceDef=flattenFields(columns).find(f=>f.name==='service');if(serviceDef){serviceDef.options=services.map(value=>({value,label:value}));serviceDef.required=true;}
    values.service=service;
    const tableColumns=profile.excelTableData.tableColumns;
    ctx.openDialog('货箱表导入',`<p>将一张货箱表导入为一票本地运单。收件资料在下方填写；与原站完整订单多单导入仍有差距。</p><p>支持 XLSX / CSV，文件不超过 5 MB，最多 2000 行。同一箱的多个 SKU 请重复填写相同箱号。前导零请在源文件中按文本保存，数值误转换无法恢复。</p><div class="drawer-fields">${renderFields(columns,values)}</div><div class="form-row"><span>货箱表</span><input type="file" id="parcelImportFile" accept=".xlsx,.xls,.csv"><button class="btn btn-grey" type="button" id="parcelTemplate">下载货箱模板</button></div><div id="parcelImportPreview">${filename?`<p>${esc(filename)}：已读取 ${parcels.length} 行，共 ${new Set(parcels.map(p=>p.number)).size} 箱</p>`:'<p>请选择文件并预览</p>'}</div><div class="form-footer"><button class="btn btn-green" type="submit" id="saveParcelImport" ${parcels.length?'':'disabled'}>保存本地运单</button><button class="btn btn-grey" type="button" id="closeParcelImport">关闭</button></div>`,async(fd,form)=>{
      if(!parcels.length)throw Error('请先选择有效货箱表');
      const next=await readValues(form,columns,{});
      const result=await ctx.api('/api/replica/shipment',{values:next,parcels,parcel_count:new Set(parcels.map(p=>p.number)).size,fba_shipment:false});
      ctx.closeDialog();ctx.notify('货箱表已保存为一票本地运单');await onComplete?.(result);
    });
    document.getElementById('closeParcelImport').onclick=()=>ctx.closeDialog();
    const serviceSelect=document.querySelector('#replicaForm [name=service]');if(serviceSelect)serviceSelect.onchange=async()=>{values=await readValues(document.getElementById('replicaForm'),columns,values);service=serviceSelect.value;parcels=[];filename='';draw();};
    document.getElementById('parcelTemplate').onclick=()=>{const book=window.XLSX.utils.book_new();const sheet=window.XLSX.utils.aoa_to_sheet([tableColumns.map(c=>label(c.label))]);window.XLSX.utils.book_append_sheet(book,sheet,'货箱表');window.XLSX.writeFile(book,'货箱模板-'+service+'.xlsx');};
    document.getElementById('parcelImportFile').onchange=async event=>{
      parcels=[];filename='';document.getElementById('saveParcelImport').disabled=true;
      const file=event.target.files[0];if(!file)return;
      try{
        if(file.size>5*1024*1024)throw Error('文件不能超过 5 MB');if(!/\.(xlsx|xls|csv)$/i.test(file.name))throw Error('仅支持 XLSX 或 CSV 文件');
        const buffer=await file.arrayBuffer();const workbook=window.XLSX.read(buffer,{type:'array',raw:true,cellDates:false});parcels=parseParcelSheet(window.XLSX,workbook,tableColumns);filename=file.name;
        document.getElementById('parcelImportPreview').innerHTML=`<p>${esc(filename)}：${parcels.length} 行，共 ${new Set(parcels.map(p=>p.number)).size} 箱；预览前 10 行。</p><div class="table-wrap"><table class="data-table"><thead><tr>${tableColumns.map(c=>`<th>${esc(label(c.label))}</th>`).join('')}</tr></thead><tbody>${parcels.slice(0,10).map(p=>`<tr>${tableColumns.map(c=>`<td>${esc(p[c.name])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        document.getElementById('saveParcelImport').disabled=false;
      }catch(error){document.getElementById('parcelImportPreview').innerHTML=`<pre style="white-space:pre-wrap;color:#c0392b">${esc(error.message)}</pre>`;ctx.notify(error.message);}
    };
  };
  draw();
}
const originalFields={
 '客户订单号':'client_reference','服务':'service','收件人姓名':'name','收件人公司':'company','收件人地址一':'address_1','收件人地址二':'address_2','收件人地址三':'address_3','收件人城市':'city','收件人省份/州':'state','收件人邮编':'postcode','收件人国家代码(二字代码)':'country','收件人国家代码':'country','收件人电话':'tel','收件人邮箱':'email','申报币种':'declaration_currency',
 '发件人姓名':'form_name','发件人公司':'form_company','发件人地址一':'form_address_1','发件人地址二':'form_address_2','发件人地址三':'form_address_3','发件人城市':'form_city','发件人省份/州':'form_state','发件人邮编':'form_postcode','发件人国家代码(二字代码)':'form_country','发件人电话':'form_tel','发件人邮箱':'form_email',
 '报关方式':'exportwith','清关方式':'importwith','交税方式':'taxwith','交货条款':'deliverywith','VAT号':'vat_number','EORI':'eori','店铺':'store_id','地址库编码':'to_warehouse_code','参考号一':'reference_1','参考号二':'reference_2','备注':'remark','购买保险':'is_insurance','保价':'insured_value','投保币种':'insured_currency','派送方式':'delivery_type'
};
const originalParcelFields={'货箱编号':'number','货箱重量(KG)':'client_weight','货箱长度(CM)':'client_length','货箱宽度(CM)':'client_width','货箱高度(CM)':'client_height','产品英文品名':'name_en','产品中文品名':'name_zh','产品申报单价':'unit_value','产品申报数量':'qty','产品材质':'material','产品海关编码':'hscode','产品用途':'usage','产品品牌':'brand','产品型号':'model','产品销售链接':'sale_url','产品图片链接':'photo_url'};
const attrFields={'带电':'elec','带磁':'magnetic','液体':'liquid','粉末':'powder','危险品':'danger'};
const yes=value=>['是','yes','true','1','有'].includes(String(value).toLowerCase());
const no=value=>!value||['否','no','false','0','无','/'].includes(String(value).toLowerCase());
function resolveOption(value,field,title){
 if(!value||value==='/')return '';
 const opts=Array.isArray(field?.options)?field.options:Object.entries(field?.options||{}).map(([value,label])=>({value,label}));
 if(!opts.length)return value;
 const normalized=String(value).trim();const found=opts.find(o=>String(o.value)===normalized||String(o.label)===normalized);if(found)return String(found.value);
 throw Error(`${title}“${value}”无法对应已采集选项，请使用服务代码或准确选项名称`);
}
export function parseOriginalShipmentWorkbook(XLSX,workbook,config,{stores=[],addresses=[],defaults={}}={}) {
 const sheet=workbook.Sheets[workbook.SheetNames[0]];if(!sheet)throw Error('文件没有工作表');
 const ref=sheet['!ref'];if(ref&&XLSX.utils.decode_range(ref).e.r>2200)throw Error('文件超过允许行数');
 for(const [address,cell] of Object.entries(sheet))if(!address.startsWith('!')&&cell?.f)throw Error('模板不支持公式，请将公式转换为文本或数值');
 const data=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:''});const single=label(data[0]?.[0])==='客户订单号'&&data.slice(0,20).some(row=>label(row[0])==='货箱编号');
 const headerIndex=single?data.findIndex(row=>label(row[0])==='货箱编号'):0;
 const header=data[headerIndex]?.map(label)||[];if(!header.includes('货箱编号')||!header.includes('产品申报数量'))throw Error('无法识别原站单票或多票模板；简易货箱表请使用兼容导入');
 const common={},requiredTitles=[];if(single)for(const row of data.slice(0,headerIndex))for(const index of [0,4,8]){const title=label(row[index]);if(title){common[title]=String(row[index+1]??'').trim();if(/[*＊]/.test(String(row[index]||'')))requiredTitles.push(title);}}
 if(!single)for(const originalTitle of data[headerIndex])if(/[*＊]/.test(String(originalTitle)))requiredTitles.push(label(originalTitle));
 const content=data.slice(headerIndex+1).filter(row=>row.some(v=>String(v).trim()!==''));if(!content.length)throw Error('模板没有货箱数据');if(content.length>2000)throw Error('最多导入2000行');
 const grouped=new Map(),warnings=new Set();
 content.forEach((row,index)=>{const raw={...common};header.forEach((title,i)=>{if(title)raw[title]=String(row[i]??'').trim();});for(const title of requiredTitles)if(!raw[title])throw Error(`第${headerIndex+index+2}行：${title}不能为空，非必要信息按模板说明填写/`);const reference=raw['客户订单号'];if(!single&&!reference)throw Error(`第${headerIndex+index+2}行客户订单号为空，无法判断多票边界`);const group=single?'single':reference;
  if(!grouped.has(group))grouped.set(group,{raw,rows:[]});const entry=grouped.get(group);
  if(!single)for(const [title,value]of Object.entries(raw))if((originalFields[title]||attrFields[title])&&String(entry.raw[title]||'')!==String(value||''))throw Error(`客户订单号 ${reference} 的“${title}”不一致，不能合并同一票`);
  entry.rows.push(raw);
 });
 if(grouped.size>100)throw Error('一次最多100票运单');
 const inputs=[];
 for(const {raw,rows} of grouped.values()) {
  const service=resolveOption(raw['服务'],flattenFields(config.pages.shipment.form.form.columns).find(f=>f.name==='service'),'服务');
  const profile=config.shipmentProfiles?.[service];if(!profile)throw Error(`服务 ${service||'未填写'} 尚未采集动态规则，无法导入`);
  const defs=flattenFields(mergeFormColumns(config.pages.shipment.form.form.columns,profile.form.columns)).filter(f=>!f.hidden&&!['hidden','toTitle'].includes(f.type));const byName=new Map(defs.map(f=>[f.name,f]));
  const values={service,attrs:[],...(defaults.eori?{eori:String(defaults.eori).trim()}:{})};
  for(const [title,value]of Object.entries(raw)){
   if(!value||value==='/')continue;
   if(attrFields[title]){if(!yes(value)&&!no(value))throw Error(`${title}只能填写是/否`);if(yes(value)){const code=attrFields[title],field=byName.get('attrs');if(!field)throw Error(`${title}当前服务没有对应属性`);const opts=Array.isArray(field.options)?field.options.map(o=>String(o.value)):Object.keys(field.options||{});if(!opts.includes(code))throw Error(`${title}尚未确认属性编码，不能推断`);values.attrs.push(code);}continue;}
   const name=originalFields[title];if(name&&byName.has(name)){
    if(name==='store_id'){const found=stores.find(s=>s.id===value||s.name===value);if(!found)throw Error(`店铺“${value}”未匹配本地店铺，请先建立或清空模板店铺`);values[name]=found.id;}
    else if(name==='to_warehouse_code'){const found=addresses.find(a=>a.type==='to'&&(a.id===value||a.code===value));if(!found)throw Error(`地址库编码“${value}”未匹配本地收件地址`);values[name]=found.id;}
    else if(name==='is_insurance') {if(!yes(value)&&!no(value))throw Error('购买保险只能填是/否');values[name]=yes(value)?'1':'0';}
    else values[name]=resolveOption(value,byName.get(name),title);
   }else if(!originalParcelFields[title]&&!['箱数','货箱编号'].includes(title)&&!title.startsWith('使用说明'))warnings.add(`${title}尚无本地已验证字段，未写入`);
  }
  for(const field of defs){const value=values[field.name]??field.value??'';if(field.required&&!value)throw Error(`${raw['客户订单号']||'单票'}：${field.label}不能为空${field.name==='eori'?'；原多票模板缺少此列，请在补充EORI栏填写或自行增加EORI列':''}`);if(values[field.name]===undefined && field.type==='checkboxGroup')values[field.name]=Array.isArray(field.value)?field.value:[];}
  const parcelColumns=profile.excelTableData.tableColumns;
  const normalizedHeaders=parcelColumns.map(c=>label(c.label));
  const parsedRows=rows.map(row=>parcelColumns.map(c=>{const source=Object.entries(originalParcelFields).find(([,target])=>target===c.name)?.[0];if(c.name==='is_battery')return yes(row['带电'])?'是':'否';if(c.name==='is_magnetic')return yes(row['带磁'])?'是':'否';return source?row[source]||'':'';}));
  const pseudo={SheetNames:['import'],Sheets:{import:{}}};const parser={utils:{sheet_to_json:()=>[normalizedHeaders,...parsedRows]}};
  const parcels=parseParcelSheet(parser,pseudo,parcelColumns),parcelCount=new Set(parcels.map(p=>p.number)).size;
  if(single&&raw['箱数']&&raw['箱数']!=='/'&&Number(raw['箱数'])!==parcelCount)throw Error('模板箱数与不同货箱编号数量不一致');
  inputs.push({values,parcels,parcel_count:parcelCount,fba_shipment:false});
 }
 return {type:single?'single':'multiple',inputs,warnings:[...warnings]};
}
export function openShipmentImport(ctx,config,{onComplete}={}) {
 if(!window.XLSX){ctx.notify('Excel读取组件未加载');return;}
 let parsed=null;
 ctx.openDialog('Excel导入',`<label class="form-row"><span><b style="color:#d33">* </b>导入文件</span><input type="file" id="originalImportFile" accept=".xls,.xlsx" required></label><p><a download href="/assets/b2b-shipment-single-template.xls">B2B单票导入模板下载</a>　<a download href="/assets/b2b-shipment-multiple-template.xls">B2B多票导入模板下载</a></p><p>本地解析、预览后一次提交；同箱多商品重复箱号，最多 100 票 / 2000 行 / 5 MB。模板不支持公式，前导零必须在原文件按文本保存。</p><label class="form-row"><span>补充EORI</span><input id="originalImportEori" placeholder="仅补充模板未填写的EORI"></label><p>原多票模板没有EORI列；如服务要求，请在此补充（统一用于本次缺失该字段的票），或在表内新增EORI列。</p><div id="originalImportPreview"></div><div class="form-footer"><button class="btn btn-green" type="submit" id="originalImportSave" disabled>保存本地运单</button><button class="btn btn-grey" type="button" id="compatibleImport">兼容货箱表导入</button><button class="btn btn-grey" type="button" id="closeOriginalImport">关闭</button></div>`,async()=>{
  if(!parsed)throw Error('请先读取并检查文件');if(parsed.warnings.length&&!document.getElementById('importOmissionConfirmed')?.checked)throw Error('请确认未映射字段不会写入本地运单');
  const result=await ctx.api('/api/replica/shipment/batch',{inputs:parsed.inputs});ctx.closeDialog();ctx.notify('已全部保存到本地');await onComplete?.(result);
 });
 document.getElementById('closeOriginalImport').onclick=()=>ctx.closeDialog();document.getElementById('compatibleImport').onclick=()=>openParcelImport(ctx,config,{onComplete});
 const readFile=async event=>{
  parsed=null;document.getElementById('originalImportSave').disabled=true;const file=event.target.files[0];if(!file)return;
  try{
   if(file.size>5*1024*1024)throw Error('文件不能超过5 MB');if(!/\.xlsx?$/i.test(file.name))throw Error('仅支持XLS或XLSX');
   const [buffer,stores,addresses]=await Promise.all([file.arrayBuffer(),ctx.api('/api/replica/store'),ctx.api('/api/replica/address')]);
   const workbook=window.XLSX.read(buffer,{type:'array',raw:true,cellDates:false});parsed=parseOriginalShipmentWorkbook(window.XLSX,workbook,config,{stores,addresses,defaults:{eori:document.getElementById('originalImportEori').value}});
   document.getElementById('originalImportPreview').innerHTML=`<p>${parsed.type==='single'?'单票':'多票'}模板：${parsed.inputs.length}票，${parsed.inputs.reduce((n,input)=>n+input.parcels.length,0)}行。</p><div class="table-wrap"><table class="data-table"><thead><tr><th>客户单号</th><th>服务</th><th>收件人</th><th>国家</th><th>箱数</th><th>申报行</th></tr></thead><tbody>${parsed.inputs.map(input=>`<tr><td>${esc(input.values.client_reference)}</td><td>${esc(input.values.service)}</td><td>${esc(input.values.name)}</td><td>${esc(input.values.country)}</td><td>${input.parcel_count}</td><td>${input.parcels.length}</td></tr>`).join('')}</tbody></table></div>${parsed.warnings.length?`<div class="notice">${parsed.warnings.map(esc).join('<br>')}<p><label><input type="checkbox" id="importOmissionConfirmed">我已核对，确认以上未映射字段不会写入本地运单</label></p></div>`:''}`;
   document.getElementById('originalImportSave').disabled=false;
  }catch(error){parsed=null;document.getElementById('originalImportPreview').innerHTML=`<pre style="white-space:pre-wrap;color:#c0392b">${esc(error.message)}</pre>`;ctx.notify(error.message);}
 };
 document.getElementById('originalImportFile').onchange=readFile;
 document.getElementById('originalImportEori').onchange=()=>readFile({target:document.getElementById('originalImportFile')});
}
