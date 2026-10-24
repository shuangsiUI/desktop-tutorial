import {test} from 'node:test';import assert from 'node:assert/strict';import {quote,transition} from './domain.mjs';
import {settlementDueDate} from './backend/modules/commercial/arithmetic.mjs';
const c={divisor:6000,minimum:10,step:0.5,rateCents:1234,fixedCents:100};const b={sku:'SKU-1',qty:10,weight:12.2,length:50,width:40,height:40};
test('体积重优先并向上进位，固定费用只计一次',()=>{const q=quote(c,[b]);assert.equal(q.billable,13.5);assert.equal(q.estimatedCents,16759);assert.equal(q.units,10)});
test('实重与最低计费重',()=>{assert.equal(quote(c,[{...b,weight:20.1}]).billable,20.5);assert.equal(quote(c,[{...b,weight:1,length:1,width:1,height:1}]).billable,10)});
test('非法装箱整体拒绝',()=>{for(const boxes of [[],[{...b,qty:1.2}],[{...b,weight:-1}],[{...b,sku:''}]])assert.throws(()=>quote(c,boxes))});
test('运单必填及状态流转约束',()=>{assert.throws(()=>transition({status:'draft'},'booked',''));assert.throws(()=>transition({status:'draft'},'delivered','X'));assert.equal(transition({status:'exception'},'transit','X'),'transit');assert.throws(()=>transition({status:'delivered'},'transit','X'))});
test('小数计费进位使用精确十进制，不多收一个重量阶梯',()=>{const channel={...c,minimum:0,step:0.01,rateCents:100,fixedCents:0},box={...b,length:1,width:1,height:1,weight:0.14};assert.equal(quote(channel,[box]).billable,0.14);assert.equal(quote(channel,[box]).estimatedCents,14);assert.equal(quote(channel,[{...box,weight:0.1},{...box,weight:0.2}]).billable,0.3)});
test('月结日期在月底夹紧，周结可跨年，闰年正确',()=>{assert.equal(settlementDueDate('2026-01-31','monthly'),'2026-02-28');assert.equal(settlementDueDate('2028-01-31','monthly'),'2028-02-29');assert.equal(settlementDueDate('2026-12-31','weekly'),'2027-01-07')});
