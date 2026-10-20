// Renders the recovered NextSLS page schemas against local records only.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const unwrap = value => Array.isArray(value) ? unwrap(value[0]) : value?.data && !value.components && !value.form ? unwrap(value.data) : value || {};
const options = field => Array.isArray(field.options) ? field.options.map(o => typeof o === 'object' ? o : {value:o,label:o}) : Object.entries(field.options || {}).map(([value,label]) => ({value,label}));
export function flattenFields(columns = []) { return columns.flatMap(f => f.com === 'column' || f.com === 'group' || f.type === 'group' ? flattenFields(f.data || f.columns || []) : f.name ? [f] : flattenFields(f.columns || (Array.isArray(f.data) ? f.data : []))); }
function buttons(section) { return (section?.columns || []).flatMap(c => c.data?.items || c.items || []); }
function dateValue(value, showTime) { if (!value) return ''; const d = new Date(typeof value === 'number' ? value * 1000 : value); if (Number.isNaN(d.getTime())) return ''; return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,showTime ? 16 : 10); }
function fieldHtml(f, values = {}, search = false) {
  if (f.type === 'toTitle') return `<h3 class="subheading">${escape(f.label)}</h3>`;
  if (f.hidden || f.type === 'hidden') return '';
  const v = values[f.name] ?? (search ? '' : f.value ?? '');
  const attrs = `name="${escape(f.name)}" ${f.required && !search ? 'required' : ''} ${f.disabled ? 'disabled' : ''} placeholder="${escape(f.placeholder || '')}"`;
  let input;
  if (['checkboxGroup','radioGroup'].includes(f.type)) input = `<span class="choice-group">${options(f).map(o=>`<label><input type="${f.type==='radioGroup'?'radio':'checkbox'}" name="${escape(f.name)}" value="${escape(o.value)}" ${(Array.isArray(v)?v.map(String):[String(v)]).includes(String(o.value))?'checked':''} ${f.disabled?'disabled':''}>${escape(o.label)}</label>`).join('')}</span>`;
  else if (f.type === 'dateRange') input = `<input type="date" name="${escape(f.name)}__start" value="${escape(values[f.name+'__start'])}"><span>至</span><input type="date" name="${escape(f.name)}__end" value="${escape(values[f.name+'__end'])}">`;
  else if (f.type === 'select' || f.type === 'radio') input = `<select ${attrs}><option value="">请选择</option>${options(f).map(o => `<option value="${escape(o.value)}" ${String(o.value)===String(v)?'selected':''}>${escape(o.label)}</option>`).join('')}</select>${!search && !options(f).length ? '<small>暂无可选资料；需要本地关联数据或后续接口接入</small>' : ''}`;
  else if (f.type === 'textarea') input = `<textarea ${attrs} rows="3">${escape(v)}</textarea>`;
  else if (['switch','checkbox'].includes(f.type)) input = `<input type="checkbox" ${attrs} value="1" ${v && v !== '0' ? 'checked' : ''}>`;
  else if (f.type === 'uploadImage' || f.type === 'upload') input = `<input type="file" ${attrs} ${f.filesCount > 1 ? 'multiple' : ''} accept="${escape((f.fileTypes || ['image/*']).join(','))}"><small>本地附件，单文件上限 ${f.fileSize || 5} MB</small>${v ? `<small>已保存：${escape(Array.isArray(v)?v.map(a=>a.name || a).join('、'):v)}</small>` : ''}`;
  else if (f.type === 'date') input = `<input type="${f.showTime ? 'datetime-local' : 'date'}" ${attrs} value="${escape(dateValue(v,f.showTime))}">`;
  else input = `<input type="${f.type === 'number' ? 'number' : 'text'}" ${attrs} ${f.type==='number'?'step="any"':''} value="${escape(v)}">`;
  return `<label class="${search?'field':'form-row'}"><span>${f.required && !search ? '<b style="color:#e34b4b">* </b>':''}${escape(f.label || f.name)}</span>${input}</label>`;
}
export function renderFields(columns, values = {}) {
  return columns.map(c => {
    if (c.hidden || c.type === 'hidden') return '';
    if (c.type === 'group' || c.com === 'group') {
      const children = c.columns || (Array.isArray(c.data) ? c.data : []);
      return `<div class="form-row field-group"><span>${c.required ? '<b style="color:#e34b4b">* </b>' : ''}${escape(c.label || '')}</span><div class="group-inputs" style="display:flex;gap:6px;min-width:0">${children.map(child => fieldHtml(child, values).replace('class="form-row"','class="field" style="flex:1;min-width:0"')).join('')}</div></div>`;
    }
    if(c.com === 'column') return `<div class="form-column" style="flex:0 0 ${((c.span || 24)/24)*100}%;max-width:${((c.span || 24)/24)*100}%">${renderFields(c.data || c.columns || [],values)}</div>`;
    return fieldHtml(c,values);
  }).join('');
}
// Dynamic change_form payloads are patches; retain the base page's column layout.
export function mergeFormColumns(baseColumns, patchColumns = []) {
  const patches = new Map();
  const collect = nodes => nodes.forEach(node => {if(node.name)patches.set(node.name,node);if(Array.isArray(node.data))collect(node.data);if(node.columns)collect(node.columns);});
  collect(patchColumns);
  const merge = nodes => nodes.map(node => {
    const patch = node.name && patches.get(node.name);
    const next = {...structuredClone(node),...(patch ? structuredClone(patch) : {})};
    if(patch) next.hidden = patch.hidden ?? false;
    if(node.com === 'column') {next.span=node.span;if(Array.isArray(node.data))next.data=merge(node.data);else if(node.columns)next.columns=merge(node.columns);}
    else if(Array.isArray(next.data))next.data=merge(next.data);
    else if(next.columns)next.columns=merge(next.columns);
    return next;
  });
  return merge(baseColumns);
}
export function fillParcelNumbers(parcels, {fba=false, shipmentId='', digits=6} = {}) {
  const width = [3,6].includes(Number(digits)) ? Number(digits) : 6;
  return parcels.map((parcel,index) => ({...parcel,number:String(parcel.number || (fba && shipmentId ? `${String(shipmentId).toUpperCase()}U${String(index+1).padStart(width,'0')}` : index+1))}));
}

export async function readValues(form, columns, original = {}) {
  const defs = flattenFields(columns);
  const names = new Set(defs.filter(f=>!['hidden','toTitle'].includes(f.type)).map(f=>f.name));
  const values = Object.fromEntries(Object.entries(original).filter(([name])=>names.has(name)));
  for (const f of defs) {
    if (f.type==='toTitle' || f.hidden || f.type==='hidden' || f.disabled) continue;
    const el = form.elements.namedItem(f.name); if (!el) continue;
    if (['checkboxGroup','radioGroup'].includes(f.type)) {const selected=[...form.querySelectorAll('input')].filter(input=>input.name===f.name&&input.checked).map(input=>input.value);values[f.name]=f.type==='radioGroup'?(selected[0] || ''):selected;}
    else if (el.type === 'file') {
      const files = [...el.files];
      if (files.length > (f.filesCount || 10)) throw Error(`“${f.label}”最多上传 ${f.filesCount || 10} 个文件`);
      if (files.some(file => file.size > (f.fileSize || 5)*1024*1024)) throw Error(`“${f.label}”文件超过大小限制`);
      if (files.length) values[f.name] = await Promise.all(files.map(file => new Promise((resolve,reject) => {const reader=new FileReader();reader.onload=()=>resolve({name:file.name,type:file.type,size:file.size,data:reader.result});reader.onerror=reject;reader.readAsDataURL(file);}))); 
    } else if (['switch','checkbox'].includes(f.type)) values[f.name] = el.checked ? 1 : 0;
    else if (f.type==='number') values[f.name] = el.value === '' ? '' : Number(el.value);
    else if (f.type==='date') values[f.name] = el.value ? Math.floor(new Date(el.value).getTime()/1000) : '';
    else values[f.name] = el.value.trim();
  }
  return values;
}
function csvDownload(columns,records,title) {
  const safe = v => {const str = String(v ?? ''); return '"'+(/^[=+@\-\t\r]/.test(str)?"'":'')+str.replaceAll('"','""')+'"';};
  const csv = '\ufeff'+[columns.map(c=>safe(c.title)).join(','),...records.map(r=>columns.map(c=>safe(r.values[c.dataIndex] ?? (c.dataIndex==='created'?r.createdAt:''))).join(','))].join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=title+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function renderModule(key, container, ctx) {
  const config = await fetch('/replica-config.json').then(r=>{if(!r.ok)throw Error('页面配置加载失败');return r.json();});
  const pageConfig = config.pages?.[key];
  if (!pageConfig) {container.innerHTML='<div class="empty">尚未取得此页面的原站结构</div>';return;}
  const schema = unwrap(pageConfig.schema), formSchema=unwrap(pageConfig.form);
  const comps=schema.components || {}, grid=comps.gridView || {}, table=grid.table || {}, tabs=grid.tabs?.items || [];
  const title=comps.header?.columns?.[0]?.data?.title || key;
  const defs=flattenFields(formSchema.form?.columns || []), searchDefs=flattenFields(comps.search?.form?.columns || []);
  const cols=table.columns || [], extra=buttons(comps.extra), tools=buttons(grid.tableTools);
  let records=[], tab=grid.tabs?.activeTab || tabs[0]?.value || '', page=1, size=Number(table.pagination?.pageSize || 30), query={}, selected=new Set();
  const load=async()=>{const result=await ctx.api('/api/replica/'+key); records=(Array.isArray(result)?result:result.records || result.data || []).map(r=>({...r,values:r.values || {...r}}));};
  const inTab=(record,value)=> !value || String(key==='address'?record.values.type:record.status || record.values.status || grid.tabs?.activeTab)===String(value);
  const display=(record,col)=> {
    let v=record.values[col.dataIndex] ?? (col.dataIndex==='created'?record.createdAt:col.dataIndex==='status'?record.status:'');
    const def=defs.find(f=>f.name===col.dataIndex), opt=def && options(def).find(o=>String(o.value)===String(v));if(opt)v=opt.label;
    if(col.type==='datetime' && v) {const d=new Date(typeof v==='number'?v*1000:v);if(!Number.isNaN(d.getTime()))v=d.toLocaleString('zh-CN',{hour12:false});}
    if(Array.isArray(v))v=v.map(a=>a?.name || a).join('、');
    return typeof v==='object'?JSON.stringify(v):v;
  };
  const filtered=()=>records.filter(r=>inTab(r,tab)).filter(r=>Object.entries(query).every(([name,value])=>{
    if(!value)return true;
    if(name.endsWith('__start') || name.endsWith('__end')) {const field=name.replace(/__(start|end)$/,'');const actual=field==='daterange'?r.createdAt || r.created:r.values[field] ?? (field==='created'?r.createdAt || r.created:'');if(!actual)return false;const ts=new Date(typeof actual==='number'?actual*1000:actual).getTime();const bound=new Date(value+(name.endsWith('__end')?'T23:59:59':'T00:00:00')).getTime();return name.endsWith('__start')?ts>=bound:ts<=bound;}
    if(['kw','keywords'].includes(name))return String(value).split(/[,，]/).filter(Boolean).some(term=>JSON.stringify(r.values).toLowerCase().includes(term.trim().toLowerCase()));
    return String(r.values[name] ?? '').toLowerCase().includes(String(value).toLowerCase());
  }));
  async function edit(record) {
    if(!defs.length || (record && ['booking','cabin'].includes(key) && ['cancelled','cancel'].includes(record.status))) {ctx.openDialog(title+'详情',`<dl>${cols.map(c=>`<dt>${escape(c.title)}</dt><dd>${escape(display(record,c))}</dd>`).join('')}</dl>`);return;}
    let values={...record?.values};
    if(!record && key==='address')values.type=tab;
    if(!record) for(const f of defs) if(f.type==='date') values[f.name]=Math.floor(Date.now()/1000);
    // Booking addresses are local address-library records; no remote request is made.
    if(key==='booking') {
      try {const raw=await ctx.api('/api/replica/address');const list=(Array.isArray(raw)?raw:raw.records || raw.data || []).map(r=>({...r,values:r.values || {...r}}));const f=defs.find(f=>f.name==='address_id');if(f)f.options=list.filter(r=>r.values.type==='booking').map(r=>({value:r.id,label:[r.values.address_name,r.values.name,r.values.address_1].filter(Boolean).join(' / ')}));} catch {ctx.notify('本地地址库加载失败');}
    }
    const fcols=structuredClone(formSchema.form?.columns || []);
    const copyOptions=nodes=>nodes.forEach(n=>{if(n.name && defs.find(f=>f.name===n.name))n.options=defs.find(f=>f.name===n.name).options;if(Array.isArray(n.data))copyOptions(n.data);if(n.columns)copyOptions(n.columns);});copyOptions(fcols);
    const html=`<div class="drawer-fields" style="display:flex;flex-wrap:wrap">${renderFields(fcols,values)}</div><div class="form-footer"><button class="btn btn-green" type="submit">保存</button><button class="btn btn-grey" type="button" data-local-close>关闭</button></div>`;
    const submit=async (data,form)=>{
      form ||= document.getElementById('replicaForm');if(!form || !form.reportValidity())return;
      const button=form.querySelector('button[type="submit"]');button.disabled=true;
      try {const next=await readValues(form,defs,values);await ctx.api('/api/replica/'+key,{...(record?{id:record.id,version:record.version}:{}),values:next});ctx.closeDialog();await load();draw();ctx.notify('已保存到本地');}catch(error){ctx.notify(error.message);button.disabled=false;}
    };
    ctx.openDialog(record?'编辑'+title:formSchema.title || '创建',html,submit);
    document.querySelector('[data-local-close]')?.addEventListener('click',()=>ctx.closeDialog());
  }
  function draw() {
    const found=filtered();const totalPages=Math.max(1,Math.ceil(found.length/size));page=Math.min(page,totalPages);const rows=found.slice((page-1)*size,page*size);
    container.innerHTML=`<div class="module-page"><div class="page-heading"><h2>${escape(title)}</h2></div>${searchDefs.length?`<form class="search-area" data-search><div class="search-fields">${searchDefs.map(f=>fieldHtml(f,query,true)).join('')}</div><button class="btn btn-green" type="submit">搜索</button><button class="btn btn-grey" type="reset">重置</button></form>`:''}<div class="page-extra">${extra.map((b,i)=>`<button class="btn btn-grey" data-extra="${i}">${escape(b.label)}</button>`).join('')}</div>${tabs.length?`<div class="tabs">${tabs.map(t=>`<button type="button" class="${tab===t.value?'active':''}" data-tab="${escape(t.value)}">${escape(t.label.replace(/\(\d+\)|（\d+）/g,''))}(${records.filter(r=>inTab(r,t.value)).length})</button>`).join('')}</div>`:''}<div class="table-tools">${tools.map((b,i)=>`<button class="btn ${/删除|取消/.test(b.label)?'btn-red':'btn-grey'}" data-tool="${i}">${escape(b.label)}</button>`).join('')}<span>已选择 ${selected.size} 项</span></div><div style="overflow:auto"><table class="data-table"><thead><tr>${table.noSelection?'':'<th><input type="checkbox" data-select-all aria-label="选择本页"></th>'}${cols.map(c=>`<th>${escape(c.title)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(r=>`<tr>${table.noSelection?'':`<td><input type="checkbox" data-select="${escape(r.id)}" ${selected.has(r.id)?'checked':''} aria-label="选择记录"></td>`}${cols.map((c,i)=>`<td>${c.type==='click'||i===0?`<button type="button" class="table-link" data-edit="${escape(r.id)}">${escape(display(r,c)) || '查看'}</button>`:escape(display(r,c))}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${cols.length+(table.noSelection?0:1)}"><div class="empty">暂无数据</div></td></tr>`}</tbody></table></div><div class="pagination"><span>共 ${found.length} 条</span><button class="btn btn-grey" data-prev ${page===1?'disabled':''}>上一页</button><span>${page} / ${totalPages}</span><button class="btn btn-grey" data-next ${page===totalPages?'disabled':''}>下一页</button><select data-size>${(table.pagination?.pageSizeOptions || ['10','30','50','100']).map(n=>`<option ${Number(n)===size?'selected':''}>${n}</option>`).join('')}</select><span>条/页</span></div></div>`;
    container.querySelector('[data-search]')?.addEventListener('submit',e=>{e.preventDefault();query=Object.fromEntries(new FormData(e.currentTarget));page=1;selected.clear();draw();});
    container.querySelector('[data-search]')?.addEventListener('reset',e=>{e.preventDefault();query={};page=1;selected.clear();draw();});
    container.querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>{tab=el.dataset.tab;page=1;selected.clear();draw();});
    container.querySelectorAll('[data-extra]').forEach(el=>el.onclick=()=>{const b=extra[el.dataset.extra];if(/\/form(?:\?|$)/.test(b.url || '') && defs.length)edit().catch(e=>ctx.notify(e.message));else if(/导出/.test(b.label))csvDownload(cols,selected.size?found.filter(r=>selected.has(r.id)):found,title);else ctx.notify(`${b.label}尚未完成，未执行外部操作`);});
    container.querySelectorAll('[data-edit]').forEach(el=>el.onclick=()=>edit(records.find(r=>r.id===el.dataset.edit)).catch(e=>ctx.notify(e.message)));
    container.querySelectorAll('[data-select]').forEach(el=>el.onchange=()=>{el.checked?selected.add(el.dataset.select):selected.delete(el.dataset.select);draw();});
    const all=container.querySelector('[data-select-all]');if(all){all.checked=!!rows.length&&rows.every(r=>selected.has(r.id));all.onchange=()=>{rows.forEach(r=>all.checked?selected.add(r.id):selected.delete(r.id));draw();};}
    container.querySelectorAll('[data-tool]').forEach(el=>el.onclick=async()=>{
      const b=tools[el.dataset.tool];if(b.shouldCheck&&!selected.size){ctx.notify('请先选择记录');return;}
      if(/导出/.test(b.label)){csvDownload(cols,selected.size?found.filter(r=>selected.has(r.id)):found,title);return;}
      if(b.label==='删除') {
        const chosen=records.filter(r=>selected.has(r.id));ctx.openDialog('删除确认',`<p>确定删除所选 ${chosen.length} 条本地记录？</p><button type="button" class="btn btn-red" id="replica-confirm-delete">确定删除</button>`);
        document.getElementById('replica-confirm-delete').onclick=async function(){this.disabled=true;try{await ctx.api('/api/replica/'+key+'/archive',{ids:chosen.map(r=>r.id),versions:Object.fromEntries(chosen.map(r=>[r.id,r.version]))});ctx.closeDialog();selected.clear();await load();draw();ctx.notify('已删除本地记录');}catch(e){ctx.notify(e.message);this.disabled=false;}};
      } else if(b.label==='取消' && ['booking','cabin'].includes(key)) {
        const chosen=records.filter(r=>selected.has(r.id));if(!chosen.length){ctx.notify('请先选择记录');return;}
        ctx.openDialog('取消确认',`<p>确定取消所选 ${chosen.length} 条本地记录？</p><label class="form-row"><span>说明</span><textarea name="note" maxlength="2000"></textarea></label><div class="form-footer"><button class="btn btn-red" type="submit">确定</button></div>`,async fd=>{await ctx.api('/api/replica/'+key+'/cancel',{ids:chosen.map(r=>r.id),versions:Object.fromEntries(chosen.map(r=>[r.id,r.version])),note:String(fd.get('note')||'')});ctx.closeDialog();selected.clear();await load();draw();ctx.notify('已取消本地记录');});
      } else ctx.notify(`${b.label}尚未完成，未执行外部操作`);
    });
    container.querySelector('[data-prev]').onclick=()=>{page--;draw();};container.querySelector('[data-next]').onclick=()=>{page++;draw();};container.querySelector('[data-size]').onchange=e=>{size=Number(e.target.value);page=1;draw();};
  }
  await load();draw();
}
