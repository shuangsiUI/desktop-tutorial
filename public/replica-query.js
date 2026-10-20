// Local queries use recorded facts; manual notes do not imply receipt or delivery.
export function shipmentDate(order,kind){
  if(kind==='created')return String(order.created||'').slice(0,10);
  const state=kind==='delivered'?'delivered':kind==='picking'?'picked':null;
  if(!state)return '';
  const direct=order[kind+'_at'];
  if(direct)return String(direct).slice(0,10);
  return String((order.tracking||[]).find(event=>event.status===state)?.at||'').slice(0,10);
}
export function shipmentMatches(order,filter={}){
  return Object.entries(filter).every(([key,value])=>{
    if(!value)return true;
    if(key==='keyword'){const terms=String(value).split(/[,，\n]/).map(t=>t.trim()).filter(Boolean);return !terms.length||terms.some(term=>[order.shipment_number,order.client_reference,order.reference_1,order.reference_2,order.ba_shipment_id].some(v=>String(v||'').includes(term)));}
    if(key.endsWith('_from')||key.endsWith('_to')){const date=shipmentDate(order,key.replace(/_(from|to)$/,''));return !!date&&(key.endsWith('_from')?date>=value:date<=value);}
    if(key==='name')return order.name===value;
    if(['service','country','store_id','depot_id'].includes(key))return String(order[key]||'')===String(value);
    return String(value).split(/[,，\n]/).map(v=>v.trim()).filter(Boolean).some(term=>String(order[key]||'').includes(term));
  });
}
export function shipmentStatistics(orders){
  let boxes=0,weight=0,known=true;
  for(const order of orders){const groups=new Map();for(const [index,row]of(order.parcels||[]).entries()){const number=String(row.number||index+1);if(!groups.has(number))groups.set(number,[]);groups.get(number).push(row);}
    boxes+=Number(order.parcel_count??groups.size);
    for(const rows of groups.values()){const values=rows.map(r=>r.client_weight).filter(v=>v!==''&&v!==undefined&&v!==null).map(Number);if(!values.length||values.some(v=>!Number.isFinite(v)||v<0)||new Set(values).size>1)known=false;else weight+=values[0];}
  }
  return {shipments:orders.length,boxes,clientWeight:known?weight:null};
}
