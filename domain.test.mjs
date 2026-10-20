import {test} from 'node:test';import assert from 'node:assert/strict';import {quote,transition} from './domain.mjs';
const c={divisor:6000,minimum:10,step:0.5,rateCents:1234,fixedCents:100};const b={sku:'SKU-1',qty:10,weight:12.2,length:50,width:40,height:40};
test('体积重优先并向上进位，固定费用只计一次',()=>{const q=quote(c,[b]);assert.equal(q.billable,13.5);assert.equal(q.estimatedCents,16759);assert.equal(q.units,10)});
test('实重与最低计费重',()=>{assert.equal(quote(c,[{...b,weight:20.1}]).billable,20.5);assert.equal(quote(c,[{...b,weight:1,length:1,width:1,height:1}]).billable,10)});
test('非法装箱整体拒绝',()=>{for(const boxes of [[],[{...b,qty:1.2}],[{...b,weight:-1}],[{...b,sku:''}]])assert.throws(()=>quote(c,boxes))});
test('运单必填及状态流转约束',()=>{assert.throws(()=>transition({status:'draft'},'booked',''));assert.throws(()=>transition({status:'draft'},'delivered','X'));assert.equal(transition({status:'exception'},'transit','X'),'transit');assert.throws(()=>transition({status:'delivered'},'transit','X'))});
